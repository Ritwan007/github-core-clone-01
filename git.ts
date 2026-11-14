// git.ts — git smart HTTP: protocol v2 + v0 upload-pack (advertise, ls-refs, fetch) and v0
// receive-pack (push), implemented in-process over the object store in forge.ts. No git binary
// exists in the trial pod, so the packfile format — plain objects out, plain or delta objects
// in — is spoken here directly, with node:zlib doing the compression.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  branchTip,
  closureFrom,
  commitGen,
  findRepo,
  getObject,
  hashObject,
  headRefName,
  isAncestor,
  isOid,
  objects,
  parseCommit,
  parseTag,
  parseTree,
  peelFully,
  storeObject,
  type GitObj,
  type ObjType,
  type RepoRec,
} from './forge.ts';
import { readBody, sendBody, sendJson, type Ctx } from './http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// pkt-line framing: 4 hex digits of total length, then the payload; 0000 flush, 0001 delim,
// 0002 response-end. The largest legal packet is 65520 bytes including the header.

const PKT_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode pkt-lines from `start`; returns the packets and the offset just past them (a flush
 *  ends the sequence; trailing bytes — a push's packfile — are the caller's). */
export function decodePktLines(body: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, next: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** Decode every pkt-line section in a body (a v0 fetch has two: wants, then haves/done). */
export function decodeAllPktLines(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < body.length) {
    const { packets: section, next } = decodePktLines(body, offset);
    packets.push(...section);
    if (next <= offset) break;
    offset = next;
  }
  return packets;
}

/** The text lines of the data packets in a decoded sequence. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Packfiles. Writing is plain objects only (no deltas): legal everywhere, and the clients that
// read them — the suite's and real git's — resolve a plain pack trivially. Reading accepts
// plain, OFS_DELTA and REF_DELTA entries, because a real git push delta-compresses.

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack holding exactly `oids` (in the given order), trailer-checksummed. */
/** Pack bytes are a pure function of the ordered object list, and clone bursts ask for the
 *  same list dozens of times: memoize the last few packs instead of re-deflating per request. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_LIMIT = 16;

export function writePackCached(oids: readonly string[]): Buffer {
  const key = oids.join(' ');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(oids);
  if (packCache.size >= PACK_CACHE_LIMIT) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

export function writePack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, delta expects ${sourceSize}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy outside the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/** Read a packfile and store every object it carries; returns the object count. Throws on any
 *  structural problem or checksum mismatch, storing nothing it could not resolve. */
export function unpackPack(pack: Buffer): number {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== computed) throw new Error('pack checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header truncated');
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= trailerStart) throw new Error('pack entry size truncated');
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint too long');
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0), baseOffset: -1, baseOid: '' };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta base truncated');
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('ofs-delta base truncated');
        b = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes, inflated to ${inflated.buffer.length}`);
    }
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const memo = new Map<number, GitObj>();
  const resolvedByOid = new Map<string, GitObj>();
  const resolveEntry = (entry: RawPackEntry, seen: Set<number>): GitObj => {
    const hit = memo.get(entry.offset);
    if (hit !== undefined) return hit;
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let obj: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveEntry(baseEntry, seen);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      let base = resolvedByOid.get(entry.baseOid) ?? objects.get(entry.baseOid);
      if (base === undefined) {
        // The base may sit later in the pack: resolve candidates until one hashes to the base id.
        for (const candidate of raw) {
          if (candidate.offset === entry.offset) continue;
          try {
            const resolved = resolveEntry(candidate, new Set(seen));
            if (hashObject(resolved.type, resolved.data) === entry.baseOid) {
              base = resolved;
              break;
            }
          } catch {
            // Not this candidate; keep looking.
          }
        }
      }
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: CODE_TYPE[entry.typeCode] as ObjType, data: entry.data };
    }
    memo.set(entry.offset, obj);
    resolvedByOid.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  let count = 0;
  for (const entry of raw) {
    const obj = resolveEntry(entry, new Set());
    storeObject(obj.type, obj.data);
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Ref advertisements.

const AGENT = 'forge/1.0';

interface RefLine {
  name: string;
  oid: string;
}

/** Every ref the repo holds, name-sorted, tags after heads as git orders them. */
function sortedRefs(repo: RepoRec): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit a ref peels to (for annotated tags), when it differs from the ref's own target. */
function peeledOf(oid: string): string | null {
  const obj = objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const target = peelFully(oid);
  return target === oid ? null : target;
}

function uploadCaps(repo: RepoRec): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    `symref=HEAD:${headRefName(repo)}`,
    `agent=${AGENT}`,
  ].join(' ');
}

function receiveCaps(): string {
  return ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

/** A v0 advertisement: `# service=` preamble, then ref lines, the first carrying capabilities. */
function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTarget = headRefName(repo);
  const headOid = repo.refs.get(headTarget);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}`));
      const peeled = peeledOf(ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement upload-pack answers when Git-Protocol: version=2 arrives. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2).

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** One ls-refs answer line, or null when the ref must not be listed at all. */
function lsRefLine(repo: RepoRec, name: string, oid: string | null, args: LsRefsArgs): string | null {
  if (oid === null) {
    if (!args.unborn) return null;
    let line = `unborn ${name}`;
    if (name === 'HEAD' && args.symrefs) line += ` symref-target:${headRefName(repo)}`;
    return line;
  }
  let line = `${oid} ${name}`;
  if (name === 'HEAD' && args.symrefs) line += ` symref-target:${headRefName(repo)}`;
  if (args.peel) {
    const peeled = peeledOf(oid);
    if (peeled !== null) line += ` peeled:${peeled}`;
  }
  return line;
}

function handleLsRefs(repo: RepoRec, argLines: readonly string[]): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of argLines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = headRefName(repo);
  if (keep('HEAD')) {
    const line = lsRefLine(repo, 'HEAD', repo.refs.get(headTarget) ?? null, args);
    if (line !== null) parts.push(pktLine(line));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const target = objects.get(ref.oid);
    const line = lsRefLine(repo, ref.name, target === undefined ? null : ref.oid, args);
    if (line !== null) parts.push(pktLine(line));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch: what to send, planned once for both protocol versions.

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
  common: string[];
}

function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  // What the client provably holds: everything reachable from its haves, without descending
  // below the shallow boundary it declared (it does not hold those parents).
  const held = closureFrom(request.haves, new Set(request.clientShallow));
  const common = request.haves.filter((oid) => objects.get(oid)?.type === 'commit');

  // Distance (in parent edges, shortest path) of every commit reachable from the wants, plus
  // the tag objects met while peeling the wants to commits.
  const dist = new Map<string, number>();
  const wantedTags: string[] = [];
  const queue: string[] = [];
  for (const want of request.wants) {
    let current = want;
    const seenTags = new Set<string>();
    while (objects.get(current)?.type === 'tag' && !seenTags.has(current)) {
      seenTags.add(current);
      wantedTags.push(current);
      current = parseTag((objects.get(current) as GitObj).data).object;
    }
    if (objects.get(current)?.type === 'commit' && !dist.has(current)) {
      dist.set(current, 0);
      queue.push(current);
    }
  }
  const notOids = new Set<string>();
  for (const name of request.deepenNot) {
    const tip = branchTip(repo, name) ?? repo.refs.get(name);
    if (tip !== undefined && tip !== null) {
      for (const oid of closureFrom([tip])) notOids.add(oid);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    const commit = parseCommit((objects.get(oid) as GitObj).data);
    for (const parent of commit.parents) {
      if (!dist.has(parent) && objects.get(parent)?.type === 'commit') {
        dist.set(parent, (dist.get(oid) as number) + 1);
        queue.push(parent);
      }
    }
  }

  const depthLimit = request.depth === null ? Number.POSITIVE_INFINITY : request.depth;
  const included = new Set<string>();
  for (const [oid, d] of dist) {
    if (d >= depthLimit) continue;
    if (notOids.has(oid)) continue;
    if (request.deepenSince !== null) {
      const commit = parseCommit((objects.get(oid) as GitObj).data);
      if (commit.committerSec < request.deepenSince) continue;
    }
    included.add(oid);
  }
  // The shallow boundary: an included commit one of whose parents is not included.
  const boundary: string[] = [];
  if (request.depth !== null || request.deepenSince !== null) {
    for (const oid of included) {
      const commit = parseCommit((objects.get(oid) as GitObj).data);
      if (commit.parents.some((parent) => !included.has(parent) && !held.has(parent))) boundary.push(oid);
    }
  }
  // Former boundary commits the client un-shallows: their parents are in this pack now.
  const sendCommits = new Set<string>();
  for (const oid of included) if (!held.has(oid)) sendCommits.add(oid);
  const unshallow: string[] = [];
  for (const oid of request.clientShallow) {
    if (boundary.includes(oid)) continue;
    if (request.depth === null && included.has(oid)) {
      unshallow.push(oid);
      continue;
    }
    const commit = objects.get(oid)?.type === 'commit' ? parseCommit((objects.get(oid) as GitObj).data) : null;
    if (commit !== null && commit.parents.some((parent) => sendCommits.has(parent))) unshallow.push(oid);
  }

  // The send set: the new commits (with trees and blobs), the wanted tags, nothing held.
  const send = new Set<string>();
  const stack: string[] = [...sendCommits, ...wantedTags.filter((oid) => !held.has(oid))];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (send.has(oid) || held.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined) continue;
    send.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) if (included.has(parent)) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return { send: [...send], shallow: boundary, unshallow, common };
}

/** Wrap a pack in sideband band-1 packets (progress is never sent; the clients ask no-progress). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

// ---------------------------------------------------------------------------
// Fetch responses.

/** Parse the argument lines of a v2 fetch (and of a v0 request's two sections). */
function parseFetchArgs(lines: readonly string[], request: FetchRequest): void {
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) request.clientShallow.push(oid);
    } else if (line.startsWith('deepen-since ')) {
      const value = Number(line.slice('deepen-since '.length));
      if (Number.isFinite(value)) request.deepenSince = value;
    } else if (line.startsWith('deepen-not ')) {
      request.deepenNot.push(line.slice('deepen-not '.length).trim());
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice('deepen '.length));
      if (Number.isFinite(value) && value > 0) request.depth = Math.trunc(value);
    } else if (line === 'done') {
      request.done = true;
    }
  }
}

function emptyFetchRequest(): FetchRequest {
  return { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
}

function handleFetchV2(repo: RepoRec, argLines: readonly string[]): Buffer {
  const request = emptyFetchRequest();
  parseFetchArgs(argLines, request);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (!request.done) {
    // No `done` yet: real git negotiates in a single HTTP exchange, so the answer completes
    // the negotiation here — acknowledgments (common commits, else a NAK), the `ready`
    // marker, then the same shallow-info and packfile a `done` request would get.
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length > 0) {
      for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  // A client that sent `done` expects no acknowledgments section (real git rejects one):
  // the answer is shallow-info (when any) and then the packfile.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const part of sidebandPack(writePackCached(plan.send))) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: RepoRec, lines: readonly string[]): Buffer {
  const request = emptyFetchRequest();
  request.done = true;
  parseFetchArgs(lines, request);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.common.length > 0) {
    for (const oid of plan.common) parts.push(pktLine(`ACK ${oid} common\n`));
    parts.push(pktLine(`ACK ${plan.common[plan.common.length - 1] as string}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const part of sidebandPack(writePackCached(plan.send))) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack: parse the command list, unpack, validate each ref update on its own (a mixed
// push applies its fast-forward half), move the refs that pass, and report per ref.

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: RepoRec, body: Buffer): Buffer {
  const { packets, next } = decodePktLines(body, 0);
  const lines = packetLines(packets);
  if (lines.length === 0) throw new Error('receive-pack: empty command list');
  let clientCaps = new Set<string>();
  const commands: PushCommand[] = [];
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = new Set(line.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
        line = line.slice(0, nul);
      }
    }
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) throw new Error(`receive-pack: bad command line ${JSON.stringify(line.slice(0, 80))}`);
    const [oldOid, newOid, ref] = fields as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('receive-pack: bad object id in command');
    if (!ref.startsWith('refs/') || ref.length > 200) throw new Error(`receive-pack: bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  });

  const pack = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      unpackPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const wantsReport = clientCaps.has('report-status') || clientCaps.has('report-status-v2');
  const verdicts: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A delete. The branch HEAD names is protected, as git protects it.
      if (command.ref === headRefName(repo)) {
        verdicts.push({ ref: command.ref, ok: false, reason: 'deletion of the current branch prohibited' });
        continue;
      }
      repo.refs.delete(command.ref);
      verdicts.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = objects.get(command.newOid);
    if (target === undefined || (command.ref.startsWith('refs/heads/') && target.type !== 'commit')) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'bad object' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && !isAncestor(command.oldOid, command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    verdicts.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!wantsReport) return Buffer.alloc(0);
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const verdict of verdicts) {
    reportParts.push(pktLine(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!clientCaps.has('side-band-64k')) return report;
  // With side-band-64k the report stream itself rides in band 1, pkt-framed as it is.
  const wrapped: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
  }
  wrapped.push(PKT_FLUSH);
  return Buffer.concat(wrapped);
}

// ---------------------------------------------------------------------------
// The route handler app.ts delegates /{owner}/{repo}.git/* to.

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
): Promise<void> {
  if (!ctx.authed) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (tail === '/info/refs') {
    if (req.method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'Unknown service' });
      return;
    }
    const wantsV2 =
      service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendBody(res, 200, body, `application/x-${service}-advertisement`);
    return;
  }
  if (tail === '/git-upload-pack' || tail === '/git-receive-pack') {
    if (req.method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    try {
      if (tail === '/git-receive-pack') {
        const out = handleReceivePack(repo, body);
        sendBody(res, 200, out, 'application/x-git-receive-pack-result');
        return;
      }
      // upload-pack: a v2 request opens with a command section; anything else is a v0 request.
      const packets = decodeAllPktLines(body);
      const lines = packetLines(packets);
      const first = lines[0] ?? '';
      if (first.startsWith('command=')) {
        const command = first.slice('command='.length);
        // Split header lines (up to the delim) from argument lines (after it).
        const argLines: string[] = [];
        let pastDelim = false;
        let skippedCommand = false;
        for (const packet of packets) {
          if (packet.kind === 'delim') {
            pastDelim = true;
            continue;
          }
          if (packet.kind !== 'data') continue;
          if (!pastDelim) {
            if (!skippedCommand) skippedCommand = true;
            continue;
          }
          argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
        }
        if (command === 'ls-refs') {
          sendBody(res, 200, handleLsRefs(repo, argLines), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          sendBody(res, 200, handleFetchV2(repo, argLines), 'application/x-git-upload-pack-result');
          return;
        }
        sendJson(res, 400, { message: `Unknown command ${command}` });
        return;
      }
      sendBody(res, 200, handleFetchV0(repo, lines), 'application/x-git-upload-pack-result');
      return;
    } catch (err) {
      // A malformed body is a 400 and never a crash: the server must stay healthy afterwards.
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
      return;
    }
  }
  sendJson(res, 404, { message: 'Not Found' });
}
