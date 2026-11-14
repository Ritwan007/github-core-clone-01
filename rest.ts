// rest.ts — the REST v3 API under /api/v3: repositories, contents, branches, commits, git refs,
// labels, issues, comments and pull requests, in GitHub's shapes and with GitHub's statuses.
// Every reply is JSON with an X-GitHub-Request-Id; every error is {"message": ...}.

import {
  VIEWER,
  addCommentRec,
  branchTip,
  clock,
  commitTreeOid,
  createCommit,
  createIssueRec,
  createPullRec,
  createRepoRec,
  deleteRepoRec,
  findRepo,
  flattenTree,
  getObject,
  headRefName,
  isoOf,
  issueOrPull,
  mergePullRec,
  nextGid,
  nodeId,
  objects,
  parseCommit,
  parseTree,
  pullConflicts,
  pullFiles,
  renameRepoRec,
  resolveRefToCommit,
  storeObject,
  treeFromFlat,
  viewerRepos,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
  type ScenarioUser,
} from './forge.ts';
import { readBody, sendJson, type Ctx } from './http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

interface Reply {
  (status: number, value?: unknown, headers?: Readonly<Record<string, string>>): void;
}

function makeReply(res: ServerResponse, ctx: Ctx): Reply {
  return (status, value, headers = {}) => {
    sendJson(res, status, value, { 'x-github-request-id': `req-${ctx.requestSeq}`, ...headers });
  };
}

// ---------------------------------------------------------------------------
// Serializers.

export function userJson(user: ScenarioUser): Json {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: '',
    gravatar_id: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
    company: null,
    blog: '',
    location: null,
    hireable: null,
    bio: null,
    public_repos: 0,
    followers: 0,
    following: 0,
  };
}

export function repoJson(ctx: Ctx, repo: RepoRec): Json {
  const fullName = `${repo.ownerLogin}/${repo.name}`;
  const base = `http://${ctx.host}/${fullName}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    owner: userJson(VIEWER),
    private: repo.isPrivate,
    html_url: base,
    description: repo.description,
    fork: false,
    url: `http://${ctx.host}/api/v3/repos/${fullName}`,
    clone_url: `${base}.git`,
    ssh_url: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    pushed_at: isoOf(repo.updatedSec),
  };
}

export function labelJson(label: LabelRec): Json {
  return {
    id: label.gid,
    node_id: nodeId('Label', label.gid),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.gid,
    node_id: nodeId('Issue', issue.gid),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name.toLowerCase()))
      .filter((label): label is LabelRec => label !== undefined)
      .map((label) => labelJson(label)),
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    comments: issue.comments.length,
    locked: false,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : isoOf(issue.closedSec),
    html_url: '',
    url: '',
    repository_url: '',
  };
}

export function commentJson(comment: CommentRec): Json {
  return {
    id: comment.gid,
    node_id: nodeId('IssueComment', comment.gid),
    body: comment.body,
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
    html_url: '',
    url: '',
  };
}

export function pullJson(ctx: Ctx, repo: RepoRec, pull: PullRec): Json {
  const side = (ref: string): Json => ({
    label: `${repo.ownerLogin}:${ref}`,
    ref,
    sha: branchTip(repo, ref) ?? '0000000000000000000000000000000000000000',
    user: userJson(VIEWER),
    repo: repoJson(ctx, repo),
  });
  return {
    id: pull.gid,
    node_id: nodeId('PullRequest', pull.gid),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    head: side(pull.headRef),
    base: side(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : isoOf(pull.mergedSec),
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedSec === null ? null : isoOf(pull.closedSec),
    draft: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    comments: pull.comments.length,
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    html_url: '',
    url: '',
  };
}

function commitJson(oid: string): Json {
  const obj = getObject(oid);
  const commit = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  if (commit === null) return { sha: oid };
  const person = (name: string, email: string, sec: number): Json => ({
    name,
    email,
    date: isoOf(sec),
  });
  const authorUser = commit.authorEmail === VIEWER.email ? userJson(VIEWER) : null;
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: person(commit.authorName, commit.authorEmail, commit.authorSec),
      committer: person(commit.authorName, commit.authorEmail, commit.committerSec),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    author: authorUser,
    committer: authorUser,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------
// Pagination: GitHub's per_page/page with a Link header whose rel="next" stays on this origin.

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(ctx: Ctx, path: string, query: URLSearchParams, items: readonly T[]): Page<T> {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${ctx.host}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  }
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

function sendPage<T>(reply: Reply, page: Page<T>): void {
  reply(200, page.items, page.link === null ? {} : { link: page.link });
}

// ---------------------------------------------------------------------------
// Request bodies: a malformed JSON body is a 400 everywhere on this surface.

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: Json } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, body: {} };
    return { ok: true, body: parsed as Json };
  } catch {
    return { ok: false };
  }
}

function stringField(body: Json, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Repository handlers.

const REPO_NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function createRepoHandler(req: IncomingMessage, reply: Reply, ctx: Ctx): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const name = stringField(parsed.body, 'name');
  if (name === null || !REPO_NAME_OK.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    reply(422, { message: 'Validation Failed: name is invalid' });
    return;
  }
  if (findRepo(VIEWER.login, name) !== undefined) {
    reply(422, { message: 'Validation Failed: name already exists on this account' });
    return;
  }
  const repo = createRepoRec(name, {
    description: stringField(parsed.body, 'description'),
    isPrivate: parsed.body.private === true,
  });
  reply(201, repoJson(ctx, repo));
}

async function patchRepoHandler(req: IncomingMessage, reply: Reply, ctx: Ctx, repo: RepoRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const description = stringField(body, 'description');
  if (description !== null || 'description' in body) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const defaultBranch = stringField(body, 'default_branch');
  if (defaultBranch !== null && (branchTip(repo, defaultBranch) !== null || repo.refs.size === 0)) {
    repo.defaultBranch = defaultBranch;
  }
  const newName = stringField(body, 'name');
  if (newName !== null && newName !== repo.name && REPO_NAME_OK.test(newName)) {
    if (findRepo(VIEWER.login, newName) === undefined) renameRepoRec(repo, newName);
  }
  reply(200, repoJson(ctx, repo));
}

// ---------------------------------------------------------------------------
// Contents handlers.

interface TreeHit {
  kind: 'file' | 'dir';
  oid: string;
  mode: string;
}

/** Walk a tree to `path`: a file hit, a directory hit (its subtree id), or null. */
function treeHit(treeOid: string | null, path: string): TreeHit | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = getObject(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function getContents(reply: Reply, repo: RepoRec, path: string, query: URLSearchParams): void {
  const commit = resolveRefToCommit(repo, query.get('ref'));
  const treeOid = commitTreeOid(commit);
  if (treeOid === null) {
    reply(404, { message: 'Not Found' });
    return;
  }
  const hit = treeHit(treeOid, path);
  if (hit === null) {
    reply(404, { message: 'Not Found' });
    return;
  }
  if (hit.kind === 'file') {
    const blob = getObject(hit.oid);
    const data = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
    reply(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: data.toString('base64'),
      sha: hit.oid,
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
    });
    return;
  }
  const dirObj = getObject(hit.oid);
  const entries = dirObj !== undefined && dirObj.type === 'tree' ? parseTree(dirObj.data) : [];
  reply(
    200,
    entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (getObject(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      url: '',
      git_url: '',
      html_url: '',
      download_url: null,
    })),
  );
}

async function putContents(req: IncomingMessage, reply: Reply, repo: RepoRec, path: string): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const contentB64 = stringField(body, 'content');
  if (contentB64 === null) {
    reply(422, { message: 'Validation Failed: content is required' });
    return;
  }
  const message = stringField(body, 'message') ?? `Update ${path}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write names the branch it creates: fork it from the default branch's tip.
    tip = branchTip(repo, repo.defaultBranch);
  }
  const flat = flattenTree(commitTreeOid(tip));
  const existing = flat.get(path);
  const sha = stringField(body, 'sha');
  if (sha !== null) {
    if (existing === undefined || existing.oid !== sha) {
      reply(409, { message: 'Conflict: the sha does not match the current content' });
      return;
    }
  } else if (existing !== undefined) {
    reply(422, { message: "Validation Failed: sha wasn't supplied" });
    return;
  }
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobOid = storeObject('blob', data);
  flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const tree = treeFromFlat(flat);
  const commit = createCommit(tree, tip === null ? [] : [tip], message);
  repo.refs.set(ref, commit);
  reply(existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: data.length,
      type: 'file',
      encoding: 'base64',
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
    },
    commit: { sha: commit, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
  });
}

async function deleteContents(req: IncomingMessage, reply: Reply, repo: RepoRec, path: string): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const flat = flattenTree(commitTreeOid(tip));
  const existing = flat.get(path);
  if (tip === null || existing === undefined) {
    reply(404, { message: 'Not Found' });
    return;
  }
  const sha = stringField(body, 'sha');
  if (sha !== null && sha !== existing.oid) {
    reply(409, { message: 'Conflict: the sha does not match the current content' });
    return;
  }
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  flat.delete(path);
  const tree = treeFromFlat(flat);
  const commit = createCommit(tree, [tip], message);
  repo.refs.set(ref, commit);
  reply(200, { content: null, commit: { sha: commit, message } });
}

// ---------------------------------------------------------------------------
// Branches, commits, git refs.

function listBranches(reply: Reply, repo: RepoRec): void {
  const out: unknown[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false });
  }
  reply(200, out);
}

function getBranch(reply: Reply, repo: RepoRec, name: string): void {
  const oid = branchTip(repo, name);
  if (oid === null) {
    reply(404, { message: 'Branch not found' });
    return;
  }
  reply(200, { name, commit: { sha: oid, url: '' }, protected: false });
}

function listCommits(reply: Reply, ctx: Ctx, path: string, repo: RepoRec, query: URLSearchParams): void {
  const start = resolveRefToCommit(repo, query.get('sha'));
  if (start === null) {
    sendPage(reply, paginate(ctx, path, query, [] as unknown[]));
    return;
  }
  // Newest first: a pre-order walk (fixtures are linear; merges keep parents after children).
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  sendPage(reply, paginate(ctx, path, query, order.map((oid) => commitJson(oid))));
}

function refJson(ref: string, oid: string): Json {
  return { ref, node_id: '', url: '', object: { sha: oid, type: getObject(oid)?.type ?? 'commit', url: '' } };
}

async function createRefHandler(req: IncomingMessage, reply: Reply, repo: RepoRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const ref = stringField(parsed.body, 'ref');
  const sha = stringField(parsed.body, 'sha');
  if (ref === null || !ref.startsWith('refs/') || sha === null || getObject(sha) === undefined) {
    reply(422, { message: 'Validation Failed: ref or object is invalid' });
    return;
  }
  if (repo.refs.has(ref)) {
    reply(422, { message: 'Validation Failed: Reference already exists' });
    return;
  }
  repo.refs.set(ref, sha);
  reply(201, refJson(ref, sha));
}

function getRef(reply: Reply, repo: RepoRec, ref: string): void {
  const oid = repo.refs.get(ref);
  if (oid !== undefined) {
    reply(200, refJson(ref, oid));
    return;
  }
  // A namespace path (refs/heads, refs/heads/feature) lists the refs under it, as GitHub does.
  const prefix = `${ref}/`;
  const matches = [...repo.refs.entries()].filter(([name]) => name.startsWith(prefix));
  if (matches.length > 0) {
    reply(200, matches.map(([name, target]) => refJson(name, target)));
    return;
  }
  reply(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// Labels.

async function createLabelHandler(req: IncomingMessage, reply: Reply, repo: RepoRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const name = stringField(parsed.body, 'name');
  if (name === null || name === '') {
    reply(422, { message: 'Validation Failed: name is required' });
    return;
  }
  if (repo.labels.has(name.toLowerCase())) {
    reply(422, { message: 'Validation Failed: name already exists on this repository' });
    return;
  }
  const label: LabelRec = {
    gid: nextGid(),
    name,
    color: (stringField(parsed.body, 'color') ?? 'ededed').replace(/^#/, ''),
    description: stringField(parsed.body, 'description'),
  };
  repo.labels.set(name.toLowerCase(), label);
  reply(201, labelJson(label));
}

// ---------------------------------------------------------------------------
// Issues and comments.

function listIssues(reply: Reply, ctx: Ctx, path: string, repo: RepoRec, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  sendPage(reply, paginate(ctx, path, query, issues.map((issue) => issueJson(repo, issue))));
}

async function createIssueHandler(req: IncomingMessage, reply: Reply, ctx: Ctx, repo: RepoRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const title = stringField(body, 'title');
  if (title === null || title === '') {
    reply(422, { message: 'Validation Failed: title is required' });
    return;
  }
  const labelNames: string[] = [];
  const rawLabels = body.labels;
  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      const name = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? stringField(entry as Json, 'name') : null;
      if (name !== null) labelNames.push(name);
    }
  }
  for (const name of labelNames) {
    if (!repo.labels.has(name.toLowerCase())) {
      reply(422, { message: `Validation Failed: label '${name}' does not exist on this repository` });
      return;
    }
  }
  const canonical = labelNames.map((name) => (repo.labels.get(name.toLowerCase()) as LabelRec).name);
  const issue = createIssueRec(repo, { title, body: stringField(body, 'body') ?? '', labels: canonical });
  reply(201, issueJson(repo, issue));
}

async function patchIssueHandler(req: IncomingMessage, reply: Reply, repo: RepoRec, issue: IssueRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const title = stringField(body, 'title');
  if (title !== null) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== null) issue.body = text;
  const state = stringField(body, 'state');
  if (state === 'closed' && issue.state !== 'closed') {
    issue.state = 'closed';
    issue.closedSec = clock.tick();
    issue.updatedSec = issue.closedSec;
  } else if (state === 'open' && issue.state !== 'open') {
    issue.state = 'open';
    issue.closedSec = null;
    issue.updatedSec = clock.tick();
  }
  reply(200, issueJson(repo, issue));
}

function listComments(reply: Reply, ctx: Ctx, path: string, target: IssueRec | PullRec, query: URLSearchParams): void {
  sendPage(reply, paginate(ctx, path, query, target.comments.map((comment) => commentJson(comment))));
}

async function createCommentHandler(req: IncomingMessage, reply: Reply, repo: RepoRec, target: IssueRec | PullRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const text = stringField(parsed.body, 'body');
  if (text === null) {
    reply(422, { message: 'Validation Failed: body is required' });
    return;
  }
  const comment = addCommentRec(repo, target, text);
  reply(201, commentJson(comment));
}

// ---------------------------------------------------------------------------
// Pull requests.

function listPulls(reply: Reply, ctx: Ctx, path: string, repo: RepoRec, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  sendPage(reply, paginate(ctx, path, query, pulls.map((pull) => pullJson(ctx, repo, pull))));
}

async function createPullHandler(req: IncomingMessage, reply: Reply, ctx: Ctx, repo: RepoRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const body = parsed.body;
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (head === null || base === null) {
    reply(422, { message: 'Validation Failed: head and base are required' });
    return;
  }
  const created = createPullRec(repo, {
    title: stringField(body, 'title') ?? '',
    body: stringField(body, 'body') ?? '',
    head,
    base,
  });
  if ('error' in created) {
    reply(422, { message: `Validation Failed: ${created.error}` });
    return;
  }
  reply(201, pullJson(ctx, repo, created));
}

async function patchPullHandler(req: IncomingMessage, reply: Reply, ctx: Ctx, repo: RepoRec, pull: PullRec): Promise<void> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const title = stringField(parsed.body, 'title');
  if (title !== null) pull.title = title;
  const text = stringField(parsed.body, 'body');
  if (text !== null) pull.body = text;
  const state = stringField(parsed.body, 'state');
  if (state === 'closed' && pull.state === 'open') {
    pull.state = 'closed';
    pull.closedSec = clock.tick();
    pull.updatedSec = pull.closedSec;
  }
  if (state === 'open' && pull.state === 'closed' && !pull.merged) {
    pull.state = 'open';
    pull.closedSec = null;
    pull.updatedSec = clock.tick();
  }
  reply(200, pullJson(ctx, repo, pull));
}

function getPullFiles(reply: Reply, repo: RepoRec, pull: PullRec): void {
  reply(
    200,
    pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })),
  );
}

async function mergePullHandler(req: IncomingMessage, reply: Reply, repo: RepoRec, pull: PullRec | undefined): Promise<void> {
  if (pull === undefined) {
    reply(404, { message: 'Not Found' });
    return;
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    reply(400, { message: 'Problems parsing JSON' });
    return;
  }
  const methodRaw = stringField(parsed.body, 'merge_method') ?? 'merge';
  const method = methodRaw === 'merge' ? 'merge' : 'squash';
  const result = mergePullRec(repo, pull, method);
  if (!result.ok) {
    if (result.reason === 'missing') {
      reply(404, { message: 'Not Found' });
      return;
    }
    reply(405, { message: 'Pull Request is not mergeable' });
    return;
  }
  reply(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------
// The router. `pathname` is the full request path (always under /api/v3).

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  pathname: string,
  query: URLSearchParams,
): Promise<void> {
  const reply = makeReply(res, ctx);
  if (!ctx.authed) {
    reply(401, { message: 'Bad credentials' });
    return;
  }
  const segments = pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  const method = req.method ?? 'GET';
  const path = pathname;

  if (segments.length === 0) {
    if (method !== 'GET') return reply(404, { message: 'Not Found' });
    const base = `http://${ctx.host}/api/v3`;
    return reply(
      200,
      {
        current_user_url: `${base}/user`,
        current_user_repositories_url: `${base}/user/repos`,
        repository_url: `${base}/repos/{owner}/{repo}`,
        issue_search_url: `${base}/search/issues?q={query}`,
        commit_search_url: `${base}/search/commits?q={query}`,
        label_search_url: `${base}/search/labels?q={query}`,
        emojis_url: `${base}/emojis`,
        events_url: `${base}/events`,
        feeds_url: `${base}/feeds`,
        notifications_url: `${base}/notifications`,
        organization_repositories_url: `${base}/orgs/{org}/repos`,
        public_gists_url: `${base}/gists/public`,
        rate_limit_url: `${base}/rate_limit`,
        repository_search_url: `${base}/search/repositories?q={query}`,
        user_search_url: `${base}/search/users?q={query}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return reply(404, { message: 'Not Found' });
    return reply(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: {},
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      installed_version: '1.0.0',
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return reply(404, { message: 'Not Found' });
    return reply(200, userJson(VIEWER));
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      return sendPage(reply, paginate(ctx, path, query, viewerRepos().map((repo) => repoJson(ctx, repo))));
    }
    if (method === 'POST') return createRepoHandler(req, reply, ctx);
    return reply(404, { message: 'Not Found' });
  }
  if (segments[0] !== 'repos' || segments.length < 3) {
    return reply(404, { message: 'Not Found' });
  }
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = findRepo(owner, repoName);
  if (repo === undefined) return reply(404, { message: 'Not Found' });
  const tail = segments.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return reply(200, repoJson(ctx, repo));
    if (method === 'PATCH') return patchRepoHandler(req, reply, ctx, repo);
    if (method === 'DELETE') {
      deleteRepoRec(repo);
      return reply(204);
    }
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') return listBranches(reply, repo);
    if (tail.length >= 2 && method === 'GET') return getBranch(reply, repo, tail.slice(1).join('/'));
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method === 'GET') return listCommits(reply, ctx, path, repo, query);
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'contents' && tail.length >= 2) {
    const filePath = tail.slice(1).join('/');
    if (method === 'GET') return getContents(reply, repo, filePath, query);
    if (method === 'PUT') return putContents(req, reply, repo, filePath);
    if (method === 'DELETE') return deleteContents(req, reply, repo, filePath);
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'POST') return createRefHandler(req, reply, repo);
      if (method === 'GET') return reply(200, [...repo.refs.entries()].map(([ref, oid]) => refJson(ref, oid)));
      return reply(404, { message: 'Not Found' });
    }
    const ref = `refs/${tail.slice(2).join('/')}`;
    if (method === 'GET') return getRef(reply, repo, ref);
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) return reply(404, { message: 'Not Found' });
      if (ref === headRefName(repo)) return reply(422, { message: 'Validation Failed: cannot delete the current branch' });
      repo.refs.delete(ref);
      return reply(204);
    }
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') return reply(200, [...repo.labels.values()].map((label) => labelJson(label)));
      if (method === 'POST') return createLabelHandler(req, reply, repo);
      return reply(404, { message: 'Not Found' });
    }
    if (tail.length === 2 && method === 'GET') {
      const label = repo.labels.get((tail[1] as string).toLowerCase());
      if (label === undefined) return reply(404, { message: 'Not Found' });
      return reply(200, labelJson(label));
    }
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') return listIssues(reply, ctx, path, repo, query);
      if (method === 'POST') return createIssueHandler(req, reply, ctx, repo);
      return reply(404, { message: 'Not Found' });
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) return reply(404, { message: 'Not Found' });
    if (tail.length === 2) {
      const issue = repo.issues.get(number);
      if (method === 'GET') {
        if (issue === undefined) return reply(404, { message: 'Not Found' });
        return reply(200, issueJson(repo, issue));
      }
      if (method === 'PATCH') {
        if (issue === undefined) return reply(404, { message: 'Not Found' });
        return patchIssueHandler(req, reply, repo, issue);
      }
      return reply(404, { message: 'Not Found' });
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const target = issueOrPull(repo, number);
      if (target === undefined) return reply(404, { message: 'Not Found' });
      if (method === 'GET') return listComments(reply, ctx, path, target, query);
      if (method === 'POST') return createCommentHandler(req, reply, repo, target);
      return reply(404, { message: 'Not Found' });
    }
    return reply(404, { message: 'Not Found' });
  }
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') return listPulls(reply, ctx, path, repo, query);
      if (method === 'POST') return createPullHandler(req, reply, ctx, repo);
      return reply(404, { message: 'Not Found' });
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) {
      // The merge route on an unparseable number is still a 404, as GitHub answers.
      return reply(404, { message: 'Not Found' });
    }
    const pull = repo.pulls.get(number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (pull === undefined) return reply(404, { message: 'Not Found' });
        return reply(200, pullJson(ctx, repo, pull));
      }
      if (method === 'PATCH') {
        if (pull === undefined) return reply(404, { message: 'Not Found' });
        return patchPullHandler(req, reply, ctx, repo, pull);
      }
      return reply(404, { message: 'Not Found' });
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return reply(404, { message: 'Not Found' });
      return getPullFiles(reply, repo, pull);
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      return mergePullHandler(req, reply, repo, pull);
    }
    return reply(404, { message: 'Not Found' });
  }
  return reply(404, { message: 'Not Found' });
}
