// mcp.ts — the Model Context Protocol endpoint at POST /mcp: stateless JSON-RPC 2.0 speaking
// both protocol eras (the 2026 server/discover handshake and the classic initialize flow),
// with the six canonical forge tools delegating to the same store the REST API serves.

import {
  VIEWER,
  branchTip,
  createIssueRec,
  createPullRec,
  createRepoRec,
  findRepo,
  mergePullRec,
  type RepoRec,
} from './forge.ts';
import { errorBody, readBody, sendBody, type Ctx } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const FALLBACK_VERSION = '2025-11-25';
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
}

function tool(name: string, description: string, properties: Json, required: string[]): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

const STR = { type: 'string' } as const;

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by issue state.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
    body: { type: 'string', description: 'The pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

// ---------------------------------------------------------------------------
// Tool execution. Results mirror the REST shapes, as both text content (the JSON) and
// structuredContent; argument problems come back as isError results, never as throws.

interface ToolOutcome {
  structured: unknown;
  isError: boolean;
}

function ok(structured: unknown): ToolOutcome {
  return { structured, isError: false };
}

function err(message: string): ToolOutcome {
  return { structured: { message }, isError: true };
}

function requiredString(args: Json, field: string): string | null {
  const value = args[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

function runTool(ctx: Ctx, name: string, args: Json): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      if (repoName === null) return err('name is required');
      if (findRepo(VIEWER.login, repoName) !== undefined) return err('repository already exists');
      const repo = createRepoRec(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        isPrivate: args.private === true,
      });
      return ok(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      if (owner === null || repoName === null) return err('owner and repo are required');
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return err('repository not found');
      return ok(repoJson(ctx, repo));
    }
    case 'create_issue': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const title = requiredString(args, 'title');
      if (owner === null || repoName === null || title === null) return err('owner, repo and title are required');
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return err('repository not found');
      const issue = createIssueRec(repo, { title, body: typeof args.body === 'string' ? args.body : '', labels: [] });
      return ok(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      if (owner === null || repoName === null) return err('owner and repo are required');
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return err('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return ok(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return err('owner, repo, title, head and base are required');
      }
      const repo: RepoRec | undefined = findRepo(owner, repoName);
      if (repo === undefined) return err('repository not found');
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return err('head or base branch not found');
      const created = createPullRec(repo, { title, body: typeof args.body === 'string' ? args.body : '', head, base });
      if ('error' in created) return err(created.error);
      return ok(pullJson(ctx, repo, created));
    }
    case 'merge_pull_request': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const pullNumber = args.pull_number;
      if (owner === null || repoName === null || typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
        return err('owner, repo and pull_number are required');
      }
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return err('repository not found');
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return err('pull request not found');
      const result = mergePullRec(repo, pull, 'merge');
      if (!result.ok) return err('pull request is not mergeable');
      return ok({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing.

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handshakeResult(requestedVersion: unknown): Json {
  const version = typeof requestedVersion === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(requestedVersion)
    ? requestedVersion
    : FALLBACK_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
  };
}

function dispatch(ctx: Ctx, message: Json): Json | null {
  const method = message.method;
  const id = message.id;
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    return isNotification ? null : rpcError(id ?? null, -32600, 'Invalid Request: method must be a string');
  }
  const params = (message.params ?? {}) as Json;
  if (method === 'initialize') {
    return isNotification ? null : rpcResult(id, handshakeResult((params.protocolVersion as string | undefined) ?? undefined));
  }
  if (method === 'server/discover') {
    return isNotification ? null : rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_INFO.name, version: SERVER_INFO.version } },
    });
  }
  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;
  switch (method) {
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !TOOLS.some((candidate) => candidate.name === name)) {
        return rpcError(id, -32602, `unknown tool: ${typeof name === 'string' ? name : '(missing)'}`);
      }
      const args = (params.arguments ?? {}) as Json;
      const outcome = runTool(ctx, name, args !== null && typeof args === 'object' ? args : {});
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.structured) }],
        structuredContent: outcome.structured,
        isError: outcome.isError,
      });
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler for POST /mcp: a single JSON-RPC message or a batch array.

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (!ctx.authed) {
    sendBody(res, 401, Buffer.from(JSON.stringify(errorBody('Bad credentials')), 'utf8'), 'application/json');
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    sendBody(res, 400, Buffer.from(JSON.stringify(rpcError(null, -32700, 'Parse error')), 'utf8'), 'application/json');
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Json[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const response = dispatch(ctx, entry as Json);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'x-github-request-id': `req-${ctx.requestSeq}` });
      res.end();
      return;
    }
    sendBody(res, 200, Buffer.from(JSON.stringify(responses), 'utf8'), 'application/json');
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendBody(res, 400, Buffer.from(JSON.stringify(rpcError(null, -32600, 'Invalid Request')), 'utf8'), 'application/json');
    return;
  }
  const response = dispatch(ctx, parsed as Json);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': `req-${ctx.requestSeq}` });
    res.end();
    return;
  }
  sendBody(res, 200, Buffer.from(JSON.stringify(response), 'utf8'), 'application/json');
}
