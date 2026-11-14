// graphql.ts — the GraphQL v4 API at /api/graphql: a small lexer, parser and executor for the
// documents gh and github-mcp-server send (viewer, repository reads, issue/pull connections
// with cursor pagination, the create/close/merge mutations, Relay node(id:) and the __type
// introspection probes), plus operation batching. No library: the surface is fixed and known.

import {
  VIEWER,
  addCommentRec,
  branchTip,
  clock,
  createIssueRec,
  createPullRec,
  createRepoRec,
  findRepo,
  headRefName,
  isoOf,
  listAllRepos,
  mergePullRec,
  nodeId,
  parseNodeId,
  pullConflicts,
  pullFiles,
  repoByNumericId,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './forge.ts';
import { readBody, sendJson, type Ctx } from './http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Lexer.

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: operations, fragments, values (variables, enums, lists, input objects), directives
// (parsed; @skip/@include are honoured at execution).

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface DirectiveNode {
  name: string;
  args: Map<string, ValueNode>;
}

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.parseVariableDefinitions(varDefaults);
        }
        this.parseDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          varDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${JSON.stringify(token.value)}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue());
      this.parseDirectives();
    }
  }

  private parseTypeRef(): void {
    if (this.skipPunct('[')) {
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      const name = this.expectName();
      const args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      const directives = this.parseDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', name, alias, args, directives, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'punct': {
        if (token.value === '$') return { kind: 'var', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected "${token.value}" in a value`);
      }
      case 'name': {
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'string', value: token.value }; // an enum literal
      }
      default:
        throw new Error('unexpected token in a value');
    }
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** A ValueNode as plain JSON, with variables substituted (undefined when a variable is absent). */
export function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema table (introspection surface) and tagged result values.

export class GqlError extends Error {}

type GVal = { __type: string; [key: string]: unknown };

const SCHEMA: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'isViewer', 'viewerIsFollowing'] },
  Organization: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
      'url', 'sshUrl', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranch', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'stargazerCount', 'forkCount',
      'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'ref', 'refs',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target', 'repository'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'author', 'url'] },
  GitActor: { kind: 'OBJECT', fields: ['name', 'email', 'date', 'user'] },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'stateReason', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt',
      'closedAt', 'locked', 'author', 'editor', 'repository', 'labels', 'comments', 'assignees', 'participants', 'milestone',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'closedAt', 'createdAt', 'updatedAt',
      'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'mergeCommit', 'mergedBy', 'isDraft', 'author',
      'repository', 'files', 'additions', 'deletions', 'changedFiles', 'url', 'labels', 'comments',
    ],
  },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'viewerDidAuthor'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'issueCount', 'repositoryCount', 'userCount', 'pageInfo'] },
  RateLimit: { kind: 'OBJECT', fields: ['limit', 'cost', 'remaining', 'used', 'resetAt', 'nodeCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['clientMutationId', 'issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['clientMutationId', 'issue'] },
  ReopenIssuePayload: { kind: 'OBJECT', fields: ['clientMutationId', 'issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'commentEdge', 'subject'] },
  CreateRepositoryPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'repository'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType', 'specifiedByURL'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'] },
  __Directive: { kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestReviewState: { kind: 'ENUM', enumValues: ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'REBASE', 'SQUASH'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  FileStatus: { kind: 'ENUM', enumValues: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED'] },
};

const NODE_IMPLEMENTORS = new Set(['User', 'Repository', 'Issue', 'PullRequest', 'IssueComment', 'Label']);

function typeVal(name: string): GVal | null {
  const descriptor = SCHEMA[name];
  if (descriptor === undefined) return null;
  return {
    __type: '__Type',
    name,
    kind: descriptor.kind,
    fieldNames: descriptor.fields ?? [],
    enumNames: descriptor.enumValues ?? [],
  };
}

// ---------------------------------------------------------------------------
// Value constructors.

function userVal(): GVal {
  return { __type: 'User' };
}

export function repoVal(repo: RepoRec): GVal {
  return { __type: 'Repository', repo };
}

function issueVal(repo: RepoRec, issue: IssueRec): GVal {
  return { __type: 'Issue', repo, issue };
}

function pullVal(repo: RepoRec, pull: PullRec): GVal {
  return { __type: 'PullRequest', repo, pull };
}

function commentVal(repo: RepoRec, comment: IssueRec['comments'][number]): GVal {
  return { __type: 'IssueComment', repo, comment };
}

function labelVal(repo: RepoRec, label: LabelRec): GVal {
  return { __type: 'Label', repo, label };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const num = Number(text.slice(text.lastIndexOf(':') + 1));
  return Number.isInteger(num) && num >= 0 ? num : -1;
}

function connectionVal(type: string, all: GVal[], args: Record<string, unknown>): GVal {
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : 30;
  let start = 0;
  if (typeof args.after === 'string') {
    const decoded = decodeCursor(args.after);
    if (decoded >= 0) start = decoded + 1;
  }
  const page = all.slice(start, start + first);
  const edgeType = type.replace(/Connection$/, 'Edge');
  const edges = page.map((node, offset) => ({ __type: edgeType, node, cursor: encodeCursor(start + offset) }) as GVal);
  return {
    __type: type,
    nodes: page,
    edges,
    totalCount: all.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + page.length < all.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as GVal).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as GVal).cursor : null,
    },
  };
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): GVal {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const labelFilter = args.labels;
  if (Array.isArray(labelFilter)) {
    const wanted = labelFilter.map((name) => String(name).toLowerCase());
    list = list.filter((issue) => wanted.every((name) => issue.labels.some((label) => label.toLowerCase() === name)));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 1 : orderBy.direction === 'DESC' ? -1 : 1;
  const keyOf = (issue: IssueRec): number => (orderBy.field === 'UPDATED_AT' ? issue.updatedSec : issue.seq);
  list.sort((a, b) => (keyOf(a) - keyOf(b)) * direction || (a.seq - b.seq) * direction);
  return connectionVal('IssueConnection', list.map((issue) => issueVal(repo, issue)), args);
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): GVal {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((pull) => {
      if (pull.merged) return wanted.has('MERGED');
      return wanted.has(pull.state === 'open' ? 'OPEN' : 'CLOSED');
    });
  }
  list.sort((a, b) => a.seq - b.seq);
  return connectionVal('PullRequestConnection', list.map((pull) => pullVal(repo, pull)), args);
}

function findIssueByGid(gid: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of allRepos()) for (const issue of repo.issues.values()) if (issue.gid === gid) return { repo, issue };
  return null;
}

function findPullByGid(gid: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of allRepos()) for (const pull of repo.pulls.values()) if (pull.gid === gid) return { repo, pull };
  return null;
}

function findCommentByGid(gid: number): { repo: RepoRec; comment: IssueRec['comments'][number] } | null {
  for (const repo of allRepos()) {
    for (const target of [...repo.issues.values(), ...repo.pulls.values()]) {
      for (const comment of target.comments) if (comment.gid === gid) return { repo, comment };
    }
  }
  return null;
}

function allRepos(): RepoRec[] {
  return listAllRepos();
}

function nodeLookup(id: string): GVal | null {
  const parsed = parseNodeId(id);
  if (parsed === null) return null;
  switch (parsed.kind) {
    case 'User':
      return parsed.num === VIEWER.id ? userVal() : null;
    case 'Repository': {
      const repo = repoByNumericId(parsed.num);
      return repo === undefined ? null : repoVal(repo);
    }
    case 'Issue': {
      const found = findIssueByGid(parsed.num);
      return found === null ? null : issueVal(found.repo, found.issue);
    }
    case 'PullRequest': {
      const found = findPullByGid(parsed.num);
      return found === null ? null : pullVal(found.repo, found.pull);
    }
    case 'IssueComment': {
      const found = findCommentByGid(parsed.num);
      return found === null ? null : commentVal(found.repo, found.comment);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Field resolution. Domain values switch explicitly; connection / payload / introspection
// values carry their fields as properties.

const CARRIER_TYPES = new Set([
  'PageInfo', 'IssueConnection', 'IssueEdge', 'PullRequestConnection', 'PullRequestEdge',
  'PullRequestChangedFileConnection', 'IssueCommentConnection', 'IssueCommentEdge', 'LabelConnection',
  'SearchResultItemConnection', 'RateLimit', 'PullRequestChangedFile', 'GitActor',
  'CreateIssuePayload', 'CloseIssuePayload', 'ReopenIssuePayload', 'CreatePullRequestPayload',
  'MergePullRequestPayload', 'AddCommentPayload', 'CreateRepositoryPayload', '__Type', '__Field', '__EnumValue',
]);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function repoFromNodeId(id: unknown): RepoRec {
  const parsed = parseNodeId(str(id));
  const repo = parsed !== null && parsed.kind === 'Repository' ? repoByNumericId(parsed.num) : undefined;
  if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the given id.');
  return repo;
}

function issueFromNodeId(id: unknown): { repo: RepoRec; issue: IssueRec } {
  const parsed = parseNodeId(str(id));
  const found = parsed !== null && parsed.kind === 'Issue' ? findIssueByGid(parsed.num) : null;
  if (found === null) throw new GqlError('Could not resolve to an Issue with the given id.');
  return found;
}

function pullFromNodeId(id: unknown): { repo: RepoRec; pull: PullRec } {
  const parsed = parseNodeId(str(id));
  const found = parsed !== null && parsed.kind === 'PullRequest' ? findPullByGid(parsed.num) : null;
  if (found === null) throw new GqlError('Could not resolve to a PullRequest with the given id.');
  return found;
}

function resolveQuery(field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'viewer':
      return userVal();
    case 'repository': {
      const repo = findRepo(str(args.owner), str(args.name));
      return repo === undefined ? null : repoVal(repo);
    }
    case 'node':
      return nodeLookup(str(args.id));
    case 'nodes':
      return Array.isArray(args.ids) ? args.ids.map((id) => nodeLookup(str(id))) : [];
    case 'user':
      return str(args.login) === VIEWER.login ? userVal() : null;
    case 'organization':
      return null;
    case 'search':
      return {
        __type: 'SearchResultItemConnection',
        nodes: [],
        edges: [],
        issueCount: 0,
        repositoryCount: 0,
        userCount: 0,
        pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    case 'rateLimit':
      return { __type: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: isoOf(clock.now()), nodeCount: 0 };
    default:
      return NOT_HANDLED;
  }
}

const NOT_HANDLED = Symbol('notHandled');

function resolveMutation(field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field) {
    case 'createIssue': {
      const repo = repoFromNodeId(input.repositoryId);
      const issue = createIssueRec(repo, { title: str(input.title), body: str(input.body), labels: [] });
      return { __type: 'CreateIssuePayload', clientMutationId, issue: issueVal(repo, issue) };
    }
    case 'closeIssue': {
      const { repo, issue } = issueFromNodeId(input.issueId);
      if (issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSec = clock.tick();
        issue.updatedSec = issue.closedSec;
      }
      return { __type: 'CloseIssuePayload', clientMutationId, issue: issueVal(repo, issue) };
    }
    case 'reopenIssue': {
      const { repo, issue } = issueFromNodeId(input.issueId);
      if (issue.state !== 'open') {
        issue.state = 'open';
        issue.closedSec = null;
        issue.updatedSec = clock.tick();
      }
      return { __type: 'ReopenIssuePayload', clientMutationId, issue: issueVal(repo, issue) };
    }
    case 'createPullRequest': {
      const repo = repoFromNodeId(input.repositoryId);
      const created = createPullRec(repo, {
        title: str(input.title),
        body: str(input.body),
        head: str(input.headRefName),
        base: str(input.baseRefName),
      });
      if ('error' in created) throw new GqlError(created.error);
      return { __type: 'CreatePullRequestPayload', clientMutationId, pullRequest: pullVal(repo, created) };
    }
    case 'mergePullRequest': {
      const { repo, pull } = pullFromNodeId(input.pullRequestId);
      const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
      const result = mergePullRec(repo, pull, method);
      if (!result.ok) throw new GqlError('Pull Request is not mergeable');
      return { __type: 'MergePullRequestPayload', clientMutationId, pullRequest: pullVal(repo, pull) };
    }
    case 'addComment': {
      const parsed = parseNodeId(str(input.subjectId));
      let target: { repo: RepoRec; subject: IssueRec | PullRec } | null = null;
      if (parsed !== null && parsed.kind === 'Issue') {
        const found = findIssueByGid(parsed.num);
        if (found !== null) target = { repo: found.repo, subject: found.issue };
      }
      if (parsed !== null && parsed.kind === 'PullRequest') {
        const found = findPullByGid(parsed.num);
        if (found !== null) target = { repo: found.repo, subject: found.pull };
      }
      if (target === null) throw new GqlError('Could not resolve to a subject with the given id.');
      const comment = addCommentRec(target.repo, target.subject, str(input.body));
      return {
        __type: 'AddCommentPayload',
        clientMutationId,
        commentEdge: { __type: 'IssueCommentEdge', node: commentVal(target.repo, comment), cursor: encodeCursor(0) },
        subject: target.subject.kind === 'issue' ? issueVal(target.repo, target.subject) : pullVal(target.repo, target.subject as PullRec),
      };
    }
    case 'createRepository': {
      const name = str(input.name);
      const existing = findRepo(VIEWER.login, name);
      const repo = existing ?? createRepoRec(name, {
        description: typeof input.description === 'string' ? input.description : null,
        isPrivate: input.visibility === 'PRIVATE',
      });
      return { __type: 'CreateRepositoryPayload', clientMutationId, repository: repoVal(repo) };
    }
    default:
      return NOT_HANDLED;
  }
}

function resolveField(obj: GVal, field: string, args: Record<string, unknown>): unknown {
  const type = obj.__type;
  let result: unknown = NOT_HANDLED;
  if (type === 'Query') result = resolveQuery(field, args);
  else if (type === 'Mutation') result = resolveMutation(field, args);
  else if (type === 'User') {
    switch (field) {
      case 'id': result = nodeId('User', VIEWER.id); break;
      case 'databaseId': result = VIEWER.id; break;
      case 'login': result = VIEWER.login; break;
      case 'name': result = VIEWER.name; break;
      case 'email': result = VIEWER.email; break;
      case 'url': case 'avatarUrl': result = ''; break;
      case 'createdAt': case 'updatedAt': result = isoOf(VIEWER.createdSec); break;
      case 'isViewer': result = true; break;
      case 'viewerIsFollowing': result = false; break;
    }
  } else if (type === 'Repository') {
    const repo = obj.repo as RepoRec;
    switch (field) {
      case 'id': result = nodeId('Repository', repo.id); break;
      case 'databaseId': result = repo.id; break;
      case 'name': result = repo.name; break;
      case 'nameWithOwner': result = `${repo.ownerLogin}/${repo.name}`; break;
      case 'owner': result = userVal(); break;
      case 'description': result = repo.description; break;
      case 'isPrivate': result = repo.isPrivate; break;
      case 'isFork': case 'isArchived': result = false; break;
      case 'url': case 'sshUrl': result = ''; break;
      case 'createdAt': result = isoOf(repo.createdSec); break;
      case 'updatedAt': case 'pushedAt': result = isoOf(repo.updatedSec); break;
      case 'defaultBranch': result = repo.defaultBranch; break;
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        result = tip === null ? null : { __type: 'Ref', repo, name: repo.defaultBranch, oid: tip };
        break;
      }
      case 'viewerPermission': result = 'ADMIN'; break;
      case 'hasIssuesEnabled': result = true; break;
      case 'hasProjectsEnabled': result = true; break;
      case 'hasWikiEnabled': result = false; break;
      case 'stargazerCount': case 'forkCount': result = 0; break;
      case 'issue': {
        const issue = repo.issues.get(num(args.number));
        result = issue === undefined ? null : issueVal(repo, issue);
        break;
      }
      case 'issues': result = issueConnection(repo, args); break;
      case 'pullRequest': {
        const pull = repo.pulls.get(num(args.number));
        result = pull === undefined ? null : pullVal(repo, pull);
        break;
      }
      case 'pullRequests': result = pullConnection(repo, args); break;
      case 'label': {
        const label = repo.labels.get(str(args.name).toLowerCase());
        result = label === undefined ? null : labelVal(repo, label);
        break;
      }
      case 'labels':
        result = connectionVal('LabelConnection', [...repo.labels.values()].map((label) => labelVal(repo, label)), args);
        break;
      case 'ref': {
        const qualified = str(args.qualifiedName);
        const branch = qualified.startsWith('refs/heads/') ? qualified.slice('refs/heads/'.length) : qualified;
        const tip = branchTip(repo, branch);
        result = tip === null ? null : { __type: 'Ref', repo, name: branch, oid: tip };
        break;
      }
    }
  } else if (type === 'Issue') {
    const repo = obj.repo as RepoRec;
    const issue = obj.issue as IssueRec;
    switch (field) {
      case 'id': result = nodeId('Issue', issue.gid); break;
      case 'databaseId': result = issue.gid; break;
      case 'number': result = issue.number; break;
      case 'title': result = issue.title; break;
      case 'state': result = issue.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'stateReason': result = null; break;
      case 'body': case 'bodyText': result = issue.body; break;
      case 'url': result = ''; break;
      case 'createdAt': result = isoOf(issue.createdSec); break;
      case 'updatedAt': result = isoOf(issue.updatedSec); break;
      case 'closedAt': result = issue.closedSec === null ? null : isoOf(issue.closedSec); break;
      case 'locked': result = false; break;
      case 'author': result = userVal(); break;
      case 'editor': result = null; break;
      case 'repository': result = repoVal(repo); break;
      case 'labels':
        result = connectionVal(
          'LabelConnection',
          issue.labels
            .map((name) => repo.labels.get(name.toLowerCase()))
            .filter((label) => label !== undefined)
            .map((label) => labelVal(repo, label as LabelRec)),
          args,
        );
        break;
      case 'comments':
        result = connectionVal('IssueCommentConnection', issue.comments.map((comment) => commentVal(repo, comment)), args);
        break;
      case 'assignees': result = connectionVal('LabelConnection', [], args); break;
      case 'participants': result = connectionVal('LabelConnection', [userVal()], args); break;
      case 'milestone': result = null; break;
    }
  } else if (type === 'PullRequest') {
    const repo = obj.repo as RepoRec;
    const pull = obj.pull as PullRec;
    switch (field) {
      case 'id': result = nodeId('PullRequest', pull.gid); break;
      case 'databaseId': result = pull.gid; break;
      case 'number': result = pull.number; break;
      case 'title': result = pull.title; break;
      case 'body': result = pull.body; break;
      case 'state': result = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; break;
      case 'merged': result = pull.merged; break;
      case 'mergedAt': result = pull.mergedSec === null ? null : isoOf(pull.mergedSec); break;
      case 'closedAt':
        result = pull.closedSec !== null ? isoOf(pull.closedSec) : pull.mergedSec !== null ? isoOf(pull.mergedSec) : null;
        break;
      case 'createdAt': result = isoOf(pull.createdSec); break;
      case 'updatedAt': result = isoOf(pull.updatedSec); break;
      case 'headRefName': result = pull.headRef; break;
      case 'baseRefName': result = pull.baseRef; break;
      case 'headRef': {
        const tip = branchTip(repo, pull.headRef);
        result = tip === null ? null : { __type: 'Ref', repo, name: pull.headRef, oid: tip };
        break;
      }
      case 'baseRef': {
        const tip = branchTip(repo, pull.baseRef);
        result = tip === null ? null : { __type: 'Ref', repo, name: pull.baseRef, oid: tip };
        break;
      }
      case 'mergeable':
        result = pull.state !== 'open' ? 'UNKNOWN' : pullConflicts(repo, pull).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
        break;
      case 'mergeCommit':
        result = pull.mergeCommitSha === null ? null : { __type: 'Commit', repo, oid: pull.mergeCommitSha };
        break;
      case 'mergedBy': result = pull.merged ? userVal() : null; break;
      case 'isDraft': result = false; break;
      case 'author': result = userVal(); break;
      case 'repository': result = repoVal(repo); break;
      case 'url': result = ''; break;
      case 'labels':
        result = connectionVal(
          'LabelConnection',
          pull.labels
            .map((name) => repo.labels.get(name.toLowerCase()))
            .filter((label) => label !== undefined)
            .map((label) => labelVal(repo, label as LabelRec)),
          args,
        );
        break;
      case 'comments':
        result = connectionVal('IssueCommentConnection', pull.comments.map((comment) => commentVal(repo, comment)), args);
        break;
      case 'files': {
        const changes = pullFiles(repo, pull).map((change) => ({
          __type: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status.toUpperCase(),
        }) as GVal);
        result = connectionVal('PullRequestChangedFileConnection', changes, args);
        break;
      }
      case 'additions': result = pullFiles(repo, pull).reduce((sum, change) => sum + change.additions, 0); break;
      case 'deletions': result = pullFiles(repo, pull).reduce((sum, change) => sum + change.deletions, 0); break;
      case 'changedFiles': result = pullFiles(repo, pull).length; break;
    }
  } else if (type === 'IssueComment') {
    const comment = obj.comment as IssueRec['comments'][number];
    switch (field) {
      case 'id': result = nodeId('IssueComment', comment.gid); break;
      case 'databaseId': result = comment.gid; break;
      case 'body': case 'bodyText': result = comment.body; break;
      case 'author': result = userVal(); break;
      case 'createdAt': result = isoOf(comment.createdSec); break;
      case 'updatedAt': result = isoOf(comment.updatedSec); break;
      case 'url': result = ''; break;
      case 'viewerDidAuthor': result = true; break;
    }
  } else if (type === 'Label') {
    const label = obj.label as LabelRec;
    switch (field) {
      case 'id': result = nodeId('Label', label.gid); break;
      case 'name': result = label.name; break;
      case 'color': result = label.color; break;
      case 'description': result = label.description; break;
    }
  } else if (type === 'Ref') {
    const repo = obj.repo as RepoRec;
    switch (field) {
      case 'id':
        result = Buffer.from(`ref:${repo.id}:${str(obj.name)}`, 'utf8').toString('base64');
        break;
      case 'name': result = obj.name; break;
      case 'prefix': result = 'refs/heads/'; break;
      case 'target': result = { __type: 'Commit', repo, oid: obj.oid }; break;
      case 'repository': result = repoVal(repo); break;
    }
  } else if (type === 'Commit') {
    const repo = obj.repo as RepoRec;
    const oid = str(obj.oid);
    switch (field) {
      case 'id':
        result = Buffer.from(`commit:${oid}`, 'utf8').toString('base64');
        break;
      case 'oid': result = oid; break;
      case 'message': result = commitMessage(oid); break;
      case 'messageHeadline': result = commitMessage(oid).split('\n')[0] ?? ''; break;
      case 'committedDate': case 'authoredDate': result = isoOf(commitTime(oid)); break;
      case 'author': result = { __type: 'GitActor', name: VIEWER.name, email: VIEWER.email, date: isoOf(commitTime(oid)) }; break;
      case 'url': result = ''; break;
      default: void repo;
    }
  } else if (type === '__Type') {
    switch (field) {
      case 'fields':
        result = (obj.fieldNames as string[]).map((name) => ({ __type: '__Field', name }));
        break;
      case 'enumValues':
        result = (obj.enumNames as string[]).map((name) => ({ __type: '__EnumValue', name }));
        break;
      case 'possibleTypes':
        result = obj.name === 'Node' ? [...NODE_IMPLEMENTORS].map((name) => typeVal(name)) : null;
        break;
      case 'inputFields': result = []; break;
      case 'interfaces': result = []; break;
      case 'ofType': result = null; break;
      case 'description': result = null; break;
      case 'specifiedByURL': result = null; break;
    }
  } else if (type === '__Field') {
    switch (field) {
      case 'description': result = null; break;
      case 'type': result = null; break;
      case 'args': result = []; break;
      case 'isDeprecated': result = false; break;
      case 'deprecationReason': result = null; break;
    }
  } else if (type === '__EnumValue') {
    switch (field) {
      case 'description': result = null; break;
      case 'isDeprecated': result = false; break;
      case 'deprecationReason': result = null; break;
    }
  } else if (type === '__Schema') {
    switch (field) {
      case 'queryType': result = typeVal('Query'); break;
      case 'mutationType': result = typeVal('Mutation'); break;
      case 'subscriptionType': result = null; break;
      case 'types': result = Object.keys(SCHEMA).map((name) => typeVal(name)).filter((val) => val !== null); break;
      case 'directives': result = []; break;
    }
  }
  if (result !== NOT_HANDLED) return result;
  if (CARRIER_TYPES.has(type) && field in obj) return obj[field];
  const descriptor = SCHEMA[type];
  if (descriptor !== undefined && (descriptor.fields ?? []).includes(field)) return null;
  throw new GqlError(`Field '${field}' doesn't exist on type '${type}'`);
}

// Commit lookups for the Commit type, resolved lazily through the object store.
import { getCommit as storeGetCommit } from './forge.ts';

function commitMessage(oid: string): string {
  const commit = storeGetCommit(oid);
  return commit === null ? '' : commit.message;
}

function commitTime(oid: string): number {
  const commit = storeGetCommit(oid);
  return commit === null ? clock.now() : commit.authorTime;
}

// ---------------------------------------------------------------------------
// Executor.

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  if (condition === 'Node') return NODE_IMPLEMENTORS.has(actual);
  if (condition === 'Actor' || condition === 'RepositoryOwner') return actual === 'User';
  return false;
}

function directiveSkips(directives: DirectiveNode[], ctx: ExecContext): boolean {
  for (const directive of directives) {
    if (directive.name !== 'skip' && directive.name !== 'include') continue;
    const ifNode = directive.args.get('if');
    if (ifNode === undefined) continue;
    const flag = valueOf(ifNode, ctx.variables);
    if (directive.name === 'skip' && flag === true) return true;
    if (directive.name === 'include' && flag === false) return true;
  }
  return false;
}

function materializeArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, node] of field.args) {
    const value = valueOf(node, ctx.variables);
    if (value !== undefined) args[name] = value;
  }
  return args;
}

function executeSelectionSet(
  selections: SelectionNode[],
  obj: GVal,
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || typeMatches(obj.__type, selection.typeCondition)) {
        Object.assign(out, executeSelectionSet(selection.selectionSet, obj, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(obj.__type, fragment.typeCondition)) {
        Object.assign(out, executeSelectionSet(fragment.selectionSet, obj, ctx, path));
      }
      continue;
    }
    if (directiveSkips(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__type;
      continue;
    }
    if (selection.name === '__type' && obj.__type === 'Query') {
      const args = materializeArgs(selection, ctx);
      const found = typeVal(str(args.name));
      out[key] = found === null || selection.selectionSet === null
        ? null
        : executeSelectionSet(selection.selectionSet, found, ctx, [...path, key]);
      continue;
    }
    if (selection.name === '__schema' && obj.__type === 'Query') {
      const schemaVal: GVal = { __type: '__Schema' };
      out[key] = selection.selectionSet === null ? null : executeSelectionSet(selection.selectionSet, schemaVal, ctx, [...path, key]);
      continue;
    }
    let raw: unknown;
    try {
      raw = resolveField(obj, selection.name, materializeArgs(selection, ctx));
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(raw, selection, ctx, [...path, key]);
  }
  return out;
}

function completeValue(
  raw: unknown,
  selection: FieldNode,
  ctx: ExecContext,
  path: Array<string | number>,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item, index) => completeValue(item, selection, ctx, [...path, index]));
  if (typeof raw === 'object' && '__type' in (raw as Record<string, unknown>)) {
    if (selection.selectionSet === null) return null;
    return executeSelectionSet(selection.selectionSet, raw as GVal, ctx, path);
  }
  return raw;
}

interface OperationRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function runOperation(request: OperationRequest): { data: unknown; errors?: Array<{ message: string; path: Array<string | number> }> } {
  let document: DocumentNode;
  try {
    document = parseGraphQL(request.query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error), path: [] }] };
  }
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName);
  }
  operation ??= document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation in the document', path: [] }] };
  }
  const variables: Record<string, unknown> = {};
  for (const [name, node] of operation.varDefaults) {
    const value = valueOf(node, {});
    if (value !== undefined) variables[name] = value;
  }
  Object.assign(variables, request.variables ?? {});
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const root: GVal = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(operation.selectionSet, root, ctx, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------------------
// HTTP handler for POST /api/graphql (single operations and JSON batches).

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  if (!ctx.authed) {
    sendJson(res, 401, { message: 'Bad credentials', errors: [{ message: 'Bad credentials' }] }, { 'x-github-request-id': `req-${ctx.requestSeq}` });
    return;
  }
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, { 'x-github-request-id': `req-${ctx.requestSeq}` });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof (entry as OperationRequest).query !== 'string') {
        return { data: null, errors: [{ message: 'a GraphQL operation must carry a query string' }] };
      }
      return runOperation(entry as OperationRequest);
    });
    sendJson(res, 200, results, { 'x-github-request-id': `req-${ctx.requestSeq}` });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as OperationRequest).query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'a GraphQL operation must carry a query string' }] }, { 'x-github-request-id': `req-${ctx.requestSeq}` });
    return;
  }
  sendJson(res, 200, runOperation(parsed as OperationRequest), { 'x-github-request-id': `req-${ctx.requestSeq}` });
}
