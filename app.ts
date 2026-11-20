// github-core-clone-01: a standalone GitHub-compatible git forge.
// Node standard library only, no dependencies, no git binary, no network.
// Surfaces: git smart HTTP (v2 upload-pack, v0 receive-pack), REST v3 under
// /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp. All state is in memory.
//
// The token owner (the login MAKEFUN_SHOP_TOKEN names) is the seeded
// scenario viewer: adaiversen (id 1000). Every repository belongs to that
// login; any other owner reads as 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_NAME = 'github-core-clone';
const FORGE_VERSION = '1.0.0';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
// Deterministic clock: every timestamp derives from this counter, never the
// wall clock, so a live pass and a replay pass agree byte for byte.
let tickSec = 1735689600; // 2025-01-01T00:00:00Z
function nextTs(): number { tickSec += 1; return tickSec; }
function isoOf(ts: number): string { return new Date(ts * 1000).toISOString(); }
function nowIso(): string { return isoOf(nextTs()); }

// ---------------------------------------------------------------- small utils

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
function isOid(v: string): boolean { return /^[0-9a-f]{40}$/.test(v); }
function b64encode(text: string): string { return Buffer.from(text, 'utf8').toString('base64'); }
function b64decode(s: string): string { return Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8'); }
function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

let reqCounter = 0;
function nextReqId(): string { reqCounter += 1; return `req-${reqCounter}`; }

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const out: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': nextReqId(), ...headers };
  if (status !== 204) out['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, out);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': nextReqId(), ...headers });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, dflt = ''): string { return typeof v === 'string' ? v : dflt; }
function num(v: unknown, dflt = 0): number { return typeof v === 'number' && Number.isFinite(v) ? v : dflt; }
function bool(v: unknown, dflt = false): boolean { return typeof v === 'boolean' ? v : dflt; }
function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice('Bearer '.length);
  if (tok === '') return false;
  if (TOKEN === '') return true; // no token configured locally: accept any non-empty bearer
  return tok === TOKEN;
}
function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

// ---------------------------------------------------------------- git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
function treeSortKey(e: TreeEntry): string { return e.mode === '40000' ? `${e.name}/` : e.name; }
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; raw: Buffer }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(out, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger };
}

// ---------------------------------------------------------------- pkt-line

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') { packets.push({ kind: 'flush' }); i += 4; continue; }
    if (head === '0001') { packets.push({ kind: 'delim' }); i += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'response-end' }); i += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
}

// ---------------------------------------------------------------- packfiles

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const t = typeNum[type];
  const bytes: number[] = [];
  let s = size;
  let first = (t << 4) | (s & 15);
  s >>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readVarint(buf: Buffer, start: number): { size: number; next: number; type: number } {
  let i = start;
  const b0 = buf[i] ?? 0;
  const type = (b0 >> 4) & 7;
  let size = b0 & 15;
  let shift = 4;
  i += 1;
  while ((buf[i - 1] ?? 0) & 0x80) {
    const b = buf[i] ?? 0;
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { size, next: i, type };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0; let shift = 0;
    for (;;) {
      const b = delta[i] ?? 0; i += 1;
      v |= (b & 0x7f) << shift; shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i] ?? 0; i += 1;
    if (op & 0x80) {
      let off = 0; let len = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { off |= (delta[i] ?? 0) << (8 * bit); i += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { len |= (delta[i] ?? 0) << (8 * bit); i += 1; }
      if (len === 0) len = 0x10000;
      out.push(base.subarray(off, off + len));
      total += len;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else throw new Error('delta opcode 0');
  }
  const res = Buffer.concat(out);
  if (total !== dstSize || res.length !== dstSize) throw new Error('delta size mismatch');
  return res;
}
const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1(pack.subarray(0, pack.length - 20));
  if (expected !== actual) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const { next, type } = readVarint(pack, off);
    off = next;
    if (type === 6 || type === 7) {
      let baseObj: GitObject | undefined;
      if (type === 6) {
        let b = pack[off] ?? 0; off += 1;
        let baseOff = b & 0x7f;
        while (b & 0x80) { b = pack[off] ?? 0; off += 1; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
        baseObj = byOffset.get(start - baseOff);
        if (!baseObj) throw new Error('ofs-delta base missing');
      } else {
        const baseOid = pack.subarray(off, off + 20).toString('hex');
        off += 20;
        baseObj = objects.get(baseOid) ?? (resolveBase ? resolveBase(baseOid) : undefined);
        if (!baseObj) throw new Error('ref-delta base missing');
      }
      const { data: delta, next: after } = inflateAt(pack, off);
      off = after;
      const data = applyDelta(baseObj.data, delta);
      const obj: GitObject = { type: baseObj.type, data };
      objects.set(hashObject(obj.type, data), obj);
      byOffset.set(start, obj);
      continue;
    }
    const objType = PACK_TYPES[type];
    if (!objType) throw new Error(`unknown pack object type ${type}`);
    const { data, next: after } = inflateAt(pack, off);
    off = after;
    const oid = hashObject(objType, data);
    const obj: GitObject = { type: objType, data };
    objects.set(oid, obj);
    byOffset.set(start, obj);
  }
  return objects;
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // Inflate the zlib stream starting at offset. inflateSync ignores trailing bytes, so
  // "inflates cleanly" is monotonic in the slice end: the smallest end that inflates is
  // exactly the stream's end. Binary-search it.
  const tryInflate = (end: number): Buffer | null => {
    try { return inflateSync(buf.subarray(offset, end)); } catch { return null; }
  };
  if (tryInflate(buf.length) === null) throw new Error('corrupt zlib stream in pack');
  let lo = offset + 2;
  let hi = buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryInflate(mid) !== null) hi = mid; else lo = mid + 1;
  }
  const data = tryInflate(lo);
  if (data === null) throw new Error('corrupt zlib stream in pack');
  return { data, next: lo };
}

// ---------------------------------------------------------------- store

interface Label { id: number; name: string; color: string; description: string }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; createdTs: number; updatedTs: number; closedTs: number | null;
  comments: Comment[];
}
interface Comment { id: number; body: string; createdTs: number; updatedTs: number }
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  createdTs: number; updatedTs: number; changedFiles: { path: string; status: string; additions: number; deletions: number }[];
}
interface Repo {
  id: number; seq: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdTs: number; updatedTs: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[]; pulls: Pull[]; labels: Label[];
  nextNumber: number; nextCommentId: number; nextLabelId: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 1000;
let nextRepoSeq = 0;
let nextGlobalId = 100000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const ts = nextTs();
  const repo: Repo = {
    id: nextRepoId, seq: nextRepoSeq, name, owner: VIEWER_LOGIN, description,
    private: isPrivate, defaultBranch: 'main', createdTs: ts, updatedTs: ts,
    refs: new Map(), objects: new Map(), issues: [], pulls: [], labels: [],
    nextNumber: 1, nextCommentId: 1, nextLabelId: 1,
  };
  nextRepoId += 1; nextRepoSeq += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function gid(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64').replace(/=+$/, '');
}
function repoGid(repo: Repo): string { return gid('Repository', String(repo.id)); }
function issueGid(repo: Repo, issue: Issue): string { return gid('Issue', `${repo.id}:${issue.number}`); }
function pullGid(repo: Repo, pull: Pull): string { return gid('PullRequest', `${repo.id}:${pull.number}`); }
function commentGid(repo: Repo, issue: Issue, c: Comment): string { return gid('IssueComment', `${repo.id}:${issue.number}:${c.id}`); }
function decodeGid(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch { return null; }
}
function findRepoById(dbid: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === dbid) return r;
  return undefined;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Issue') return null;
  const [rid, n] = d.rest.split(':');
  const repo = findRepoById(Number(rid));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number(n));
  return issue ? { repo, issue } : null;
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
  const d = decodeGid(id);
  if (!d || d.kind !== 'PullRequest') return null;
  const [rid, n] = d.rest.split(':');
  const repo = findRepoById(Number(rid));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number(n));
  return pull ? { repo, pull } : null;
}

// Resolve a ref name, branch name or oid to a commit oid (or undefined).
function resolveCommit(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) {
    const o = repo.objects.get(ref);
    if (!o) return undefined;
    if (o.type === 'commit') return ref;
    if (o.type === 'tag') return resolveTagTarget(repo, ref);
    return undefined;
  }
  const direct = repo.refs.get(ref);
  if (direct) return resolveToCommit(repo, direct);
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head) return resolveToCommit(repo, head);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return resolveToCommit(repo, tag);
  return undefined;
}
function resolveToCommit(repo: Repo, oid: string): string | undefined {
  const o = repo.objects.get(oid);
  if (!o) return undefined;
  if (o.type === 'commit') return oid;
  if (o.type === 'tag') return resolveTagTarget(repo, oid);
  return undefined;
}
function resolveTagTarget(repo: Repo, tagOid: string): string | undefined {
  const o = repo.objects.get(tagOid);
  if (!o || o.type !== 'tag') return undefined;
  const t = parseTag(o.data);
  const target = repo.objects.get(t.object);
  if (!target) return undefined;
  if (target.type === 'commit') return t.object;
  if (target.type === 'tag') return resolveTagTarget(repo, t.object);
  return undefined;
}
function peelToCommit(repo: Repo, oid: string): string | undefined {
  const o = repo.objects.get(oid);
  if (!o) return undefined;
  if (o.type === 'commit') return oid;
  if (o.type === 'tag') return resolveTagTarget(repo, oid);
  return undefined;
}
function commitOf(repo: Repo, oid: string): CommitView | undefined {
  const o = repo.objects.get(oid);
  if (!o || o.type !== 'commit') return undefined;
  return parseCommit(o.data);
}
// All objects reachable from the given oids (commits, tags, trees, blobs).
function reachable(repo: Repo, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    seen.add(oid);
    if (o.type === 'commit') {
      const c = parseCommit(o.data);
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data)) stack.push(e.oid);
    } else if (o.type === 'tag') {
      stack.push(parseTag(o.data).object);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = commitOf(repo, cur);
    if (!c) continue;
    for (const p of c.parents) stack.push(p);
  }
  return false;
}
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    const c = commitOf(repo, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  const seen = new Set<string>();
  const q = [b];
  while (q.length > 0) {
    const cur = q.shift() as string;
    if (ancA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = commitOf(repo, cur);
    if (c) for (const p of c.parents) q.push(p);
  }
  return undefined;
}
// Flatten a commit's tree to path -> {oid, mode}.
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'tree') return;
    for (const e of parseTree(o.data)) {
      const path = pre === '' ? e.name : `${pre}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
// Build (and store) tree objects from a flat path map; returns the root tree oid.
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const buildDir = (paths: string[]): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, string[]>();
    const files: { name: string; oid: string; mode: string }[] = [];
    for (const p of paths) {
      const slash = p.indexOf('/');
      if (slash < 0) {
        const f = flat.get(p);
        if (f) files.push({ name: p, oid: f.oid, mode: f.mode });
      } else {
        const dir = p.slice(0, slash);
        const rest = p.slice(slash + 1);
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir)?.push(rest);
      }
    }
    for (const f of files) entries.push({ mode: f.mode, name: f.name, oid: f.oid });
    for (const [dir, sub] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      // Rebuild sub-paths with the directory prefix for recursion.
      const subFlat = new Map<string, { oid: string; mode: string }>();
      for (const p of paths) {
        if (p.startsWith(`${dir}/`)) subFlat.set(p.slice(dir.length + 1), flat.get(p) as { oid: string; mode: string });
      }
      void sub;
      const subOid = buildTreeFromFlatMap(repo, subFlat);
      entries.push({ mode: '40000', name: dir, oid: subOid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildDir([...flat.keys()]);
}
function buildTreeFromFlatMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  const entries: TreeEntry[] = [];
  const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
  for (const [p, f] of flat) {
    const slash = p.indexOf('/');
    if (slash < 0) entries.push({ mode: f.mode, name: p, oid: f.oid });
    else {
      const dir = p.slice(0, slash);
      const rest = p.slice(slash + 1);
      if (!subdirs.has(dir)) subdirs.set(dir, new Map());
      subdirs.get(dir)?.set(rest, f);
    }
  }
  for (const [dir, sub] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    entries.push({ mode: '40000', name: dir, oid: buildTreeFromFlatMap(repo, sub) });
  }
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
// Create a commit on a branch from a flat file map; returns the commit oid.
function commitFiles(repo: Repo, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string, parentOverride?: string | null): string {
  const treeOid = buildTreeFromFlatMap(repo, flat);
  const ts = nextTs();
  const parents: string[] = [];
  if (parentOverride === undefined) {
    const cur = repo.refs.get(`refs/heads/${branch}`);
    if (cur) parents.push(cur);
  } else if (parentOverride !== null) {
    parents.push(parentOverride);
  }
  const data = buildCommit(treeOid, parents, message, ts);
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}
// Three-way merge of flat trees. Returns null on conflict.
function threeWayMerge(base: Map<string, { oid: string; mode: string }>, ours: Map<string, { oid: string; mode: string }>, theirs: Map<string, { oid: string; mode: string }>): Map<string, { oid: string; mode: string }> | null {
  const out = new Map<string, { oid: string; mode: string }>(ours);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const p of paths) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(o, t)) continue;
    if (same(b, o)) { if (t) out.set(p, t); else out.delete(p); continue; }
    if (same(b, t)) continue;
    return null;
  }
  return out;
}
function diffFiles(base: Map<string, { oid: string; mode: string }>, head: Map<string, { oid: string; mode: string }>, repo: Repo): { path: string; status: string; additions: number; deletions: number }[] {
  const out: { path: string; status: string; additions: number; deletions: number }[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const lines = blobLines(repo, b.oid);
      out.push({ path: p, status: 'removed', additions: 0, deletions: lines });
    } else if (!b && h) {
      const lines = blobLines(repo, h.oid);
      out.push({ path: p, status: 'added', additions: Math.max(1, lines), deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldLines = blobText(repo, b.oid).split('\n');
      const newLines = blobText(repo, h.oid).split('\n');
      const oldSet = new Map<string, number>();
      for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
      let additions = 0;
      for (const l of newLines) {
        const c = oldSet.get(l) ?? 0;
        if (c > 0) oldSet.set(l, c - 1); else additions += 1;
      }
      const newSet = new Map<string, number>();
      for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1);
      let deletions = 0;
      for (const l of oldLines) {
        const c = newSet.get(l) ?? 0;
        if (c > 0) newSet.set(l, c - 1); else deletions += 1;
      }
      if (additions === 0 && deletions === 0) { additions = 1; }
      out.push({ path: p, status: 'modified', additions, deletions });
    }
  }
  return out;
}
function blobText(repo: Repo, oid: string): string {
  const o = repo.objects.get(oid);
  if (!o || o.type !== 'blob') return '';
  return o.data.toString('utf8');
}
function blobLines(repo: Repo, oid: string): number {
  const t = blobText(repo, oid);
  if (t === '') return 0;
  return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
}
function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// ---------------------------------------------------------------- REST views

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', String(VIEWER_ID)),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '', url: '/api/v3/users/adaiversen', html_url: 'https://github.com/adaiversen',
    type: 'User', site_admin: false, name: VIEWER_NAME, company: null, blog: '',
    location: null, email: VIEWER_EMAIL, hireable: null, bio: null,
    public_repos: repos.size, public_gists: 0, followers: 0, following: 0,
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
  };
}
function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id, node_id: repoGid(repo), name: repo.name, full_name: full,
    private: repo.private, owner: { login: repo.owner, id: VIEWER_ID, node_id: gid('User', String(VIEWER_ID)), type: 'User', site_admin: false },
    html_url: `https://github.com/${full}`, description: repo.description, fork: false,
    url: `/api/v3/repos/${full}`, created_at: isoOf(repo.createdTs), updated_at: isoOf(repo.updatedTs),
    pushed_at: isoOf(repo.updatedTs), git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`, clone_url: `https://github.com/${full}.git`,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, mirror_url: null, archived: false, disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    license: null, allow_forking: true, is_template: false, web_commit_signoff_required: false,
    topics: [], visibility: repo.private ? 'private' : 'public', forks: 0, open_issues: 0,
    watchers: 0, default_branch: repo.defaultBranch,
  };
}
function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid('Label', String(l.id)), name: l.name, color: l.color, description: l.description, default: false };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issueGid(repo, issue), number: issue.number, title: issue.title,
    body: issue.body, state: issue.state, locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map(labelJson),
    assignee: null, assignees: [], milestone: null, comments: issue.comments.length,
    created_at: isoOf(issue.createdTs), updated_at: isoOf(issue.updatedTs),
    closed_at: issue.closedTs === null ? null : isoOf(issue.closedTs),
    author_association: 'OWNER', url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = pull.headSha;
  const baseSha = pull.baseSha;
  return {
    id: pull.id, node_id: pullGid(repo, pull), number: pull.number, title: pull.title,
    body: pull.body, state: pull.state, locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [], assignee: null, assignees: [], milestone: null,
    created_at: isoOf(pull.createdTs), updated_at: isoOf(pull.updatedTs),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedTs) : null,
    merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha, merged: pull.merged,
    mergeable: prMergeable(repo, pull) === 'MERGEABLE', mergeable_state: prMergeable(repo, pull).toLowerCase(),
    draft: false, commits: pullCommitsCount(repo, pull), additions: pull.changedFiles.reduce((a, f) => a + f.additions, 0),
    deletions: pull.changedFiles.reduce((a, f) => a + f.deletions, 0),
    changed_files: pull.changedFiles.length,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    author_association: 'OWNER',
  };
}
function pullCommitsCount(repo: Repo, pull: Pull): number {
  const head = resolveCommit(repo, pull.headSha);
  const base = resolveCommit(repo, pull.baseSha);
  if (!head || !base) return 0;
  const mb = mergeBase(repo, head, base);
  let n = 0;
  const seen = new Set<string>();
  const stack = [head];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur) || cur === mb) continue;
    seen.add(cur); n += 1;
    const c = commitOf(repo, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return n;
}
function computeChangedFiles(repo: Repo, pull: Pull): void {
  const head = resolveCommit(repo, pull.headSha);
  const base = resolveCommit(repo, pull.baseSha);
  if (!head || !base) { pull.changedFiles = []; return; }
  const mb = mergeBase(repo, head, base) ?? base;
  const mbCommit = commitOf(repo, mb);
  const headCommit = commitOf(repo, head);
  if (!mbCommit || !headCommit) { pull.changedFiles = []; return; }
  const baseFlat = flattenTree(repo, mbCommit.tree);
  const headFlat = flattenTree(repo, headCommit.tree);
  pull.changedFiles = diffFiles(baseFlat, headFlat, repo);
}
function prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return pull.merged ? 'MERGEABLE' : 'UNKNOWN';
  const head = resolveCommit(repo, pull.headSha);
  const base = resolveCommit(repo, pull.baseSha);
  if (!head || !base) return 'UNKNOWN';
  const mb = mergeBase(repo, head, base);
  if (!mb) return 'UNKNOWN';
  const mbC = commitOf(repo, mb); const headC = commitOf(repo, head); const baseC = commitOf(repo, base);
  if (!mbC || !headC || !baseC) return 'UNKNOWN';
  const merged = threeWayMerge(flattenTree(repo, mbC.tree), flattenTree(repo, baseC.tree), flattenTree(repo, headC.tree));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}
function doSquashMerge(repo: Repo, pull: Pull): { ok: boolean; sha?: string; reason?: string } {
  const head = resolveCommit(repo, pull.headSha);
  const base = resolveCommit(repo, pull.baseSha);
  if (!head || !base) return { ok: false, reason: 'head or base commit not found' };
  const mb = mergeBase(repo, head, base);
  if (!mb) return { ok: false, reason: 'no merge base' };
  const mbC = commitOf(repo, mb); const headC = commitOf(repo, head); const baseC = commitOf(repo, base);
  if (!mbC || !headC || !baseC) return { ok: false, reason: 'commit not found' };
  const merged = threeWayMerge(flattenTree(repo, mbC.tree), flattenTree(repo, baseC.tree), flattenTree(repo, headC.tree));
  if (merged === null) return { ok: false, reason: 'merge conflict' };
  const treeOid = buildTreeFromFlatMap(repo, merged);
  const ts = nextTs();
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const data = buildCommit(treeOid, [base], message, ts);
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(ts);
  pull.mergeCommitSha = sha;
  pull.updatedTs = ts;
  repo.updatedTs = ts;
  return { ok: true, sha };
}
function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, num(Number(q.get('per_page')), 30) || 30));
  const pageNum = Math.max(1, num(Number(q.get('page')), 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}
function linkHeader(req: IncomingMessage, q: URLSearchParams, pageNum: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (pageNum >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${pathOf(req)}`;
  const mk = (p: number): string => {
    const nq = new URLSearchParams(q);
    nq.set('page', String(p));
    nq.set('per_page', String(perPage));
    return `${base}?${nq.toString()}`;
  };
  const parts = [`<${mk(pageNum + 1)}>; rel="next"`, `<${mk(totalPages)}>; rel="last"`];
  if (pageNum > 1) parts.push(`<${mk(1)}>; rel="first"`, `<${mk(pageNum - 1)}>; rel="prev"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- REST router

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  // JSON body parse (malformed JSON is 400) — parsed before auth so the
  // malformed-body check answers 400 either way.
  let body: unknown = undefined;
  let bodyPresent = false;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return true; }
    body = parsed.value;
    bodyPresent = true;
  }
  void bodyPresent;
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const seg = path.slice('/api/v3'.length).split('/').filter((s) => s !== '');
  const rest = path.slice('/api/v3'.length);
  // API root
  if ((rest === '' || rest === '/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest === '/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }
  if (rest === '/rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600 + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600 + 3600, used: 1 } });
    return true;
  }
  if (rest === '/user' && method === 'GET') { sendJson(res, 200, userJson()); return true; }
  // POST /user/repos
  if (rest === '/user/repos' && method === 'POST') {
    if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
    const name = str(body.name);
    if (name === '') { errJson(res, 422, 'Validation Failed: name is required'); return true; }
    if (repos.has(repoKey(VIEWER_LOGIN, name))) { errJson(res, 422, 'Repository creation failed. name already exists on this account'); return true; }
    const repo = createRepoRecord(name, str(body.description), bool(body.private, false));
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    sendJson(res, 201, repoJson(repo, ''));
    return true;
  }
  // GET /user/repos
  if (rest === '/user/repos' && method === 'GET') {
    const all = [...repos.values()].sort((a, b) => a.seq - b.seq);
    const { page, total, pageNum, perPage } = paginate(all, q);
    const headers: Record<string, string> = {};
    const link = linkHeader(req, q, pageNum, perPage, total);
    if (link) headers.link = link;
    sendJson(res, 200, page.map((r) => repoJson(r, '')), headers);
    return true;
  }
  // /repos/{owner}/{repo}[...]
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = decodePath(seg[1] as string);
    const name = decodePath(seg[2] as string);
    const repo = getRepo(owner, name);
    if (!repo) { errJson(res, 404, 'Not Found'); return true; }
    const tail = seg.slice(3);
    // GET /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo, '')); return true; }
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
          if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
          repo.updatedTs = nextTs();
        }
        sendJson(res, 200, repoJson(repo, ''));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextReqId(), 'content-type': JSON_TYPE });
        res.end();
        return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
        list.sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, list); return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodePath(tail[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false }); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed'); return true; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const list = [...repo.refs.entries()].map(([r, sha]) => ({ ref: r, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        sendJson(res, 200, list); return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).map(decodePath).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // commits
    if (tail[0] === 'commits' && method === 'GET') {
      const refParam = q.get('sha') ?? repo.defaultBranch;
      const tip = resolveCommit(repo, refParam);
      const list: Record<string, unknown>[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        const ordered: string[] = [];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          if (seen.has(cur)) continue;
          seen.add(cur);
          ordered.push(cur);
          const c = commitOf(repo, cur);
          if (c) for (const p of c.parents) stack.push(p);
        }
        for (const oid of ordered) {
          const c = commitOf(repo, oid);
          if (!c) continue;
          list.push({ sha: oid, node_id: gid('Commit', oid), commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.createdTs) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.createdTs) } }, author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, parents: c.parents.map((p) => ({ sha: p })) });
        }
      }
      sendJson(res, 200, list); return true;
    }
    // contents
    if (tail[0] === 'contents') {
      return handleContents(req, res, repo, tail.slice(1), q, body, method);
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) { sendJson(res, 200, repo.labels.map(labelJson)); return true; }
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(body) || str(body.name) === '') { errJson(res, 422, 'Validation Failed'); return true; }
        const existing = repo.labels.find((l) => l.name === str(body.name));
        if (existing) { sendJson(res, 201, labelJson(existing)); return true; }
        const label: Label = { id: nextGlobalId, name: str(body.name), color: str(body.color, 'ededed'), description: str(body.description) };
        nextGlobalId += 1;
        repo.labels.push(label);
        sendJson(res, 201, labelJson(label)); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // issues
    if (tail[0] === 'issues') {
      return handleIssues(req, res, repo, tail.slice(1), q, body, method);
    }
    // pulls
    if (tail[0] === 'pulls') {
      return handlePulls(req, res, repo, tail.slice(1), q, body, method);
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  errJson(res, 404, 'Not Found');
  return true;
}

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, parts: string[], q: URLSearchParams, body: unknown, method: string): Promise<boolean> {
  const filePath = parts.map(decodePath).join('/');
  const refParam = q.get('ref') ?? undefined;
  const branchFor = (b: string | undefined): string => {
    if (!b) return repo.defaultBranch;
    if (b.startsWith('refs/heads/')) return b.slice('refs/heads/'.length);
    return b;
  };
  if (method === 'GET') {
    const tip = refParam ? resolveCommit(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) { errJson(res, 404, 'Not Found'); return true; }
    const commit = commitOf(repo, tip);
    if (!commit) { errJson(res, 404, 'Not Found'); return true; }
    const flat = flattenTree(repo, commit.tree);
    if (filePath === '') {
      const entries = dirListing(repo, commit.tree, '');
      sendJson(res, 200, entries); return true;
    }
    const file = flat.get(filePath);
    if (file) {
      const blob = repo.objects.get(file.oid);
      const content = blob ? blob.data.toString('base64') : '';
      sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0, name: filePath.split('/').pop(), path: filePath, content, sha: file.oid, url: '', html_url: '', git_url: '', download_url: '' });
      return true;
    }
    // directory?
    const prefix = `${filePath}/`;
    const names = new Set<string>();
    for (const p of flat.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] as string);
    if (names.size > 0) {
      const entries = dirListing(repo, commit.tree, filePath);
      sendJson(res, 200, entries); return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  if (method === 'PUT') {
    if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
    const message = str(body.message, 'Update file');
    const contentB64 = str(body.content);
    if (contentB64 === '') { errJson(res, 422, 'Validation Failed: content is required'); return true; }
    let contentBuf: Buffer;
    try { contentBuf = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); } catch { errJson(res, 422, 'Validation Failed'); return true; }
    const branch = branchFor(typeof body.branch === 'string' ? body.branch : undefined);
    const branchRef = `refs/heads/${branch}`;
    let tip = repo.refs.get(branchRef);
    if (!tip && branch !== repo.defaultBranch) {
      // Branching from the default branch, like GitHub's contents API.
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const baseCommit = tip ? commitOf(repo, tip) : undefined;
    const flat = baseCommit ? flattenTree(repo, baseCommit.tree) : new Map<string, { oid: string; mode: string }>();
    const existing = flat.get(filePath);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      const givenSha = str(body.sha);
      if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) { errJson(res, 409, 'Conflict: sha does not match'); return true; }
    }
    const blobOid = storeObject(repo, 'blob', contentBuf);
    flat.set(filePath, { oid: blobOid, mode: '100644' });
    const parent = tip ?? null;
    const commitSha = commitFiles(repo, branch, flat, message, parent === null ? null : parent);
    repo.updatedTs = nextTs();
    sendJson(res, isUpdate ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: contentBuf.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64' }, commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.updatedTs) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoOf(repo.updatedTs) } } });
    return true;
  }
  if (method === 'DELETE') {
    if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
    const branch = branchFor(typeof body.branch === 'string' ? body.branch : undefined);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) { errJson(res, 404, 'Not Found'); return true; }
    const commit = commitOf(repo, tip);
    if (!commit) { errJson(res, 404, 'Not Found'); return true; }
    const flat = flattenTree(repo, commit.tree);
    const existing = flat.get(filePath);
    if (!existing) { errJson(res, 404, 'Not Found'); return true; }
    const givenSha = str(body.sha);
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid.toLowerCase()) { errJson(res, 409, 'Conflict: sha does not match'); return true; }
    flat.delete(filePath);
    const message = str(body.message, 'Delete file');
    const commitSha = commitFiles(repo, branch, flat, message, tip);
    repo.updatedTs = nextTs();
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return true;
  }
  errJson(res, 404, 'Not Found'); return true;
}
function dirListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  // Walk to the subtree for dirPath, then list its immediate entries.
  let current = treeOid;
  if (dirPath !== '') {
    for (const seg of dirPath.split('/')) {
      const o = repo.objects.get(current);
      if (!o || o.type !== 'tree') return [];
      const entry = parseTree(o.data).find((e) => e.name === seg && e.mode === '40000');
      if (!entry) return [];
      current = entry.oid;
    }
  }
  const o = repo.objects.get(current);
  if (!o || o.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const e of parseTree(o.data)) {
    const isDir = e.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(e.oid);
    out.push({
      type: isDir ? 'dir' : 'file', size: isDir ? 0 : (blob ? blob.data.length : 0),
      name: e.name, path: dirPath === '' ? e.name : `${dirPath}/${e.name}`, sha: e.oid,
      url: '', html_url: '', git_url: '', download_url: isDir ? null : '',
    });
  }
  return out;
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], q: URLSearchParams, body: unknown, method: string): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
      const title = str(body.title);
      if (title === '') { errJson(res, 422, 'Validation Failed: title is required'); return true; }
      const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l: unknown) => (typeof l === 'string' ? l : isRecord(l) ? str(l.name) : '')).filter((s: string) => s !== '') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const found = repo.labels.find((l) => l.name === name);
        if (!found) { errJson(res, 422, `Validation Failed: label "${name}" does not exist`); return true; }
        labels.push(found);
      }
      const ts = nextTs();
      const issue: Issue = { id: nextGlobalId, number: repo.nextNumber, title, body: str(body.body), state: 'open', labels, createdTs: ts, updatedTs: ts, closedTs: null, comments: [] };
      nextGlobalId += 1; repo.nextNumber += 1;
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue)); return true;
    }
    if (method === 'GET') {
      let list = [...repo.issues];
      const state = q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const sort = q.get('sort') ?? 'created';
      const direction = q.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, total, pageNum, perPage } = paginate(list, q);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, q, pageNum, perPage, total);
      if (link) headers.link = link;
      sendJson(res, 200, page.map((i) => issueJson(repo, i)), headers); return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number)) { errJson(res, 404, 'Not Found'); return true; }
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) { errJson(res, 404, 'Not Found'); return true; }
  if (tail.length === 1) {
    if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.closedTs = body.state === 'closed' ? nextTs() : null;
        }
        issue.updatedTs = nextTs();
      }
      sendJson(res, 200, issueJson(repo, issue)); return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  if (tail[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: commentGid(repo, issue, c), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: isoOf(c.createdTs), updated_at: isoOf(c.updatedTs), url: '' })));
      return true;
    }
    if (method === 'POST') {
      if (!isRecord(body) || str(body.body) === '') { errJson(res, 422, 'Validation Failed'); return true; }
      const ts = nextTs();
      const comment: Comment = { id: repo.nextCommentId, body: str(body.body), createdTs: ts, updatedTs: ts };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updatedTs = ts;
      sendJson(res, 201, { id: comment.id, node_id: commentGid(repo, issue, comment), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: isoOf(ts), updated_at: isoOf(ts), url: '' });
      return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  errJson(res, 404, 'Not Found'); return true;
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], q: URLSearchParams, body: unknown, method: string): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body)) { errJson(res, 422, 'Validation Failed'); return true; }
      const head = str(body.head);
      const base = str(body.base);
      const title = str(body.title);
      if (head === '' || base === '' || title === '') { errJson(res, 422, 'Validation Failed'); return true; }
      const headSha = resolveCommit(repo, head);
      const baseSha = resolveCommit(repo, base);
      if (!headSha || !baseSha) { errJson(res, 422, 'Validation Failed: head or base branch not found'); return true; }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) { errJson(res, 422, 'Validation Failed: a pull request already exists for this head branch'); return true; }
      const ts = nextTs();
      const pull: Pull = { id: nextGlobalId, number: repo.nextNumber, title, body: str(body.body), state: 'open', headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdTs: ts, updatedTs: ts, changedFiles: [] };
      nextGlobalId += 1; repo.nextNumber += 1;
      computeChangedFiles(repo, pull);
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull)); return true;
    }
    if (method === 'GET') {
      let list = [...repo.pulls];
      const state = q.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, total, pageNum, perPage } = paginate(list, q);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, q, pageNum, perPage, total);
      if (link) headers.link = link;
      sendJson(res, 200, page.map((p) => pullJson(repo, p)), headers); return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number)) { errJson(res, 404, 'Not Found'); return true; }
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) { errJson(res, 404, 'Not Found'); return true; }
  if (tail.length === 1) {
    if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
    errJson(res, 404, 'Not Found'); return true;
  }
  if (tail[1] === 'files' && method === 'GET') {
    computeChangedFiles(repo, pull);
    sendJson(res, 200, pull.changedFiles.map((f) => ({ sha: '', filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, blob_url: '', raw_url: '', contents_url: '' })));
    return true;
  }
  if (tail[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') { errJson(res, 405, 'Pull request is already merged or closed'); return true; }
    const result = doSquashMerge(repo, pull);
    if (!result.ok) { errJson(res, 405, result.reason ?? 'Merge conflict'); return true; }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    return true;
  }
  errJson(res, 404, 'Not Found'); return true;
}

// ---------------------------------------------------------------- git smart HTTP

function gitCapsV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const base = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta shallow multi_ack'
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta';
  return `${base} agent=${FORGE_NAME}/${FORGE_VERSION} symref=HEAD:refs/heads/${repo.defaultBranch}`;
}
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = gitCapsV0(repo, service);
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    const headLine = `${headTip ?? ZERO_OID} HEAD${first ? `\0${caps}` : ''}\n`;
    lines.push(headLine);
    first = false;
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}${first ? `\0${caps}` : ''}\n`);
      first = false;
      const peeled = peelToCommit(repo, r.oid);
      if (r.name.startsWith('refs/tags/') && peeled && peeled !== r.oid) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
    `agent=${FORGE_NAME}/${FORGE_VERSION}\n`,
    'flush',
  ]);
}
function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const lines: (string | 'flush')[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const prefixes = args.prefixes;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (defaultTip) lines.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (args.peel && r.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, r.oid);
      if (peeled && peeled !== r.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}
interface FetchPlan { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] }
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowIn: string[]): FetchPlan {
  const haveClosure = new Set<string>();
  for (const h of haves) for (const o of reachable(repo, [h])) haveClosure.add(o);
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    // BFS from wants limited to `depth` commit generations.
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const w of wants) {
      const c = resolveToCommit(repo, w);
      if (c && !dist.has(c)) { dist.set(c, 0); queue.push(c); }
      const o = repo.objects.get(w);
      if (o && o.type === 'tag' && !objects.has(w)) objects.set(w, o);
    }
    const includedCommits = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      const d = dist.get(cur) as number;
      if (d >= depth) continue;
      includedCommits.add(cur);
      const c = commitOf(repo, cur);
      if (!c) continue;
      for (const p of c.parents) {
        if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
      }
    }
    for (const oid of includedCommits) {
      // The commit itself plus its tree closure only — never a parent commit, its
      // tree, or its blobs (those are the history beyond the depth boundary).
      if (!haveClosure.has(oid)) {
        const commitObj = repo.objects.get(oid);
        if (commitObj) objects.set(oid, commitObj);
      }
      const c = commitOf(repo, oid);
      if (!c) continue;
      const treeClosure = new Set<string>();
      const stack = [c.tree];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (treeClosure.has(cur)) continue;
        const o = repo.objects.get(cur);
        if (!o) continue;
        treeClosure.add(cur);
        if (o.type === 'tree') for (const e of parseTree(o.data)) stack.push(e.oid);
      }
      for (const o of treeClosure) {
        if (haveClosure.has(o)) continue;
        const obj = repo.objects.get(o);
        if (obj) objects.set(o, obj);
      }
    }
    for (const oid of includedCommits) {
      const c = commitOf(repo, oid);
      if (!c) continue;
      const d = dist.get(oid) as number;
      if (d === depth - 1 && c.parents.length > 0) shallow.push(oid);
    }
    for (const s of shallowIn) if (includedCommits.has(s)) {
      const c = commitOf(repo, s);
      if (c && c.parents.some((p) => includedCommits.has(p))) unshallow.push(s);
    }
  } else {
    const wantClosure = new Set<string>();
    for (const w of wants) for (const o of reachable(repo, [w])) wantClosure.add(o);
    for (const o of wantClosure) {
      if (haveClosure.has(o)) continue;
      const obj = repo.objects.get(o);
      if (obj) objects.set(o, obj);
    }
    for (const s of shallowIn) {
      const c = commitOf(repo, s);
      if (c && c.parents.every((p) => objects.has(p) || haveClosure.has(p)) && objects.has(s)) unshallow.push(s);
    }
  }
  return { objects, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}
function fetchResponseV2(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowIn: string[]): Buffer {
  const plan = planFetch(repo, wants, haves, depth, shallowIn);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  const allHavesKnown = haves.length > 0 && haves.every((h) => repo.objects.has(h));
  if (allHavesKnown) {
    for (const h of haves) ackLines.push(`ACK ${h}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(pktLines(['acknowledgments\n', ...ackLines, 'delim']));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: (string | 'delim')[] = ['shallow-info\n'];
    for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
    for (const s of plan.unshallow) lines.push(`unshallow ${s}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  if (plan.objects.size > 0) {
    const pack = writePack([...plan.objects.values()]);
    parts.push(pkt('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}
function fetchResponseV0(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowIn: string[]): Buffer {
  const plan = planFetch(repo, wants, haves, depth, shallowIn);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  const allHavesKnown = haves.length > 0 && haves.every((h) => repo.objects.has(h));
  if (allHavesKnown) {
    for (const h of haves) lines.push(`ACK ${h}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
  for (const s of plan.unshallow) lines.push(`unshallow ${s}\n`);
  if (lines.length > 0) parts.push(pktLines(lines));
  if (plan.objects.size > 0) {
    const pack = writePack([...plan.objects.values()]);
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!m) return false;
  const owner = decodePath(m[1] as string);
  const name = decodePath(m[2] as string);
  const rest = m[3] as string;
  const method = req.method ?? 'GET';
  const repo = getRepo(owner, name);
  const protoV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (method === 'GET' && rest.startsWith('info/refs')) {
    const q = queryOf(req);
    const service = q.get('service') ?? '';
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8'); return true; }
    if (service === 'git-upload-pack') {
      const body = protoV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendRaw(res, 400, Buffer.from('Bad Request', 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
  if (method === 'POST' && rest === 'git-upload-pack') {
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8'); return true; }
    let raw: Buffer;
    try { raw = await readBody(req); } catch { sendRaw(res, 400, Buffer.from('Bad Request', 'utf8'), 'text/plain; charset=utf-8'); return true; }
    try {
      const out = handleUploadPack(repo, raw, protoV2);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('Bad Request', 'utf8'), 'text/plain; charset=utf-8');
    }
    return true;
  }
  if (method === 'POST' && rest === 'git-receive-pack') {
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found', 'utf8'), 'text/plain; charset=utf-8'); return true; }
    let raw: Buffer;
    try { raw = await readBody(req); } catch { sendRaw(res, 400, Buffer.from('Bad Request', 'utf8'), 'text/plain; charset=utf-8'); return true; }
    try {
      const { body: out, sideband } = handleReceivePack(repo, raw);
      void sideband;
      sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    } catch {
      sendRaw(res, 400, Buffer.from('Bad Request', 'utf8'), 'text/plain; charset=utf-8');
    }
    return true;
  }
  return false;
}
function packetLinesText(raw: Buffer): { lines: string[]; rest: Buffer } {
  const { packets, rest } = decodePktLines(raw);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return { lines, rest };
}
function handleUploadPack(repo: Repo, raw: Buffer, v2: boolean): Buffer {
  if (v2) {
    const { packets } = decodePktLines(raw);
    const lines: string[] = [];
    let afterDelim = false;
    for (const p of packets) {
      if (p.kind === 'delim') { afterDelim = true; continue; }
      if (p.kind === 'flush') break;
      if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
    }
    const command = lines[0] ?? '';
    if (command.startsWith('command=ls-refs')) {
      const args = { peel: false, symrefs: false, prefixes: [] as string[] };
      for (const l of lines.slice(1)) {
        if (l === 'peel') args.peel = true;
        else if (l === 'symrefs') args.symrefs = true;
        else if (l.startsWith('ref-prefix ')) args.prefixes.push(l.slice('ref-prefix '.length));
      }
      void afterDelim;
      return lsRefsResponse(repo, args);
    }
    if (command.startsWith('command=fetch')) {
      const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
      let depth: number | null = null;
      for (const l of lines.slice(1)) {
        if (l.startsWith('want ')) wants.push(l.slice(5).trim());
        else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
        else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
        else if (l.startsWith('deepen ')) { const n = parseInt(l.slice(7), 10); if (Number.isFinite(n)) depth = n; }
      }
      return fetchResponseV2(repo, wants, haves, depth, shallowIn);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  // v0: wants section, flush, haves + done section.
  const { packets } = decodePktLines(raw);
  const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const word = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const arg = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (word === 'want') wants.push(arg.split(' ')[0] as string);
    else if (word === 'have') haves.push(arg.trim());
    else if (word === 'shallow') shallowIn.push(arg.trim());
    else if (word === 'deepen') { const n = parseInt(arg, 10); if (Number.isFinite(n)) depth = n; }
  }
  void section;
  return fetchResponseV0(repo, wants, haves, depth, shallowIn);
}
function handleReceivePack(repo: Repo, raw: Buffer): { body: Buffer; sideband: boolean } {
  const { packets, rest } = decodePktLines(raw);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sideband = false;
  let sawFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { sawFlush = true; break; }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    let caps = '';
    if (nul >= 0) { caps = line.slice(nul + 1); line = line.slice(0, nul); }
    if (caps.includes('side-band-64k')) sideband = true;
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  void sawFlush;
  // Unpack the pack (if any) that follows the flush packet.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, GitObject>();
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest, (oid) => repo.objects.get(oid) ?? newObjects.get(oid));
      for (const [oid, obj] of parsed) newObjects.set(oid, obj);
    } catch {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = true;
      let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) { ok = false; reason = 'ref does not exist'; }
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
        else repo.refs.delete(cmd.ref);
      } else {
        const target = repo.objects.get(cmd.newOid) ?? newObjects.get(cmd.newOid);
        if (!target) { ok = false; reason = 'object not found'; }
        else if (current === undefined) {
          if (cmd.oldOid !== ZERO_OID) { ok = false; reason = 'non-fast-forward'; }
          else repo.refs.set(cmd.ref, cmd.newOid);
        } else {
          if (cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
          else if (cmd.ref.startsWith('refs/heads/')) {
            const newCommit = resolveToCommit(repo, cmd.newOid);
            const oldCommit = resolveToCommit(repo, current);
            if (!newCommit || !oldCommit || !isAncestor(repo, oldCommit, newCommit)) { ok = false; reason = 'non-fast-forward'; }
            else repo.refs.set(cmd.ref, cmd.newOid);
          } else {
            repo.refs.set(cmd.ref, cmd.newOid);
          }
        }
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
  }
  const inner = pktLines([...reportLines, 'flush']);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let i = 0; i < inner.length; i += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(inner.length, i + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    return { body: Buffer.concat(parts), sideband: true };
  }
  return { body: Buffer.concat([inner, PKT_FLUSH]), sideband: false };
}

// ---------------------------------------------------------------- GraphQL

interface GqlArg { [key: string]: unknown }
interface GqlField {
  alias: string; name: string; args: GqlArg; children: GqlField[]; fragmentType?: string;
}
interface GqlOp { kind: 'query' | 'mutation'; name: string | null; vars: Record<string, unknown>; fields: GqlField[] }
type GqlToken = { kind: 'name' | 'string' | 'int' | 'punct' | 'var'; value: string };
function gqlTokenize(src: string): GqlToken[] {
  const toks: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; }
        else { out += src[j]; j += 1; }
      }
      toks.push({ kind: 'string', value: out }); i = j + 1; continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) }); i = j; continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'int', value: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) }); i = j; continue;
    }
    if ('{}()[]:!@='.includes(ch)) { toks.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '.') {
      if (src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
      i += 1; continue;
    }
    i += 1;
  }
  return toks;
}
class GqlParser {
  toks: GqlToken[]; pos = 0; vars: Record<string, unknown>; fragments = new Map<string, GqlField[]>();
  constructor(src: string, vars: Record<string, unknown>) { this.toks = gqlTokenize(src); this.vars = vars; }
  peek(): GqlToken | undefined { return this.toks[this.pos]; }
  next(): GqlToken | undefined { return this.toks[this.pos++]; }
  expectPunct(v: string): void { const t = this.next(); if (!t || t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`); }
  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const nameTok = this.next();
        const onTok = this.next();
        if (onTok?.value !== 'on') throw new Error('fragment needs on');
        const typeTok = this.next();
        void typeTok;
        const fields = this.parseSelectionSet();
        if (nameTok) this.fragments.set(nameTok.value, fields);
        continue;
      }
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): GqlOp {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '{') {
      return { kind, name, vars: {}, fields: this.parseSelectionSet() };
    }
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n?.kind === 'name') { name = n.value; this.next(); }
    }
    // variable definitions
    if (this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (this.pos < this.toks.length && depth > 0) {
        const tok = this.next() as GqlToken;
        if (tok.value === '(') depth += 1;
        else if (tok.value === ')') depth -= 1;
      }
    }
    return { kind, name, vars: {}, fields: this.parseSelectionSet() };
  }
  parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === 'punct' && t.value === '}') { this.next(); break; }
      if (t.kind === 'punct' && t.value === '...') {
        this.next();
        const n = this.peek();
        if (n?.kind === 'name' && n.value === 'on') {
          this.next();
          const typeTok = this.next();
          const children = this.parseSelectionSet();
          for (const c of children) fields.push({ ...c, fragmentType: typeTok?.value });
        } else if (n?.kind === 'name') {
          this.next();
          const frag = this.fragments.get(n.value) ?? [];
          fields.push(...frag);
        }
        continue;
      }
      fields.push(this.parseField());
    }
    return fields;
  }
  parseField(): GqlField {
    const first = this.next();
    if (!first || first.kind !== 'name') throw new Error('expected field name');
    let alias = first.value;
    let name = first.value;
    if (this.peek()?.value === ':') {
      this.next();
      const n = this.next();
      if (!n || n.kind !== 'name') throw new Error('expected field name after alias');
      name = n.value;
    }
    const args: GqlArg = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.pos < this.toks.length) {
        const t = this.peek();
        if (t?.kind === 'punct' && t.value === ')') { this.next(); break; }
        const argName = this.next();
        if (!argName || argName.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[argName.value] = this.parseValue();
      }
    }
    let children: GqlField[] = [];
    if (this.peek()?.value === '{') children = this.parseSelectionSet();
    return { alias, name, args, children };
  }
  parseValue(): unknown {
    const t = this.next();
    if (!t) throw new Error('expected value');
    if (t.kind === 'var') return this.vars[t.value] ?? null;
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum
    }
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (this.pos < this.toks.length) {
        const n = this.peek();
        if (n?.kind === 'punct' && n.value === ']') { this.next(); break; }
        arr.push(this.parseValue());
      }
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.pos < this.toks.length) {
        const n = this.peek();
        if (n?.kind === 'punct' && n.value === '}') { this.next(); break; }
        const k = this.next();
        if (!k || k.kind !== 'name') throw new Error('expected object key');
        this.expectPunct(':');
        obj[k.value] = this.parseValue();
      }
      return obj;
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}
const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'repository', 'closedAt'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'headRef', 'baseRef', 'mergeCommit', 'isDraft'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'visibility', 'forkCount', 'stargazerCount'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MILESTONE'];
const KNOWN_TYPES: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: { fields: ISSUE_TYPE_FIELDS, enumValues: [] },
  PullRequest: { fields: PR_TYPE_FIELDS, enumValues: [] },
  Repository: { fields: REPO_TYPE_FIELDS, enumValues: [] },
  SearchType: { fields: [], enumValues: SEARCH_TYPE_VALUES },
  User: { fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'], enumValues: [] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};
function gqlState(issueState: 'open' | 'closed'): string { return issueState === 'open' ? 'OPEN' : 'CLOSED'; }
function gqlPrState(pull: Pull): string { return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'; }
function issueNode(repo: Repo, issue: Issue, fields: GqlField[], errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[f.alias] = issueGid(repo, issue); break;
      case 'number': out[f.alias] = issue.number; break;
      case 'title': out[f.alias] = issue.title; break;
      case 'state': out[f.alias] = gqlState(issue.state); break;
      case 'body': out[f.alias] = issue.body; break;
      case 'createdAt': out[f.alias] = isoOf(issue.createdTs); break;
      case 'updatedAt': out[f.alias] = isoOf(issue.updatedTs); break;
      case 'url': out[f.alias] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      default: errors.push(`Cannot query field "${f.name}" on type "Issue".`); break;
    }
  }
  return out;
}
function pullNode(repo: Repo, pull: Pull, fields: GqlField[], errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[f.alias] = pullGid(repo, pull); break;
      case 'number': out[f.alias] = pull.number; break;
      case 'title': out[f.alias] = pull.title; break;
      case 'state': out[f.alias] = gqlPrState(pull); break;
      case 'body': out[f.alias] = pull.body; break;
      case 'headRefName': out[f.alias] = pull.headRef; break;
      case 'baseRefName': out[f.alias] = pull.baseRef; break;
      case 'mergeable': out[f.alias] = prMergeable(repo, pull); break;
      case 'merged': out[f.alias] = pull.merged; break;
      case 'createdAt': out[f.alias] = isoOf(pull.createdTs); break;
      case 'updatedAt': out[f.alias] = isoOf(pull.updatedTs); break;
      case 'files': {
        computeChangedFiles(repo, pull);
        const first = typeof f.args.first === 'number' ? f.args.first : 100;
        const nodesField = f.children.find((c) => c.name === 'nodes');
        const nodeFields = nodesField ? nodesField.children : [];
        const nodes = pull.changedFiles.slice(0, first).map((cf) => {
          const node: Record<string, unknown> = {};
          for (const cf2 of nodeFields) if (cf2.name === 'path') node[cf2.alias] = cf.path;
          return node;
        });
        out[f.alias] = { nodes, totalCount: pull.changedFiles.length };
        break;
      }
      default: errors.push(`Cannot query field "${f.name}" on type "PullRequest".`); break;
    }
  }
  return out;
}
function repoNode(repo: Repo, fields: GqlField[], errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[f.alias] = repoGid(repo); break;
      case 'databaseId': out[f.alias] = repo.id; break;
      case 'name': out[f.alias] = repo.name; break;
      case 'nameWithOwner': out[f.alias] = `${repo.owner}/${repo.name}`; break;
      case 'owner': {
        const node: Record<string, unknown> = {};
        for (const c of f.children) {
          if (c.name === 'login') node[c.alias] = repo.owner;
          else if (c.name === 'id') node[c.alias] = gid('User', String(VIEWER_ID));
          else errors.push(`Cannot query field "${c.name}" on type "User".`);
        }
        out[f.alias] = node;
        break;
      }
      case 'defaultBranchRef': out[f.alias] = { name: repo.defaultBranch }; break;
      case 'viewerPermission': out[f.alias] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[f.alias] = true; break;
      case 'description': out[f.alias] = repo.description; break;
      case 'isPrivate': out[f.alias] = repo.private; break;
      case 'createdAt': out[f.alias] = isoOf(repo.createdTs); break;
      case 'updatedAt': out[f.alias] = isoOf(repo.updatedTs); break;
      case 'url': out[f.alias] = `https://github.com/${repo.owner}/${repo.name}`; break;
      case 'issue': {
        const n = f.args.number as number | undefined;
        const issue = repo.issues.find((i) => i.number === n);
        out[f.alias] = issue ? issueNode(repo, issue, f.children, errors) : null;
        break;
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = f.args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        const orderBy = f.args.orderBy as Record<string, unknown> | undefined;
        if (isRecord(orderBy)) {
          const field = String(orderBy.field ?? 'CREATED_AT');
          const dir = String(orderBy.direction ?? 'DESC');
          if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
            list.sort((a, b) => {
              const ta = field === 'CREATED_AT' ? a.createdTs : a.updatedTs;
              const tb = field === 'CREATED_AT' ? b.createdTs : b.updatedTs;
              if (ta !== tb) return dir === 'DESC' ? tb - ta : ta - tb;
              return dir === 'DESC' ? b.number - a.number : a.number - b.number;
            });
          }
        } else {
          list.sort((a, b) => a.number - b.number);
        }
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        const after = f.args.after as string | null | undefined;
        let start = 0;
        if (typeof after === 'string' && after !== '') {
          try {
            const decoded = Buffer.from(after, 'base64').toString('utf8');
            const idx = parseInt(decoded.split(':')[1] ?? '', 10);
            if (Number.isFinite(idx)) start = idx + 1;
          } catch { start = 0; }
        }
        const slice = list.slice(start, start + first);
        const nodesField = f.children.find((c) => c.name === 'nodes');
        const nodes = slice.map((i) => issueNode(repo, i, nodesField ? nodesField.children : [], errors));
        const endCursor = slice.length > 0 ? Buffer.from(`cursor:${start + slice.length - 1}`).toString('base64') : null;
        const pageInfo: Record<string, unknown> = {};
        const pageInfoField = f.children.find((c) => c.name === 'pageInfo');
        if (pageInfoField) {
          for (const pc of pageInfoField.children) {
            if (pc.name === 'hasNextPage') pageInfo[pc.alias] = start + slice.length < list.length;
            else if (pc.name === 'endCursor') pageInfo[pc.alias] = endCursor;
            else if (pc.name === 'hasPreviousPage') pageInfo[pc.alias] = start > 0;
            else if (pc.name === 'startCursor') pageInfo[pc.alias] = slice.length > 0 ? Buffer.from(`cursor:${start}`).toString('base64') : null;
          }
        }
        const conn: Record<string, unknown> = { nodes };
        if (pageInfoField) conn.pageInfo = pageInfo;
        for (const c of f.children) {
          if (c.name === 'totalCount') conn[c.alias] = list.length;
        }
        out[f.alias] = conn;
        break;
      }
      case 'pullRequests': {
        const first = typeof f.args.first === 'number' ? f.args.first : 100;
        const list = repo.pulls.filter((p) => p.state === 'open').slice(0, first);
        const nodesField = f.children.find((c) => c.name === 'nodes');
        out[f.alias] = { nodes: list.map((p) => pullNode(repo, p, nodesField ? nodesField.children : [], errors)) };
        break;
      }
      case 'pullRequest': {
        const n = f.args.number as number | undefined;
        const pull = repo.pulls.find((p) => p.number === n);
        out[f.alias] = pull ? pullNode(repo, pull, f.children, errors) : null;
        break;
      }
      default: errors.push(`Cannot query field "${f.name}" on type "Repository".`); break;
    }
  }
  return out;
}
function executeOperation(op: GqlOp): { data: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};
  if (op.kind === 'mutation') {
    for (const f of op.fields) {
      if (f.name === 'createIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoById(num(input.repositoryId ? decodeGidRepoId(input.repositoryId) : NaN, NaN));
        const issueFields = f.children.find((c) => c.name === 'issue')?.children ?? [];
        if (!repo) { data[f.alias] = { issue: null }; errors.push('Could not resolve to a Repository with the global id.'); continue; }
        const ts = nextTs();
        const issue: Issue = { id: nextGlobalId, number: repo.nextNumber, title: str(input.title), body: str(input.body), state: 'open', labels: [], createdTs: ts, updatedTs: ts, closedTs: null, comments: [] };
        nextGlobalId += 1; repo.nextNumber += 1;
        repo.issues.push(issue);
        data[f.alias] = { issue: issueNode(repo, issue, issueFields, errors) };
      } else if (f.name === 'closeIssue') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(str(input.issueId));
        const issueFields = f.children.find((c) => c.name === 'issue')?.children ?? [];
        if (!found) { data[f.alias] = { issue: null }; errors.push('Could not resolve to an Issue with the global id.'); continue; }
        found.issue.state = 'closed';
        found.issue.closedTs = nextTs();
        found.issue.updatedTs = nextTs();
        data[f.alias] = { issue: issueNode(found.repo, found.issue, issueFields, errors) };
      } else if (f.name === 'createPullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoById(num(decodeGidRepoId(input.repositoryId), NaN));
        const prFields = f.children.find((c) => c.name === 'pullRequest')?.children ?? [];
        const head = str(input.headRefName);
        const base = str(input.baseRefName);
        if (!repo) { data[f.alias] = { pullRequest: null }; errors.push('Could not resolve to a Repository with the global id.'); continue; }
        const headSha = resolveCommit(repo, head);
        const baseSha = resolveCommit(repo, base);
        if (!headSha || !baseSha) { data[f.alias] = { pullRequest: null }; errors.push(`Head or base ref not found: ${head} / ${base}`); continue; }
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) { data[f.alias] = { pullRequest: pullNode(repo, dup, prFields, errors) }; continue; }
        const ts = nextTs();
        const pull: Pull = { id: nextGlobalId, number: repo.nextNumber, title: str(input.title), body: str(input.body), state: 'open', headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdTs: ts, updatedTs: ts, changedFiles: [] };
        nextGlobalId += 1; repo.nextNumber += 1;
        computeChangedFiles(repo, pull);
        repo.pulls.push(pull);
        data[f.alias] = { pullRequest: pullNode(repo, pull, prFields, errors) };
      } else if (f.name === 'mergePullRequest') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGid(str(input.pullRequestId));
        const prFields = f.children.find((c) => c.name === 'pullRequest')?.children ?? [];
        if (!found) { data[f.alias] = { pullRequest: null }; errors.push('Could not resolve to a PullRequest with the global id.'); continue; }
        if (found.pull.state === 'open') {
          const result = doSquashMerge(found.repo, found.pull);
          if (!result.ok) { data[f.alias] = { pullRequest: pullNode(found.repo, found.pull, prFields, errors) }; errors.push(`Merge conflict: ${result.reason ?? ''}`); continue; }
        }
        data[f.alias] = { pullRequest: pullNode(found.repo, found.pull, prFields, errors) };
      } else if (f.name === 'addComment') {
        const input = (f.args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(str(input.subjectId));
        const nodeFields = f.children.find((c) => c.name === 'commentEdge')?.children.find((c) => c.name === 'node')?.children ?? [];
        if (!found) { data[f.alias] = { commentEdge: null }; errors.push('Could not resolve to an Issue with the global id.'); continue; }
        const ts = nextTs();
        const comment: Comment = { id: found.repo.nextCommentId, body: str(input.body), createdTs: ts, updatedTs: ts };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        const node: Record<string, unknown> = {};
        for (const cf of nodeFields) {
          if (cf.name === 'id') node[cf.alias] = commentGid(found.repo, found.issue, comment);
          else if (cf.name === 'body') node[cf.alias] = comment.body;
        }
        data[f.alias] = { commentEdge: { node } };
      } else {
        errors.push(`Cannot query field "${f.name}" on type "Mutation".`);
        data[f.alias] = null;
      }
    }
    return { data, errors };
  }
  for (const f of op.fields) {
    if (f.name === 'viewer') {
      const node: Record<string, unknown> = {};
      for (const c of f.children) {
        if (c.name === 'login') node[c.alias] = VIEWER_LOGIN;
        else if (c.name === 'id') node[c.alias] = gid('User', String(VIEWER_ID));
        else if (c.name === 'name') node[c.alias] = VIEWER_NAME;
        else errors.push(`Cannot query field "${c.name}" on type "User".`);
      }
      data[f.alias] = node;
    } else if (f.name === 'repository') {
      const owner = str(f.args.owner);
      const name = str(f.args.name);
      const repo = getRepo(owner, name);
      data[f.alias] = repo ? repoNode(repo, f.children, errors) : null;
    } else if (f.name === 'node') {
      const id = str(f.args.id);
      const d = decodeGid(id);
      if (d?.kind === 'Repository') {
        const repo = findRepoById(Number(d.rest));
        if (repo) {
          const node = repoNode(repo, f.children.filter((c) => !c.fragmentType || c.fragmentType === 'Repository'), errors);
          node.id = repoGid(repo);
          data[f.alias] = node;
        } else data[f.alias] = null;
      } else if (d?.kind === 'Issue') {
        const found = findIssueByGid(id);
        data[f.alias] = found ? issueNode(found.repo, found.issue, f.children, errors) : null;
      } else data[f.alias] = null;
    } else if (f.name === '__type') {
      const typeName = str(f.args.name);
      const known = KNOWN_TYPES[typeName];
      if (!known) { data[f.alias] = null; continue; }
      const node: Record<string, unknown> = { name: typeName };
      for (const c of f.children) {
        if (c.name === 'fields') {
          node[c.alias] = known.fields.map((n) => ({ name: n }));
        } else if (c.name === 'enumValues') {
          node[c.alias] = known.enumValues.map((n) => ({ name: n }));
        } else if (c.name === 'name') node[c.alias] = typeName;
      }
      data[f.alias] = node;
    } else if (f.name === '__schema') {
      data[f.alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    } else {
      errors.push(`Cannot query field "${f.name}" on type "Query".`);
      data[f.alias] = null;
    }
  }
  return { data, errors };
}
function decodeGidRepoId(id: unknown): number {
  if (typeof id !== 'string') return NaN;
  const d = decodeGid(id);
  if (!d || d.kind !== 'Repository') return NaN;
  return Number(d.rest);
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') { errJson(res, 404, 'Not Found'); return true; }
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return true; }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) { sendJson(res, 200, { errors: [{ message: 'Problems parsing JSON' }] }); return true; }
  const bodies = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results: unknown[] = [];
  for (const item of bodies) {
    if (!isRecord(item) || typeof item.query !== 'string') {
      results.push({ errors: [{ message: 'GraphQL query is required' }] });
      continue;
    }
    const vars = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    try {
      const parser = new GqlParser(item.query, vars);
      const ops = parser.parseDocument();
      const opName = typeof item.operationName === 'string' ? item.operationName : null;
      const op = ops.find((o) => o.name === opName) ?? ops[0];
      if (!op) { results.push({ errors: [{ message: 'No operation provided' }] }); continue; }
      const { data, errors } = executeOperation(op);
      const out: Record<string, unknown> = { data };
      if (errors.length > 0) out.errors = errors.map((message) => ({ message }));
      results.push(out);
    } catch (e) {
      results.push({ errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
  return true;
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number, using a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
];
function mcpArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(args)) {
    if (names.some((n) => norm(n) === norm(k))) return v;
  }
  return undefined;
}
function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(mcpArg(args, 'owner', 'owner_login', 'org', 'login', 'user') ?? '');
  let repo = str(mcpArg(args, 'repo', 'repository', 'repository_name', 'repo_name') ?? '');
  const full = str(mcpArg(args, 'full_name', 'repo_full_name', 'fullName') ?? '');
  if ((owner === '' || repo === '') && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === '') owner = o ?? '';
    if (repo === '') repo = r ?? '';
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, repo };
}
function mcpResult(id: unknown, payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text }], structuredContent: payload, isError } };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') { errJson(res, 404, 'Not Found'); return true; }
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = body.id ?? null;
  const method = str(body.method);
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextReqId() });
    res.end();
    return true;
  }
  if (!authOk(req)) {
    res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Requires authentication' } }) + '\n');
    return true;
  }
  const params = isRecord(body.params) ? body.params : {};
  const serverInfo = { name: FORGE_NAME, version: FORGE_VERSION };
  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0', id,
      result: {
        resultType: 'server/discover',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: {
          'io.modelcontextprotocol/serverInfo': serverInfo,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: FORGE_NAME, version: FORGE_VERSION },
        },
      },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = str((params as Record<string, unknown>).protocolVersion, '2025-11-25');
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = known.includes(requested) ? requested : '2025-11-25';
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo } }, { 'mcp-session-id': 'session-1' });
    return true;
  }
  if (method === 'ping') { sendJson(res, 200, { jsonrpc: '2.0', id, result: {} }); return true; }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return true;
  }
  if (method === 'tools/call') {
    const name = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === name)
      ?? MCP_TOOLS.find((t) => name.toLowerCase().endsWith(t.name));
    if (!tool) { sendJson(res, 200, mcpError(id, -32602, `Unknown tool: ${name}`)); return true; }
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((r) => args[r] === undefined && mcpArg(args, r) === undefined);
    if (missing.length > 0) {
      sendJson(res, 200, mcpResult(id, { error: `missing required argument: ${missing.join(', ')}` }, true));
      return true;
    }
    try {
      const payload = mcpCall(tool.name, args);
      if (payload === null) {
        sendJson(res, 200, mcpResult(id, { error: 'not found' }, true));
        return true;
      }
      sendJson(res, 200, mcpResult(id, payload));
      return true;
    } catch (e) {
      sendJson(res, 200, mcpResult(id, { error: e instanceof Error ? e.message : String(e) }, true));
      return true;
    }
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}
function mcpCall(name: string, args: Record<string, unknown>): unknown {
  if (name === 'create_repo') {
    const repoName = str(mcpArg(args, 'name', 'repo', 'repository') ?? '');
    if (repoName === '') throw new Error('name is required');
    if (repos.has(repoKey(VIEWER_LOGIN, repoName))) {
      const existing = repos.get(repoKey(VIEWER_LOGIN, repoName)) as Repo;
      return repoJson(existing, '');
    }
    const repo = createRepoRecord(repoName, str(mcpArg(args, 'description') ?? ''), bool(mcpArg(args, 'private'), false));
    return repoJson(repo, '');
  }
  if (name === 'list_repos') {
    return [...repos.values()].sort((a, b) => a.seq - b.seq).map((r) => repoJson(r, ''));
  }
  const { owner, repo: repoName } = mcpOwnerRepo(args);
  const repo = getRepo(owner, repoName);
  if (!repo) return null;
  if (name === 'get_repo') return repoJson(repo, '');
  if (name === 'create_issue') {
    const title = str(mcpArg(args, 'title') ?? '');
    if (title === '') throw new Error('title is required');
    const ts = nextTs();
    const issue: Issue = { id: nextGlobalId, number: repo.nextNumber, title, body: str(mcpArg(args, 'body') ?? ''), state: 'open', labels: [], createdTs: ts, updatedTs: ts, closedTs: null, comments: [] };
    nextGlobalId += 1; repo.nextNumber += 1;
    repo.issues.push(issue);
    return issueJson(repo, issue);
  }
  if (name === 'list_issues') {
    const state = str(mcpArg(args, 'state') ?? 'open');
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    return list.map((i) => issueJson(repo, i));
  }
  if (name === 'get_issue') {
    const number = num(mcpArg(args, 'number', 'issue_number'), NaN);
    const issue = repo.issues.find((i) => i.number === number);
    return issue ? issueJson(repo, issue) : null;
  }
  if (name === 'create_pull_request') {
    const head = str(mcpArg(args, 'head', 'head_ref', 'head_branch') ?? '');
    const base = str(mcpArg(args, 'base', 'base_ref', 'base_branch') ?? '');
    const title = str(mcpArg(args, 'title') ?? '');
    const headSha = resolveCommit(repo, head);
    const baseSha = resolveCommit(repo, base);
    if (!headSha || !baseSha) throw new Error('head or base branch not found');
    const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (dup) return pullJson(repo, dup);
    const ts = nextTs();
    const pull: Pull = { id: nextGlobalId, number: repo.nextNumber, title, body: str(mcpArg(args, 'body') ?? ''), state: 'open', headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null, createdTs: ts, updatedTs: ts, changedFiles: [] };
    nextGlobalId += 1; repo.nextNumber += 1;
    computeChangedFiles(repo, pull);
    repo.pulls.push(pull);
    return pullJson(repo, pull);
  }
  if (name === 'merge_pull_request') {
    const number = num(mcpArg(args, 'pull_number', 'pull_request_number', 'number'), NaN);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return null;
    if (pull.state !== 'open') return pullJson(repo, pull);
    const result = doSquashMerge(repo, pull);
    if (!result.ok) throw new Error(result.reason ?? 'merge conflict');
    return { merged: true, sha: result.sha, number: pull.number, ...pullJson(repo, pull) };
  }
  return null;
}

// ---------------------------------------------------------------- app

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (await handleMcp(req, res)) return;
        if (await handleGraphQL(req, res)) return;
        if (await handleGit(req, res)) return;
        if (path.startsWith('/api/v3')) { await handleRest(req, res); return; }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        try { errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error'); } catch { /* socket gone */ }
      }
    })();
  });
}
