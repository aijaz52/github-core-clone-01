import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
type GitObject = { type: ObjectType; data: Buffer; packed?: Buffer };
type Entry = { name: string; mode: string; oid: string };
type FileEntry = { oid: string; mode: string };
type Json = Record<string, any>;
interface Repo {
  info: Json;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Json>;
  issues: Map<number, Json>;
  pulls: Map<number, Json>;
  comments: Map<number, Json[]>;
  nextNumber: number;
}
const ZERO = '0'.repeat(40);
const FLUSH = Buffer.from('0000');
const EMPTY = Buffer.alloc(0);
const DELIM = Buffer.from('0001');
const TYPES: ObjectType[] = ['commit', 'tree', 'blob', 'tag'];
const NOW = process.env.MAKEFUN_TRIAL_NOW || '2026-01-01T00:00:00Z';
// The wire contract's token account; deployments may choose their own account login.
const LOGIN = process.env.MAKEFUN_FORGE_LOGIN || 'adaiversen';
const user = { login: LOGIN, id: 1000, type: 'User' };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function requireValue(ok: unknown, status: number, message: string): asserts ok {
  if (!ok) throw new HttpError(status, message);
}
function sha(data: Buffer): Buffer { return createHash('sha1').update(data).digest(); }
function put(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  repo.objects.set(oid, { type, data });
  return oid;
}
function object(repo: Repo, oid: string): GitObject {
  const found = repo.objects.get(oid);
  requireValue(found, 422, `Missing object ${oid}`);
  return found;
}
function treeEntries(data: Buffer): Entry[] {
  const entries: Entry[] = [];
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(32, at), nul = data.indexOf(0, space + 1);
    requireValue(space >= at && nul > space && nul + 21 <= data.length, 400, 'Invalid tree');
    entries.push({ mode: data.toString('ascii', at, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return entries;
}
function commitView(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } {
  const text = object(repo, oid).data.toString();
  const split = text.indexOf('\n\n'), headers = text.slice(0, split).split('\n');
  return { tree: headers.find(s => s.startsWith('tree '))?.slice(5) || '', parents: headers.filter(s => s.startsWith('parent ')).map(s => s.slice(7)), message: text.slice(split + 2) };
}
function resolve(repo: Repo, ref?: string): string | undefined {
  return repo.refs.get(ref || `refs/heads/${repo.info.default_branch}`) || repo.refs.get(`refs/heads/${ref}`) || repo.refs.get(`refs/tags/${ref}`) || (ref && repo.objects.has(ref) ? ref : undefined);
}
function files(repo: Repo, tip?: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  if (!tip) return out;
  const walk = (oid: string, prefix: string) => {
    for (const entry of treeEntries(object(repo, oid).data)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(commitView(repo, tip).tree, '');
  return out;
}
function buildTree(repo: Repo, entries: Map<string, FileEntry>): string {
  const build = (prefix: string): string => {
    const children = new Map<string, Entry>();
    for (const [path, file] of entries) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length), slash = tail.indexOf('/');
      if (slash < 0) children.set(tail, { name: tail, ...file });
      else {
        const name = tail.slice(0, slash);
        if (!children.has(name)) children.set(name, { name, mode: '40000', oid: build(prefix + name + '/') });
      }
    }
    const sorted = [...children.values()].sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return put(repo, 'tree', Buffer.concat(sorted.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')])));
  };
  return build('');
}
function commit(repo: Repo, entries: Map<string, FileEntry>, parents: string[], message: string): string {
  const seconds = Math.floor(Date.parse(NOW) / 1000) || 1700000000;
  const identity = `${LOGIN} <${LOGIN}@example.invalid> ${seconds} +0000`;
  return put(repo, 'commit', Buffer.from([`tree ${buildTree(repo, entries)}`, ...parents.map(p => `parent ${p}`), `author ${identity}`, `committer ${identity}`, '', message].join('\n')));
}
function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>(), queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (repo.objects.get(oid)?.type === 'commit') queue.push(...commitView(repo, oid).parents);
  }
  return seen;
}
function hasAncestor(repo: Repo, tip: string, target: string): boolean {
  const seen = new Set<string>(), queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (repo.objects.get(oid)?.type === 'commit') queue.push(...commitView(repo, oid).parents);
  }
  return false;
}
function reachable(repo: Repo, roots: string[], depth = Infinity, boundaries = new Set<string>()): { ids: Set<string>; shallow: Set<string> } {
  const ids = new Set<string>(), shallow = new Set<string>(), visitedDepth = new Map<string, number>();
  const queue: [string, number][] = roots.map(oid => [oid, 1]);
  while (queue.length) {
    const [oid, generation] = queue.pop()!;
    if ((visitedDepth.get(oid) ?? Infinity) <= generation) continue;
    visitedDepth.set(oid, generation);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    ids.add(oid);
    if (obj.type === 'commit') {
      const view = commitView(repo, oid);
      queue.push([view.tree, generation]);
      if (generation >= depth || boundaries.has(oid)) { if (view.parents.length) shallow.add(oid); }
      else queue.push(...view.parents.map(p => [p, generation + 1] as [string, number]));
    } else if (obj.type === 'tree') {
      queue.push(...treeEntries(obj.data).filter(e => e.mode !== '160000').map(e => [e.oid, generation] as [string, number]));
    } else if (obj.type === 'tag') {
      const target = /^object ([a-f0-9]{40})/m.exec(obj.data.toString())?.[1];
      if (target) queue.push([target, generation]);
    }
  }
  return { ids, shallow };
}

function pkt(data: string | Buffer): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  requireValue(bytes.length <= 65516, 400, 'Packet too large');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}
function packets(data: Buffer, stopAtFlush = false): { lines: string[]; offset: number } {
  const lines: string[] = [];
  let at = 0;
  while (at < data.length) {
    requireValue(at + 4 <= data.length && /^[a-f0-9]{4}$/i.test(data.toString('ascii', at, at + 4)), 400, 'Invalid pkt-line');
    const n = parseInt(data.toString('ascii', at, at + 4), 16);
    at += 4;
    if (n <= 2) { if (n === 0 && stopAtFlush) break; continue; }
    requireValue(n >= 4 && n <= 65520 && at + n - 4 <= data.length, 400, 'Truncated pkt-line');
    lines.push(data.toString('utf8', at, at + n - 4).replace(/\n$/, ''));
    at += n - 4;
  }
  return { lines, offset: at };
}
function sideband(data: Buffer): Buffer[] {
  const result: Buffer[] = [];
  for (let at = 0; at < data.length; at += 65515) result.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(at, at + 65515)])));
  return result;
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const byte = () => { requireValue(at < delta.length, 400, 'Truncated delta'); return delta[at++]; };
  const size = () => {
    let n = 0, shift = 0, b: number;
    do { b = byte(); n += (b & 127) * 2 ** shift; shift += 7; requireValue(shift <= 56, 400, 'Invalid delta size'); } while (b & 128);
    return n;
  };
  requireValue(size() === base.length, 400, 'Delta base size mismatch');
  const target = size();
  requireValue(target <= 128 * 1024 * 1024, 400, 'Delta too large');
  const out = Buffer.allocUnsafe(target);
  let written = 0;
  while (at < delta.length) {
    const op = byte();
    if (op & 128) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (i * 8);
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) length += byte() * 2 ** (i * 8);
      length ||= 65536;
      requireValue(offset + length <= base.length && written + length <= target, 400, 'Invalid delta copy');
      base.copy(out, written, offset, offset + length); written += length;
    } else {
      requireValue(op > 0 && at + op <= delta.length && written + op <= target, 400, 'Invalid delta insert');
      delta.copy(out, written, at, at + op); at += op; written += op;
    }
  }
  requireValue(written === target, 400, 'Delta result size mismatch');
  return out;
}
function readPack(repo: Repo, data: Buffer): Map<string, GitObject> {
  requireValue(data.length >= 32 && data.toString('ascii', 0, 4) === 'PACK' && [2, 3].includes(data.readUInt32BE(4)), 400, 'Invalid pack header');
  const end = data.length - 20;
  requireValue(sha(data.subarray(0, end)).equals(data.subarray(end)), 400, 'Pack checksum mismatch');
  type Raw = { offset: number; code: number; data: Buffer; baseOffset?: number; baseOid?: string; result?: GitObject };
  const unresolved: Raw[] = [], byOffset = new Map<number, Raw>(), result = new Map<string, GitObject>();
  const save = (entry: Raw, obj: GitObject) => {
    entry.result = obj;
    const oid = createHash('sha1').update(`${obj.type} ${obj.data.length}\0`).update(obj.data).digest('hex');
    result.set(oid, obj);
  };
  let at = 12;
  for (let i = 0, count = data.readUInt32BE(8); i < count; i++) {
    requireValue(at < end, 400, 'Truncated pack');
    const offset = at; let b = data[at++], size = b & 15, shift = 4;
    const code = (b >> 4) & 7;
    while (b & 128) { requireValue(at < end && shift < 56, 400, 'Invalid pack size'); b = data[at++]; size += (b & 127) * 2 ** shift; shift += 7; }
    const entry: Raw = { offset, code, data: EMPTY };
    if (code === 6) {
      b = data[at++]; let distance = b & 127;
      while (b & 128) { requireValue(at < end, 400, 'Invalid delta offset'); b = data[at++]; distance = (distance + 1) * 128 + (b & 127); }
      entry.baseOffset = offset - distance;
    } else if (code === 7) { requireValue(at + 20 <= end, 400, 'Truncated delta base'); entry.baseOid = data.subarray(at, at + 20).toString('hex'); at += 20; }
    else requireValue(code >= 1 && code <= 4, 400, 'Invalid pack object type');
    const inflated = inflateSync(data.subarray(at, end), { info: true, maxOutputLength: 128 * 1024 * 1024 });
    entry.data = inflated.buffer;
    at += inflated.engine.bytesWritten;
    requireValue(entry.data.length === size, 400, 'Pack object size mismatch');
    byOffset.set(offset, entry);
    if (code <= 4) save(entry, { type: TYPES[code - 1], data: entry.data });
    else {
      const base = code === 6 ? byOffset.get(entry.baseOffset!)?.result : result.get(entry.baseOid!) || repo.objects.get(entry.baseOid!);
      if (base) save(entry, { type: base.type, data: applyDelta(base.data, entry.data) });
      else unresolved.push(entry);
    }
  }
  requireValue(at === end, 400, 'Trailing pack data');
  while (unresolved.length) {
    let remaining = 0;
    for (const entry of unresolved) {
      const base = entry.code === 6 ? byOffset.get(entry.baseOffset!)?.result : result.get(entry.baseOid!) || repo.objects.get(entry.baseOid!);
      if (base) save(entry, { type: base.type, data: applyDelta(base.data, entry.data) });
      else unresolved[remaining++] = entry;
    }
    requireValue(remaining < unresolved.length, 400, 'Unresolved pack delta');
    unresolved.length = remaining;
  }
  return result;
}
function writePack(repo: Repo, ids: Set<string>): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.size, 8);
  const parts = [header], hash = createHash('sha1').update(header);
  let length = header.length + 20;
  for (const oid of ids) {
    const obj = object(repo, oid);
    if (!obj.packed) {
      const bytes = Buffer.allocUnsafe(10);
      let at = 0, n = Math.floor(obj.data.length / 16), b = ((TYPES.indexOf(obj.type) + 1) << 4) | (obj.data.length & 15);
      while (n) { bytes[at++] = b | 128; b = n & 127; n = Math.floor(n / 128); }
      bytes[at++] = b;
      obj.packed = Buffer.concat([bytes.subarray(0, at), deflateSync(obj.data)]);
    }
    parts.push(obj.packed); hash.update(obj.packed); length += obj.packed.length;
  }
  parts.push(hash.digest());
  return Buffer.concat(parts, length);
}
function peeled(repo: Repo, oid: string): string | undefined {
  let obj = repo.objects.get(oid), target: string | undefined;
  const seen = new Set<string>();
  while (obj?.type === 'tag' && !seen.has(oid)) {
    seen.add(oid); target = /^object ([a-f0-9]{40})/m.exec(obj.data.toString())?.[1];
    if (!target) break;
    oid = target; obj = repo.objects.get(oid);
  }
  return target;
}
function gitResponse(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string, advertise: boolean, body: Buffer): void {
  const upload = service === 'git-upload-pack', v2 = upload && String(req.headers['git-protocol']).includes('version=2');
  let output: Buffer[] = [];
  const headRef = `refs/heads/${repo.info.default_branch}`, head = repo.refs.get(headRef);
  const refs = [...(head ? [['HEAD', head] as [string, string]] : []), ...repo.refs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (advertise) {
    if (v2) output = [pkt('version 2\n'), pkt('agent=memory-forge/1.0\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('object-format=sha1\n'), FLUSH];
    else {
      const caps = upload ? `side-band-64k ofs-delta shallow no-progress symref=HEAD:${headRef} agent=memory-forge/1.0` : 'report-status side-band-64k delete-refs ofs-delta agent=memory-forge/1.0';
      output = [pkt(`# service=${service}\n`), FLUSH];
      const advertised = refs.length ? refs : [['capabilities^{}', ZERO]];
      advertised.forEach(([name, oid], i) => {
        output.push(pkt(`${oid} ${name}${i === 0 ? '\0' + caps : ''}\n`));
        const target = peeled(repo, oid);
        if (target) output.push(pkt(`${target} ${name}^{}\n`));
      });
      output.push(FLUSH);
    }
  } else if (!upload) {
    const commands = packets(body, true);
    let unpack = 'ok';
    try {
      if (commands.offset < body.length) for (const [oid, obj] of readPack(repo, body.subarray(commands.offset))) repo.objects.set(oid, obj);
    } catch (err) { unpack = err instanceof Error ? err.message : 'invalid pack'; }
    const report = [pkt(`unpack ${unpack}\n`)];
    for (const line of commands.lines) {
      const [old, next, ref] = line.split('\0')[0].trim().split(' ');
      let reason = unpack === 'ok' ? '' : 'unpacker error';
      if (!ref?.startsWith('refs/') || !/^[a-f0-9]{40}$/.test(next || '')) reason ||= 'invalid ref';
      else if ((repo.refs.get(ref) || ZERO) !== old) reason ||= 'stale ref';
      else if (next !== ZERO && !repo.objects.has(next)) reason ||= 'missing object';
      else if (old !== ZERO && next !== ZERO && !hasAncestor(repo, next, old)) reason ||= 'non-fast-forward';
      if (!reason) { if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next); }
      report.push(pkt(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
    }
    report.push(FLUSH);
    output = commands.lines[0]?.includes('side-band-64k') ? [...sideband(Buffer.concat(report)), FLUSH] : report;
  } else {
    const { lines } = packets(body);
    if (v2 && lines.includes('command=ls-refs')) {
      const prefixes = lines.filter(s => s.startsWith('ref-prefix ')).map(s => s.slice(11));
      for (const [name, oid] of refs) {
        if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
        const target = lines.includes('peel') ? peeled(repo, oid) : undefined;
        output.push(pkt(`${oid} ${name}${name === 'HEAD' && lines.includes('symrefs') ? ' symref-target:' + headRef : ''}${target ? ' peeled:' + target : ''}\n`));
      }
      if (!head && lines.includes('unborn') && (!prefixes.length || prefixes.some(p => 'HEAD'.startsWith(p)))) output.push(pkt(`unborn HEAD symref-target:${headRef}\n`));
      output.push(FLUSH);
    } else {
      const values = (prefix: string) => lines.filter(s => s.startsWith(prefix + ' ')).map(s => s.split(' ')[1]);
      const depth = Number(values('deepen')[0]) || Infinity;
      const shallow = new Set(values('shallow'));
      const held = reachable(repo, values('have'), Infinity, shallow).ids;
      const wanted = reachable(repo, values('want'), depth);
      const wantedBeforeExclusion = new Set(wanted.ids);
      for (const oid of held) wanted.ids.delete(oid);
      const boundaries = [...wanted.shallow].map(oid => `shallow ${oid}\n`);
      for (const oid of shallow) if (!wanted.shallow.has(oid) && wantedBeforeExclusion.has(oid)) boundaries.push(`unshallow ${oid}\n`);
      if (v2) {
        if (boundaries.length) output.push(pkt('shallow-info\n'), ...boundaries.map(pkt), DELIM);
        output.push(pkt('packfile\n'));
      } else {
        if (boundaries.length) output.push(...boundaries.map(pkt), FLUSH);
        output.push(pkt('NAK\n'));
      }
      output.push(...sideband(writePack(repo, wanted.ids)), FLUSH);
    }
  }
  const data = Buffer.concat(output);
  res.writeHead(200, { 'content-type': `application/x-${service}-${advertise ? 'advertisement' : 'result'}`, 'content-length': data.length, 'cache-control': 'no-cache' });
  res.end(data);
}

function mergeData(repo: Repo, pull: Json): { entries: Map<string, FileEntry>; conflict: boolean } {
  const head = resolve(repo, pull.head.ref)!, base = resolve(repo, pull.base.ref)!;
  const headAncestors = ancestors(repo, head);
  const common = [...ancestors(repo, base)].find(oid => headAncestors.has(oid));
  const original = files(repo, common), left = files(repo, base), right = files(repo, head);
  let conflict = false;
  const same = (a?: FileEntry, b?: FileEntry) => a?.oid === b?.oid && a?.mode === b?.mode;
  for (const path of new Set([...original.keys(), ...right.keys()])) {
    const before = original.get(path), incoming = right.get(path), current = left.get(path);
    if (same(before, incoming)) continue;
    if (!same(current, before) && !same(current, incoming)) conflict = true;
    if (incoming) left.set(path, incoming); else left.delete(path);
  }
  return { entries: left, conflict };
}
function pullFiles(repo: Repo, pull: Json): Json[] {
  const left = files(repo, pull.base.sha), right = files(repo, pull.head.sha);
  const result: Json[] = [];
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(path), b = right.get(path);
    if (a?.oid === b?.oid) continue;
    const lines = (entry?: FileEntry) => entry ? object(repo, entry.oid).data.toString().split('\n').filter(Boolean).length : 0;
    const additions = lines(b), deletions = lines(a);
    result.push({ sha: b?.oid || a?.oid, filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions });
  }
  return result;
}

type Selection = { name: string; alias: string; args: Json; fields: Selection[]; on?: string };
/** Parse the GraphQL selection/argument syntax used by gh, without external dependencies. */
function parseGraphQL(source: string, supplied: Json, operationName?: string): { type: string; fields: Selection[] } {
  const tokens: string[] = [];
  const lexer = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[!$():=@\[\]{}]/gy;
  for (let at = 0; at < source.length;) {
    lexer.lastIndex = at;
    const token = lexer.exec(source);
    if (!token) throw new Error(`Invalid GraphQL syntax at ${at}`);
    at = lexer.lastIndex;
    if (!/^(?:\s|#|,)/.test(token[0])) tokens.push(token[0]);
  }
  let at = 0;
  const vars = { ...supplied };
  const take = (expected?: string): string => {
    const token = tokens[at++];
    if (token === undefined || (expected && token !== expected)) throw new Error(`Expected ${expected || 'token'}, found ${token}`);
    return token;
  };
  const value = (): any => {
    const token = take();
    if (token === '$') return vars[take()];
    if (token === '{') { const out: Json = {}; while (tokens[at] !== '}') { const key = take(); take(':'); out[key] = value(); } take('}'); return out; }
    if (token === '[') { const out = []; while (tokens[at] !== ']') out.push(value()); take(']'); return out; }
    if (token.startsWith('"')) return JSON.parse(token);
    if (/^-?\d/.test(token)) return Number(token);
    return token === 'null' ? null : token === 'true' ? true : token === 'false' ? false : token;
  };
  const fields = (): Selection[] => {
    take('{'); const out: Selection[] = [];
    while (tokens[at] !== '}') {
      if (tokens[at] === '...') { take(); take('on'); const on = take(); out.push({ name: '...', alias: '...', args: {}, fields: fields(), on }); continue; }
      let name = take(), alias = name;
      if (tokens[at] === ':') { take(); name = take(); }
      const args: Json = {};
      if (tokens[at] === '(') { take(); while (tokens[at] !== ')') { const key = take(); take(':'); args[key] = value(); } take(')'); }
      out.push({ name, alias, args, fields: tokens[at] === '{' ? fields() : [] });
    }
    take('}'); return out;
  };
  const operations = [];
  while (at < tokens.length) {
    let type = 'query', name = '';
    if (tokens[at] !== '{') {
      type = take(); if (!['query', 'mutation'].includes(type)) throw new Error(`Unsupported operation ${type}`);
      if (tokens[at] !== '(' && tokens[at] !== '{') name = take();
      if (tokens[at] === '(') {
        take();
        while (tokens[at] !== ')') {
          take('$'); const key = take(); take(':');
          while (tokens[at] && !['$', '=', ')'].includes(tokens[at])) take();
          if (tokens[at] === '=') { take(); const fallback = value(); if (!(key in vars)) vars[key] = fallback; }
        }
        take(')');
      }
    }
    operations.push({ type, name, fields: fields() });
  }
  const selected = operationName ? operations.find(op => op.name === operationName) : operations.length === 1 ? operations[0] : undefined;
  if (!selected) throw new Error('An operationName selecting one operation is required');
  return selected;
}

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'], Ref: ['name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  IssueConnection: ['nodes', 'pageInfo'], PullRequestConnection: ['nodes', 'pageInfo'], FileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'], PullRequestChangedFile: ['path'],
  __Type: ['name', 'kind', 'fields', 'enumValues'], __Field: ['name'], __EnumValue: ['name'],
  CreateIssuePayload: ['issue'], CloseIssuePayload: ['issue'], CreatePullRequestPayload: ['pullRequest'], MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'], CommentEdge: ['node'], IssueComment: ['id', 'body'],
};
const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
};
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_TOOLS = [
  ['create_repo', 'Create a repository for the authenticated user.', ['name'], ['name', 'description', 'private']],
  ['get_repo', 'Read a repository.', ['owner', 'repo'], ['owner', 'repo']],
  ['create_issue', 'Create an issue in a repository.', ['owner', 'repo', 'title'], ['owner', 'repo', 'title', 'body']],
  ['list_issues', 'List repository issues filtered by state.', ['owner', 'repo'], ['owner', 'repo', 'state']],
  ['create_pull_request', 'Open a pull request between existing branches.', ['owner', 'repo', 'title', 'head', 'base'], ['owner', 'repo', 'title', 'body', 'head', 'base']],
  ['merge_pull_request', 'Squash and merge a pull request.', ['owner', 'repo', 'pull_number'], ['owner', 'repo', 'pull_number']],
].map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', required, properties: Object.fromEntries((properties as string[]).map(key => [key, { type: key === 'private' ? 'boolean' : key === 'pull_number' ? 'integer' : 'string' }])) } }));

/** Each server owns an independent in-memory forge; importing this module binds no port. */
export function createApp(): Server {
  const repos = new Map<string, Repo>();
  // Bodies belong to mutable items; routes only cache lookup results, never responses or auth.
  const itemBodies = new WeakMap<Json, { data: string; length: number }>();
  const itemRoutes = new Map<string, Json>();
  const creationRoutes = new Map<string, Repo>();
  let nextId = 5000, requestId = 0;
  function sendData(res: ServerResponse, status: number, data: string, headers?: Record<string, string>, length = Buffer.byteLength(data)): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': length, 'x-github-request-id': (++requestId).toString(16).padStart(12, '0'), ...headers });
    res.end(data);
  }
  function send(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    sendData(res, status, status === 204 ? '' : JSON.stringify(body) + '\n', headers);
  }
  function sendItem(res: ServerResponse, status: number, item: Json): void {
    let cached = itemBodies.get(item);
    if (!cached) {
      const data = JSON.stringify(item) + '\n';
      cached = { data, length: Buffer.byteLength(data) }; itemBodies.set(item, cached);
    }
    sendData(res, status, cached.data, undefined, cached.length);
  }
  function content(repo: Repo, path: string, entry: FileEntry): Json {
    const data = object(repo, entry.oid).data;
    return { type: 'file', name: path.split('/').pop(), path, sha: entry.oid, size: data.length, encoding: 'base64', content: data.toString('base64') };
  }
  function createRepo(body: Json, origin: string): Repo {
    requireValue(typeof body.name === 'string' && /^[\w.-]+$/.test(body.name), 422, 'Invalid repository name');
    const key = `${LOGIN}/${body.name}`;
    requireValue(!repos.has(key), 422, 'Repository already exists');
    const id = nextId++;
    const info = { id, node_id: `R_${id}`, name: body.name, full_name: key, owner: user, private: !!body.private, description: body.description || '', default_branch: body.default_branch || 'main', created_at: NOW, updated_at: NOW, clone_url: `${origin}/${key}.git`, url: `${origin}/api/v3/repos/${key}` };
    const repo: Repo = { info, objects: new Map(), refs: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), comments: new Map(), nextNumber: 1 };
    repos.set(key, repo);
    if (body.auto_init) repo.refs.set(`refs/heads/${info.default_branch}`, commit(repo, new Map(), [], 'Initial commit'));
    return repo;
  }
  function createItem(repo: Repo, body: Json, isPull = false): Json {
    requireValue(typeof body.title === 'string' && body.title.length, 422, 'Missing title');
    const labels = body.labels ? body.labels.map((name: string) => {
      const label = repo.labels.get(name); requireValue(label, 422, 'Unknown label'); return label;
    }) : [];
    let refs: Json | undefined;
    if (isPull) {
      requireValue(typeof body.head === 'string' && typeof body.base === 'string', 422, 'Missing head or base');
      const head = resolve(repo, body.head), base = resolve(repo, body.base);
      requireValue(head && base, 422, 'Unknown head or base');
      refs = { head: { ref: body.head, sha: head }, base: { ref: body.base, sha: base }, merged: false, merged_at: null, merge_commit_sha: null };
    }
    const number = repo.nextNumber++, id = nextId++;
    const item: Json = { id, node_id: `${isPull ? 'PR' : 'I'}_${id}`, number, title: body.title, body: body.body || '', state: 'open', labels, user, created_at: NOW, updated_at: NOW };
    if (refs) Object.assign(item, refs);
    (isPull ? repo.pulls : repo.issues).set(number, item);
    return item;
  }
  function mergePull(repo: Repo, item: Json, body: Json = {}): Json {
    requireValue(!item.merged, 405, 'Pull request already merged');
    const merged = mergeData(repo, item);
    requireValue(!merged.conflict, 405, 'Pull request is conflicted');
    const oid = commit(repo, merged.entries, [resolve(repo, item.base.ref)!], body.commit_title || item.title);
    repo.refs.set(`refs/heads/${item.base.ref}`, oid);
    Object.assign(item, { state: 'closed', merged: true, merged_at: NOW, merge_commit_sha: oid });
    itemBodies.delete(item);
    return { sha: oid, merged: true, message: 'Pull request successfully merged' };
  }
  function graphql(operation: Json): Json {
    try {
      requireValue(operation && typeof operation.query === 'string', 400, 'Missing query');
      const parsed = parseGraphQL(operation.query, operation.variables || {}, operation.operationName);
      const wrap = (type: string, value: Json, repo?: Repo): Json => ({ type, value, repo });
      const repoNode = (repo?: Repo) => repo ? wrap('Repository', repo.info, repo) : null;
      const itemNode = (repo: Repo, item?: Json, pull = false) => item ? wrap(pull ? 'PullRequest' : 'Issue', item, repo) : null;
      const find = (id: string): Json | null => {
        for (const repo of repos.values()) {
          if (repo.info.node_id === id) return repoNode(repo);
          for (const item of repo.issues.values()) if (item.node_id === id) return itemNode(repo, item);
          for (const item of repo.pulls.values()) if (item.node_id === id) return itemNode(repo, item, true);
        }
        return null;
      };
      const connection = (type: string, nodes: Json[], args: Json) => {
        const start = args.after ? nodes.findIndex(n => n.value.node_id === Buffer.from(args.after, 'base64').toString()) + 1 : 0;
        const selected = nodes.slice(start, start + Math.max(0, args.first ?? 100));
        return wrap(type, { nodes: selected, pageInfo: wrap('PageInfo', { hasNextPage: start + selected.length < nodes.length, endCursor: selected.length ? Buffer.from(selected[selected.length - 1].value.node_id || String(start + selected.length)).toString('base64') : null }) });
      };
      const fieldValue = (node: Json, field: Selection): any => {
        const { type, value: v, repo } = node, a = field.args, name = field.name;
        if (name === '__typename') return type;
        if (type === 'Query') {
          if (name === 'viewer') return wrap('User', user);
          if (name === 'repository') return repoNode(repos.get(`${a.owner}/${a.name}`));
          if (name === 'node') return find(a.id);
          if (name === '__type') return GQL_FIELDS[a.name] || GQL_ENUMS[a.name] ? wrap('__Type', { name: a.name, kind: GQL_ENUMS[a.name] ? 'ENUM' : 'OBJECT', fields: GQL_FIELDS[a.name]?.map(name => wrap('__Field', { name })) || null, enumValues: GQL_ENUMS[a.name]?.map(name => wrap('__EnumValue', { name })) || null }) : null;
        }
        if (type === 'Repository') {
          if (name === 'id') return v.node_id;
          if (name === 'databaseId') return v.id;
          if (name === 'nameWithOwner') return v.full_name;
          if (name === 'owner') return wrap('User', v.owner);
          if (name === 'defaultBranchRef') return resolve(repo, v.default_branch) ? wrap('Ref', { name: v.default_branch }) : null;
          if (name === 'viewerPermission') return 'ADMIN';
          if (name === 'hasIssuesEnabled') return true;
          if (name === 'issue' || name === 'pullRequest') return itemNode(repo, (name === 'issue' ? repo.issues : repo.pulls).get(a.number), name === 'pullRequest');
          if (name === 'issues' || name === 'pullRequests') {
            const pull = name === 'pullRequests';
            let list = [...(pull ? repo.pulls : repo.issues).values()].filter(i => !a.states || a.states.includes(i.merged ? 'MERGED' : i.state.toUpperCase()));
            const direction = a.orderBy?.direction === 'ASC' ? 1 : -1;
            const orderField = a.orderBy?.field === 'UPDATED_AT' ? 'updated_at' : 'created_at';
            list.sort((x, y) => direction * (String(x[orderField]).localeCompare(String(y[orderField])) || x.number - y.number));
            return connection(pull ? 'PullRequestConnection' : 'IssueConnection', list.map(i => itemNode(repo, i, pull)!), a);
          }
        }
        if (type === 'Issue' || type === 'PullRequest') {
          if (name === 'id') return v.node_id;
          if (name === 'state') return v.merged ? 'MERGED' : v.state.toUpperCase();
          if (name === 'headRefName') return v.head.ref;
          if (name === 'baseRefName') return v.base.ref;
          if (name === 'mergeable') return mergeData(repo, v).conflict ? 'CONFLICTING' : 'MERGEABLE';
          if (name === 'files') return connection('FileConnection', pullFiles(repo, v).map(f => wrap('PullRequestChangedFile', { path: f.filename })), a);
        }
        if (type === 'Mutation') {
          const input = a.input || {}, target = find(input.repositoryId || input.issueId || input.pullRequestId || input.subjectId);
          requireValue(target, 422, 'Unknown node');
          const repo = target.repo;
          if (name === 'createIssue') return wrap('CreateIssuePayload', { issue: itemNode(repo, createItem(repo, input)) });
          if (name === 'closeIssue') { target.value.state = 'closed'; itemBodies.delete(target.value); return wrap('CloseIssuePayload', { issue: target }); }
          if (name === 'createPullRequest') return wrap('CreatePullRequestPayload', { pullRequest: itemNode(repo, createItem(repo, { ...input, head: input.headRefName, base: input.baseRefName }, true), true) });
          if (name === 'mergePullRequest') { mergePull(repo, target.value); return wrap('MergePullRequestPayload', { pullRequest: target }); }
          if (name === 'addComment') {
            requireValue(typeof input.body === 'string', 422, 'Missing comment body');
            const comment = { id: nextId++, body: input.body, user, created_at: NOW };
            const list = repo.comments.get(target.value.number) || []; list.push(comment); repo.comments.set(target.value.number, list);
            return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node: wrap('IssueComment', { ...comment, id: `IC_${comment.id}` }) }) });
          }
        }
        return v[name] ?? null;
      };
      const project = (node: any, fields: Selection[]): any => {
        if (node === null || node === undefined) return null;
        if (Array.isArray(node)) return node.map(n => project(n, fields));
        if (!fields.length) return node;
        const out: Json = {};
        for (const field of fields) {
          if (field.name === '...') { if (field.on === node.type) Object.assign(out, project(node, field.fields)); continue; }
          if (field.name !== '__typename' && !GQL_FIELDS[node.type]?.includes(field.name)) throw new Error(`Cannot query field "${field.name}" on type "${node.type}".`);
          out[field.alias] = project(fieldValue(node, field), field.fields);
        }
        return out;
      };
      return { data: project(wrap(parsed.type === 'mutation' ? 'Mutation' : 'Query', {}), parsed.fields) };
    } catch (err) { return { errors: [{ message: err instanceof Error ? err.message : 'Invalid query' }] }; }
  }
  function mcpResponse(body: Json, origin: string): Json {
    const id = body?.id ?? null;
    const error = (code: number, message: string, data?: Json) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return error(-32600, 'Invalid Request');
    const p = body.params || {}, revision = body.method === 'initialize' ? p.protocolVersion : p._meta?.['io.modelcontextprotocol/protocolVersion'] || p._meta?.protocolVersion;
    if (revision && !MCP_VERSIONS.includes(revision)) return error(-32022, 'Unsupported protocol version', { supported: MCP_VERSIONS });
    const identity = { serverInfo: { name: 'memory-forge', version: '1.0.0' }, capabilities: { tools: {} } };
    let result: any;
    if (body.method === 'server/discover') result = { ...identity, supportedVersions: MCP_VERSIONS };
    else if (body.method === 'initialize') result = { ...identity, protocolVersion: revision || '2025-11-25' };
    else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list') result = { tools: MCP_TOOLS };
    else if (body.method === 'tools/call') {
      const tool = MCP_TOOLS.find(t => t.name === p.name);
      if (!tool) return error(-32602, `Unknown tool ${p.name}`);
      const args = p.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Expected tool arguments');
      for (const key of tool.inputSchema.required as string[]) {
        const type = tool.inputSchema.properties[key].type;
        if (type === 'integer' ? !Number.isInteger(args[key]) || args[key] <= 0 : typeof args[key] !== type || args[key] === '') return error(-32602, `Missing or invalid argument ${key}`);
      }
      try {
        let value: any;
        if (p.name === 'create_repo') value = createRepo(args, origin).info;
        else {
          const repo = repos.get(`${args.owner}/${args.repo}`); requireValue(repo, 404, 'Not Found');
          if (p.name === 'get_repo') value = repo.info;
          if (p.name === 'create_issue') value = createItem(repo, args);
          if (p.name === 'list_issues') value = [...repo.issues.values()].filter(i => args.state === 'all' || i.state === (args.state || 'open').toLowerCase()).sort((a, b) => b.number - a.number);
          if (p.name === 'create_pull_request') value = createItem(repo, args, true);
          if (p.name === 'merge_pull_request') { const pull = repo.pulls.get(args.pull_number); requireValue(pull, 404, 'Not Found'); value = mergePull(repo, pull); }
        }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
      } catch (err) { result = { content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool failed' }], isError: true }; }
    } else return error(-32601, `Unknown method ${body.method}`);
    return { jsonrpc: '2.0', id, result };
  }
  function handle(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
    try {
      const method = req.method || 'GET', requestUrl = req.url || '/';
      const cachedItem = method === 'GET' ? itemRoutes.get(requestUrl) : undefined;
      const cachedCreation = method === 'POST' ? creationRoutes.get(requestUrl) : undefined;
      if (cachedItem || cachedCreation) {
        requireValue(process.env.MAKEFUN_SHOP_TOKEN && req.headers.authorization === `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`, 401, 'Bad credentials');
        let body: Json | undefined;
        if (raw.length) {
          try { body = JSON.parse(raw.toString()); } catch { throw new HttpError(400, 'Malformed JSON'); }
          requireValue(body && typeof body === 'object' && !Array.isArray(body), 400, 'Expected a JSON object');
        }
        return sendItem(res, cachedItem ? 200 : 201, cachedItem || createItem(cachedCreation!, body || {}));
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = decodeURIComponent(url.pathname);
      if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
      const api = path === '/api' || path.startsWith('/api/'), mcp = path === '/mcp' || path.startsWith('/mcp/');
      if (api || mcp) requireValue(process.env.MAKEFUN_SHOP_TOKEN && req.headers.authorization === `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`, 401, 'Bad credentials');
      const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (git) {
        const repo = repos.get(`${git[1]}/${git[2]}`);
        requireValue(repo, 404, 'Not Found');
        const advertise = git[3] === 'info/refs', service = advertise ? url.searchParams.get('service') : git[3];
        requireValue((service === 'git-upload-pack' || service === 'git-receive-pack') && method === (advertise ? 'GET' : 'POST'), 404, 'Not Found');
        return gitResponse(req, res, repo, service, advertise, raw);
      }
      let body: Json = {};
      if (raw.length) { try { body = JSON.parse(raw.toString()); } catch {
        if (path === '/mcp') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        throw new HttpError(400, 'Malformed JSON');
      } }
      if (path === '/api/graphql' && method === 'POST') return send(res, 200, Array.isArray(body) ? body.map(graphql) : graphql(body));
      if (path === '/mcp' && method === 'POST') {
        const response = mcpResponse(body, url.origin);
        if (body?.jsonrpc === '2.0' && typeof body.method === 'string' && !('id' in body)) return send(res, 204, null);
        return send(res, 200, response);
      }
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 400, 'Expected a JSON object');
      const route = path.replace(/^\/api\/v3\/?/, '').replace(/\/$/, '');
      if (!path.startsWith('/api/v3')) return send(res, 404, { message: 'Not Found' });
      const page = <T>(list: T[]): void => {
        const size = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30)), n = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const headers: Record<string, string> = {};
        if (n * size < list.length) { const next = new URL(url); next.searchParams.set('page', String(n + 1)); headers.link = `<${next}>; rel="next"`; }
        send(res, 200, list.slice((n - 1) * size, n * size), headers);
      };
      if (!route && method === 'GET') return send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      if (route === 'meta' && method === 'GET') return send(res, 200, { installed_version: 'memory-forge/1.0' });
      if (route === 'user' && method === 'GET') return send(res, 200, user);
      if (route === 'user/repos') {
        if (method === 'GET') return page([...repos.values()].map(r => r.info));
        if (method === 'POST') {
          return send(res, 201, createRepo(body, url.origin).info);
        }
      }
      const match = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(route);
      requireValue(match, 404, 'Not Found');
      const key = `${match[1]}/${match[2]}`, repo = repos.get(key), tail = match[3] || '';
      requireValue(repo, 404, 'Not Found');
      if (!tail) {
        if (method === 'GET') return send(res, 200, repo.info);
        if (method === 'PATCH') { for (const field of ['description', 'default_branch', 'private']) if (field in body) repo.info[field] = body[field]; return send(res, 200, repo.info); }
        if (method === 'DELETE') { repos.delete(key); itemRoutes.clear(); creationRoutes.clear(); return send(res, 204, null); }
      }
      if (tail === 'git/refs' && method === 'POST') {
        requireValue(typeof body.ref === 'string' && body.ref.startsWith('refs/') && repo.objects.has(body.sha) && !repo.refs.has(body.ref), 422, 'Invalid reference');
        repo.refs.set(body.ref, body.sha); return send(res, 201, { ref: body.ref, object: { type: object(repo, body.sha).type, sha: body.sha } });
      }
      if (tail.startsWith('git/refs/') && method === 'GET') {
        const ref = tail.slice(9), oid = repo.refs.get('refs/' + ref);
        requireValue(oid, 404, 'Not Found'); return send(res, 200, { ref: 'refs/' + ref, object: { sha: oid, type: object(repo, oid).type } });
      }
      if (tail === 'branches' && method === 'GET') return page([...repo.refs].filter(([r]) => r.startsWith('refs/heads/')).map(([r, sha]) => ({ name: r.slice(11), commit: { sha } })));
      if (tail.startsWith('branches/') && method === 'GET') { const name = tail.slice(9), oid = repo.refs.get('refs/heads/' + name); requireValue(oid, 404, 'Not Found'); return send(res, 200, { name, commit: { sha: oid } }); }
      if (tail === 'commits' && method === 'GET') {
        const tip = resolve(repo, url.searchParams.get('sha') || undefined);
        return page(tip ? [...ancestors(repo, tip)].map(sha => ({ sha, commit: { message: commitView(repo, sha).message } })) : []);
      }
      if (tail === 'contents' || tail.startsWith('contents/')) {
        const path = tail.slice(9), branch = body.branch || repo.info.default_branch;
        const tip = resolve(repo, method === 'GET' ? url.searchParams.get('ref') || undefined : branch);
        const entries = files(repo, tip), current = entries.get(path);
        if (method === 'GET') {
          if (current) return send(res, 200, content(repo, path, current));
          const prefix = path ? path + '/' : '', names = new Map<string, Json>();
          for (const [file, entry] of entries) if (file.startsWith(prefix)) {
            const name = file.slice(prefix.length).split('/')[0], child = prefix + name;
            names.set(name, file === child ? content(repo, file, entry) : { type: 'dir', name, path: child, sha: buildTree(repo, new Map([...entries].filter(([p]) => p.startsWith(child + '/')).map(([p, f]) => [p.slice(child.length + 1), f]))) });
          }
          requireValue(names.size || !path, 404, 'Not Found'); return send(res, 200, [...names.values()]);
        }
        if (method === 'PUT' || method === 'DELETE') {
          requireValue(path && !path.split('/').some(p => !p || p === '.' || p === '..'), 422, 'Invalid file path');
          if (method === 'DELETE') requireValue(current, 404, 'Not Found');
          requireValue(current ? body.sha === current.oid : !body.sha, 409, 'File SHA does not match');
          if (method === 'DELETE') entries.delete(path);
          else { requireValue(typeof body.content === 'string', 422, 'Missing content'); entries.set(path, { oid: put(repo, 'blob', Buffer.from(body.content, 'base64')), mode: current?.mode || '100644' }); }
          const oid = commit(repo, entries, tip ? [tip] : [], body.message || 'Update file');
          repo.refs.set(`refs/heads/${branch}`, oid);
          return send(res, method === 'PUT' && !current ? 201 : 200, { content: entries.has(path) ? content(repo, path, entries.get(path)!) : null, commit: { sha: oid } });
        }
      }
      if (tail === 'labels' && method === 'POST') { requireValue(typeof body.name === 'string', 422, 'Missing label name'); const label = { id: nextId++, name: body.name, color: body.color || 'ededed' }; repo.labels.set(body.name, label); return send(res, 201, label); }
      if (tail === 'issues' || tail === 'pulls') {
        const isPull = tail === 'pulls', store = isPull ? repo.pulls : repo.issues;
        if (method === 'GET') {
          const state = url.searchParams.get('state') || 'open', direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
          return page([...store.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => direction * (a.number - b.number)));
        }
        if (method === 'POST') {
          const item = createItem(repo, body, isPull);
          if (!isPull) { if (creationRoutes.size >= 4096) creationRoutes.clear(); creationRoutes.set(requestUrl, repo); }
          return sendItem(res, 201, item);
        }
      }
      const itemMatch = /^(issues|pulls)\/(\d+)(?:\/(comments|files|merge))?$/.exec(tail);
      if (itemMatch) {
        const number = Number(itemMatch[2]), isPull = itemMatch[1] === 'pulls', item = (isPull ? repo.pulls : repo.issues).get(number), action = itemMatch[3];
        requireValue(item, 404, 'Not Found');
        if (!action && method === 'GET') { if (itemRoutes.size >= 4096) itemRoutes.clear(); itemRoutes.set(requestUrl, item); return sendItem(res, 200, item); }
        if (!action && method === 'PATCH') { for (const field of ['title', 'body', 'state']) if (field in body) item[field] = body[field]; itemBodies.delete(item); return sendItem(res, 200, item); }
        if (action === 'comments') {
          const list = repo.comments.get(number) || [];
          if (method === 'GET') return page(list);
          if (method === 'POST') { requireValue(typeof body.body === 'string', 422, 'Missing comment body'); const comment = { id: nextId++, body: body.body, user, created_at: NOW }; list.push(comment); repo.comments.set(number, list); return send(res, 201, comment); }
        }
        if (isPull && action === 'files' && method === 'GET') return page(pullFiles(repo, item));
        if (isPull && action === 'merge' && method === 'PUT') {
          return send(res, 200, mergePull(repo, item, body));
        }
      }
      send(res, 404, { message: 'Not Found' });
    } catch (err) {
      send(res, err instanceof HttpError ? err.status : 400, { message: err instanceof Error ? err.message : 'Bad request' });
    }
  }
  return createServer((req, res) => {
    // Empty requests can dispatch immediately; body-bearing requests retain their original buffers.
    if (!req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0')) {
      handle(req, res, EMPTY);
      return;
    }
    let first: Buffer | undefined;
    let chunks: Buffer[] | undefined;
    req.on('data', (chunk: Buffer) => {
      if (!first) first = chunk;
      else if (chunks) chunks.push(chunk);
      else chunks = [first, chunk];
    });
    req.on('end', () => handle(req, res, chunks ? Buffer.concat(chunks) : first || EMPTY));
    req.on('error', () => { if (!res.writableEnded) res.destroy(); });
  });
}
