// forge.ts — the forge's core: the seeded identity it serves, its deterministic clock, the git
// object store (SHA-1, content-addressed), tree/commit plumbing, ancestry, and the repository /
// issue / pull-request records every surface (git smart HTTP, REST, GraphQL, MCP) shares.
//
// Everything here is in-memory and deterministic: no wall clock, no randomness. Time comes from
// a logical clock seeded by MAKEFUN_TRIAL_NOW (the trial's opening instant) so that two runs of
// the same trial produce byte-identical objects, ids and timestamps.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The seeded identity. The suite's wire contract (wire.ts in the kit) derives every name it
// uses from one fixed seed; the token's owner is the first generated user. This is a small
// reimplementation of that generator (FNV-1a64 -> splitmix64 mix -> xorshift64*), run once at
// boot, so the forge knows its viewer the way the suite does.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioRng(label: string): ScenarioRng {
  return new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: ScenarioRng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(scenarioRng('users'), 12);
/** The token's owner: every repository the forge serves belongs to this login. */
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
export const TEAMMATE: ScenarioUser = USERS[1] as ScenarioUser;
export const STRANGER: ScenarioUser = USERS[2] as ScenarioUser;

const orgRng = scenarioRng('org');
export const ORG_NAME = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;

/** The scenario's day one (2025-01-01T00:00:00Z): the fallback base of the logical clock. */
export const SCENARIO_EPOCH_SEC = 1735689600;

// ---------------------------------------------------------------------------
// The logical clock. Base = MAKEFUN_TRIAL_NOW when the harness provides it (ISO text or epoch),
// else the scenario epoch. Each tick() advances one second, so timestamps are monotonic in
// operation order and identical across a trial's live run and its replay.

function trialNowBaseSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : value;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

class LogicalClock {
  readonly baseSec: number;
  private ticks = 0;
  constructor() {
    this.baseSec = trialNowBaseSec();
  }
  /** Advance the clock and return the new time, in epoch seconds. */
  tick(): number {
    this.ticks += 1;
    return this.baseSec + this.ticks;
  }
  /** The current logical time without advancing (epoch seconds). */
  peek(): number {
    return this.baseSec + this.ticks;
  }
  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }
}

export const clock = new LogicalClock();

/** An ISO timestamp for a logical-clock second. */
export function isoOf(sec: number): string {
  return clock.iso(sec);
}

// ---------------------------------------------------------------------------
// Relay-style global ids (GraphQL node ids, REST node_id): base64 of "<prefix>:<Kind><num>",
// the legacy GitHub spelling. Opaque, stable, and decodable only by this forge.

const NODE_PREFIX: Readonly<Record<string, string>> = {
  User: '04',
  Issue: '05',
  Repository: '010',
  PullRequest: '011',
  IssueComment: '012',
  Label: '013',
};

export function nodeId(kind: string, num: number): string {
  const prefix = NODE_PREFIX[kind] ?? '099';
  return Buffer.from(`${prefix}:${kind}${num}`, 'utf8').toString('base64');
}

/** Decode a global id back to its kind and number, or null when it is not one of ours. */
export function parseNodeId(id: string): { kind: string; num: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
  if (match === null) return null;
  const kind = match[1] as string;
  if (!(kind in NODE_PREFIX)) return null;
  return { kind, num: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// The git object store: one content-addressed pool shared by every repository, as a real
// forge's object database is shared. Objects are immutable; identical bytes are stored once.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const objects = new Map<string, GitObj>();

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObj | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// Trees and commits.

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if its name ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeTree(entries: readonly TreeEntry[]): string {
  return storeObject('tree', buildTreeData(entries));
}

/** The canonical empty tree's id (storing it is a no-op lookup away). */
export function emptyTreeOid(): string {
  return storeObject('tree', Buffer.alloc(0));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorName: string;
  authorEmail: string;
  authorSec: number;
  committerSec: number;
  message: string;
}

function parseIdent(line: string): { name: string; email: string; sec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', sec: 0 };
  return { name: match[1] as string, email: match[2] as string, sec: Number(match[3]) };
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const a = parseIdent(author);
  const c = parseIdent(committer);
  return {
    tree,
    parents,
    author,
    committer,
    authorName: a.name,
    authorEmail: a.email,
    authorSec: a.sec,
    committerSec: c.sec,
    message,
  };
}

export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  name: string;
  email: string;
  sec: number;
}): Buffer {
  const who = `${fields.name} <${fields.email}> ${fields.sec} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Create a commit authored by the viewer at the next logical instant. */
export function createCommit(tree: string, parents: readonly string[], message: string): string {
  const sec = clock.tick();
  return storeObject('commit', buildCommitData({
    tree,
    parents,
    message,
    name: VIEWER.name,
    email: VIEWER.email,
    sec,
  }));
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out: TagInfo = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value;
    else if (key === 'type') out.type = value;
    else if (key === 'tag') out.tag = value;
    else if (key === 'tagger') out.tagger = value;
  }
  return out;
}

/** Follow tag objects to the object they ultimately name (a commit, for a version tag). */
export function peelFully(oid: string): string {
  let current = oid;
  const guard = new Set<string>();
  for (;;) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag' || guard.has(current)) return current;
    guard.add(current);
    current = parseTag(obj.data).object;
  }
}

/** The commit an object names (through tags), or null when it names none we hold. */
export function peelToCommit(oid: string): string | null {
  const target = peelFully(oid);
  const obj = objects.get(target);
  return obj !== undefined && obj.type === 'commit' ? target : null;
}

// ---------------------------------------------------------------------------
// Ancestry. Generations (a root is 0, a child is one more than its highest parent) are cached
// forever — objects are immutable — and prune every walk: a bench push's fast-forward check
// then costs a step or two instead of the whole chain.

const genCache = new Map<string, number>();

export function commitGen(oid: string): number {
  const cached = genCache.get(oid);
  if (cached !== undefined) return cached;
  // Iterative post-order walk so a 600-commit chain never grows the call stack.
  const stack: Array<{ oid: string; expanded: boolean }> = [{ oid, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { oid: string; expanded: boolean };
    if (genCache.has(frame.oid)) continue;
    const obj = objects.get(frame.oid);
    if (obj === undefined || obj.type !== 'commit') {
      genCache.set(frame.oid, -1);
      continue;
    }
    const commit = parseCommit(obj.data);
    if (!frame.expanded) {
      stack.push({ oid: frame.oid, expanded: true });
      for (const parent of commit.parents) {
        if (!genCache.has(parent)) stack.push({ oid: parent, expanded: false });
      }
      continue;
    }
    let gen = 0;
    for (const parent of commit.parents) {
      const parentGen = genCache.get(parent) ?? -1;
      if (parentGen + 1 > gen) gen = parentGen + 1;
    }
    genCache.set(frame.oid, gen);
  }
  return genCache.get(oid) ?? -1;
}

/** Every commit reachable from `tip` (inclusive), following parents. */
export function ancestorsOf(tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `tip` itself or one of its ancestors. */
export function isAncestor(ancestor: string, tip: string): boolean {
  if (ancestor === tip) return objects.get(tip)?.type === 'commit';
  const ancGen = commitGen(ancestor);
  const tipGen = commitGen(tip);
  if (ancGen < 0 || tipGen < 0 || ancGen >= tipGen) return false;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (commitGen(parent) >= ancGen) stack.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of two commits (the one with the highest generation), or null. */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return objects.get(a)?.type === 'commit' ? a : null;
  const ancestorsA = ancestorsOf(a);
  if (ancestorsA.size === 0) return null;
  let best: string | null = null;
  let bestGen = -1;
  const seen = new Set<string>();
  const stack = [b];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const gen = commitGen(oid);
    if (gen <= bestGen) continue;
    if (ancestorsA.has(oid)) {
      best = oid;
      bestGen = gen;
      continue; // ancestors of the best base are older bases; do not descend past it
    }
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return best;
}

/**
 * Every object reachable from the roots (commits -> trees + parents, trees -> entries, tags ->
 * target). When `holdParentsOf` names a commit, that commit is included but its parents are
 * not followed: the shape of "the client already holds this shallow boundary".
 */
export function closureFrom(roots: Iterable<string>, holdParentsOf?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (holdParentsOf === undefined || !holdParentsOf.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Flat trees: a commit's tree as a path -> {mode, oid} map, the algebra the contents API,
// pull-request diffs and three-way merges all work in.

export interface FlatEntry {
  mode: string;
  oid: string;
}

export function flattenTree(treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flat path map; returns the root tree id. */
export function treeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeTree(entries);
  };
  return build(root);
}

/** The tree a commit names, or null. */
export function commitTreeOid(commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** One path's entry in a tree (file or the subtree id when the path names a directory prefix). */
export function flatGet(flat: ReadonlyMap<string, FlatEntry>, path: string): FlatEntry | undefined {
  return flat.get(path);
}

/** Count the lines of a text the way diffs do: a trailing newline ends the last line. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** A text as its lines: a trailing newline terminates the last line rather than adding one. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Line-level diff counts between two texts (LCS over lines; files here are small). */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = linesOf(oldText);
  const b = linesOf(newText);
  if (a.length * b.length > 9_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS lengths over suffixes, one row at a time.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    curr[b.length] = 0;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      curr[j] = a[i] === b[j] ? (prev[j + 1] as number) + 1 : Math.max(prev[j] as number, curr[j + 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------------------
// Repository records and the social store (labels, issues, pull requests, comments). One repo
// record holds its refs; the objects behind them live in the shared pool above.

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  gid: number;
  body: string;
  authorLogin: string;
  createdSec: number;
  updatedSec: number;
}

export interface IssueRec {
  kind: 'issue';
  gid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  gid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSec: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRec[];
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  ownerLogin: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdSec: number;
  updatedSec: number;
  seq: number;
}

const repoByKey = new Map<string, RepoRec>();
const repoById = new Map<number, RepoRec>();
let repoIdCounter = 0;
let gidCounter = 0;
let seqCounter = 0;

export function nextGid(): number {
  gidCounter += 1;
  return gidCounter;
}

export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** A repository by owner + name. The owner must be the repository's own owner: the same name
 *  under another login does not exist here (the suite's foreign-owner reads must 404). */
export function findRepo(owner: string, name: string): RepoRec | undefined {
  const repo = repoByKey.get(repoKey(owner, name));
  if (repo === undefined) return undefined;
  return repo.ownerLogin.toLowerCase() === owner.toLowerCase() ? repo : undefined;
}

export function repoByNumericId(id: number): RepoRec | undefined {
  return repoById.get(id);
}

/** Every repository the viewer owns, in creation order. */
export function viewerRepos(): RepoRec[] {
  return [...repoById.values()].filter((repo) => repo.ownerLogin === VIEWER.login).sort((a, b) => a.seq - b.seq);
}

export function createRepoRec(name: string, options: { description?: string | null; isPrivate?: boolean }): RepoRec {
  const sec = clock.tick();
  repoIdCounter += 1;
  const repo: RepoRec = {
    id: repoIdCounter,
    ownerLogin: VIEWER.login,
    name,
    description: options.description ?? null,
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSec: sec,
    updatedSec: sec,
    seq: nextSeq(),
  };
  repoByKey.set(repoKey(repo.ownerLogin, repo.name), repo);
  repoById.set(repo.id, repo);
  return repo;
}

export function deleteRepoRec(repo: RepoRec): void {
  repoByKey.delete(repoKey(repo.ownerLogin, repo.name));
  repoById.delete(repo.id);
}

/** The branch name HEAD names in this repository (its default branch). */
export function headRefName(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** A branch's tip commit, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a REST `ref` query value (branch name, tag name or object id) to a commit id. */
export function resolveRefToCommit(repo: RepoRec, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return branchTip(repo, repo.defaultBranch);
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(tag);
  if (isOid(ref)) {
    const obj = objects.get(ref);
    if (obj !== undefined) return obj.type === 'commit' ? ref : peelToCommit(ref);
  }
  const anyRef = repo.refs.get(ref);
  if (anyRef !== undefined) return peelToCommit(anyRef) ?? anyRef;
  return null;
}

// ---------------------------------------------------------------------------
// Issues, pull requests, comments: the writes every surface shares.

export function createIssueRec(
  repo: RepoRec,
  fields: { title: string; body?: string; labels?: string[] },
): IssueRec {
  const sec = clock.tick();
  const issue: IssueRec = {
    kind: 'issue',
    gid: nextGid(),
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    labels: fields.labels ?? [],
    comments: [],
    createdSec: sec,
    updatedSec: sec,
    closedSec: null,
    seq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addCommentRec(repo: RepoRec, target: IssueRec | PullRec, body: string): CommentRec {
  const sec = clock.tick();
  const comment: CommentRec = {
    gid: nextGid(),
    body,
    authorLogin: VIEWER.login,
    createdSec: sec,
    updatedSec: sec,
  };
  target.comments.push(comment);
  return comment;
}

/** The issue or pull request a number names in this repo (numbers are shared, GitHub-style). */
export function issueOrPull(repo: RepoRec, number: number): IssueRec | PullRec | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

export interface PullCreateError {
  error: string;
}

/** Open a pull request between two branches of one repository (GitHub's validation rules). */
export function createPullRec(
  repo: RepoRec,
  fields: { title: string; body?: string; head: string; base: string },
): PullRec | PullCreateError {
  const head = fields.head.includes(':') ? (fields.head.split(':').pop() as string) : fields.head;
  const base = fields.base.includes(':') ? (fields.base.split(':').pop() as string) : fields.base;
  if (branchTip(repo, base) === null) return { error: `Invalid base branch: ${base}` };
  if (branchTip(repo, head) === null) return { error: `Invalid head branch: ${head}` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return { error: `A pull request already exists for ${head} into ${base}` };
    }
  }
  const sec = clock.tick();
  const pull: PullRec = {
    kind: 'pull',
    gid: nextGid(),
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    merged: false,
    mergedSec: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    comments: [],
    createdSec: sec,
    updatedSec: sec,
    closedSec: null,
    seq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

// ---------------------------------------------------------------------------
// Pull-request diffs and merges: file-level three-way merges over flat trees. The suite changes
// whole files per branch, so a file changed on both sides with different bytes is a conflict,
// exactly the verdict GitHub reaches for these histories.

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function blobText(oid: string | undefined): string {
  if (oid === undefined) return '';
  const obj = objects.get(oid);
  return obj !== undefined && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

/** The changed files of a pull request: its head tree against the merge-base tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(baseTip, headTip);
  const fromFlat = flattenTree(commitTreeOid(base));
  const toFlat = flattenTree(commitTreeOid(headTip));
  const changes: FileChange[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = fromFlat.get(path);
    const after = toFlat.get(path);
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    const counts = diffLineCounts(blobText(before?.oid), blobText(after?.oid));
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

interface MergeOutcome {
  tree: string | null;
  conflict: boolean;
}

/** Three-way merge of flat trees; a path both sides changed differently is a conflict. */
function mergeFlats(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const out = new Map<string, FlatEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const o = base.get(path);
    const a = ours.get(path);
    const b = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (same(a, b)) {
      if (a !== undefined) out.set(path, a);
    } else if (same(o, a)) {
      if (b !== undefined) out.set(path, b);
    } else if (same(o, b)) {
      if (a !== undefined) out.set(path, a);
    } else {
      return { tree: null, conflict: true };
    }
  }
  return { tree: treeFromFlat(out), conflict: false };
}

/** Would merging this pull request conflict against the current base tip? */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return true;
  const base = mergeBase(baseTip, headTip);
  const outcome = mergeFlats(
    flattenTree(commitTreeOid(base)),
    flattenTree(commitTreeOid(baseTip)),
    flattenTree(commitTreeOid(headTip)),
  );
  return outcome.conflict;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already' | 'missing' };

/** Merge a pull request into its base branch (squash or a true merge commit). */
export function mergePullRec(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): MergeResult {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'already' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing' };
  const base = mergeBase(baseTip, headTip);
  const outcome = mergeFlats(
    flattenTree(commitTreeOid(base)),
    flattenTree(commitTreeOid(baseTip)),
    flattenTree(commitTreeOid(headTip)),
  );
  if (outcome.conflict || outcome.tree === null) return { ok: false, reason: 'conflict' };
  const sec = clock.tick();
  let sha: string;
  if (method === 'merge') {
    sha = storeObject('commit', buildCommitData({
      tree: outcome.tree,
      parents: [baseTip, headTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      name: VIEWER.name,
      email: VIEWER.email,
      sec,
    }));
  } else {
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    sha = storeObject('commit', buildCommitData({
      tree: outcome.tree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})${body}`,
      name: VIEWER.name,
      email: VIEWER.email,
      sec,
    }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedSec = sec;
  pull.closedSec = sec;
  pull.updatedSec = sec;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Rename a repository in place: the record (and its id) survives; only the name key moves. */
export function renameRepoRec(repo: RepoRec, newName: string): void {
  repoByKey.delete(repoKey(repo.ownerLogin, repo.name));
  repo.name = newName;
  repoByKey.set(repoKey(repo.ownerLogin, repo.name), repo);
}

/** Every live repository record (insertion order). */
export function listAllRepos(): RepoRec[] {
  return [...repoById.values()];
}

/** A stored object parsed as a commit, or null when it is missing or not a commit. */
export function getCommit(oid: string): CommitInfo | null {
  const obj = getObject(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}
