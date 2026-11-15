import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { executeGraphQL } from './graphql.ts';
import { executeMcp, mcpError } from './mcp.ts';
import { store, ZERO_OID, isOid, readGitCommit, readGitTag, gitObjectLinks, gitReachable, readGitPack, writeGitPack, prepareGitObjects, type GitObject, type Issue, type Label, type PullRequest, type Repository } from './store.ts';

let requestId = 0;
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json');
  for (const [key, valueHeader] of Object.entries(headers)) res.setHeader(key, valueHeader);
  if (status === 204) { res.end(); return; } res.end(JSON.stringify(value));
};
const error = (res: ServerResponse, status: number, message: string): void => json(res, status, { message });
const now = (): string => store.getTimestamp();
const nodeId = (kind: string, id: number): string => Buffer.from(`${kind}:${id}`).toString('base64');
async function bodyOf(req: IncomingMessage): Promise<{ value?: any; malformed: boolean }> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return { malformed: false }; try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), malformed: false }; } catch { return { malformed: true }; }
}
function repoJson(repo: Repository, owner = repo.owner ?? ''): any { return { id: repo.id, node_id: nodeId('Repository', repo.id), name: repo.name, full_name: repo.full_name, owner: { login: owner, id: 1, type: 'User' }, private: repo.private, description: repo.description, default_branch: repo.default_branch, created_at: repo.created_at, updated_at: repo.updated_at, has_issues: true, open_issues_count: repo.issues.size, url: `/api/v3/repos/${owner}/${repo.name}` }; }
function labelJson(label: Label): any { return { id: label.id, node_id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description }; }
function issueJson(issue: Issue): any { const { comments: _comments, ...rest } = issue; return { ...rest, labels: issue.labels.map(labelJson), url: `/api/v3/issues/${issue.number}` }; }
function pullJson(pull: PullRequest): any { return { ...pull, head: { ...pull.head }, base: { ...pull.base } }; }
function refKey(ref: string): string { return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`; }
function snapshot(repo: Repository, sha: string | undefined): Map<string, { sha: string; data: Buffer }> { return sha ? (repo.commitFiles.get(sha) ?? new Map()) : new Map(); }
function treeObject(repo: Repository, files: Map<string, { sha: string; data: Buffer }>): string {
  type Entry = { name: string; mode: string; sha: string; children?: Map<string, Entry> }; const root = new Map<string, Entry>();
  for (const [path, file] of files) { const parts = path.split('/'); let level = root; for (let i = 0; i < parts.length - 1; i++) { const part = parts[i]!; let entry = level.get(part); if (!entry) { entry = { name: part, mode: '40000', sha: '', children: new Map() }; level.set(part, entry); } level = entry.children!; } level.set(parts[parts.length - 1]!, { name: parts[parts.length - 1]!, mode: '100644', sha: file.sha }); }
  const build = (entries: Map<string, Entry>): string => { const chunks: Buffer[] = []; for (const entry of [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))) { const sha = entry.children ? build(entry.children) : entry.sha; chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(sha, 'hex')); } return store.writeObject(repo, 'tree', Buffer.concat(chunks)).sha; };
  return build(root);
}
function makeCommit(repo: Repository, branch: string, files: Map<string, { sha: string; data: Buffer }>, message: string): { sha: string; tree: string } {
  const parent = repo.refs.get(refKey(branch)); const tree = treeObject(repo, files); const lines = [`tree ${tree}`]; if (parent) lines.push(`parent ${parent}`); lines.push('author Forge <forge@example.invalid> 1577836800 +0000', 'committer Forge <forge@example.invalid> 1577836800 +0000', '', message, ''); const object = store.writeObject(repo, 'commit', lines.join('\n')); repo.commits.set(object.sha, { sha: object.sha, tree, parents: parent ? [parent] : [], message, author: 'Forge <forge@example.invalid>', timestamp: now() }); repo.commitFiles.set(object.sha, new Map(files)); repo.files = new Map(files); repo.refs.set(refKey(branch), object.sha); repo.updated_at = now(); return { sha: object.sha, tree };
}
function commitHistory(repo: Repository, start: string | undefined): string[] { const out: string[] = []; let cur = start; while (cur) { out.push(cur); cur = repo.commits.get(cur)?.parents[0]; } return out; }
function resolveCommit(repo: Repository, ref: string | null): string | undefined { if (!ref) return repo.refs.get(`refs/heads/${repo.default_branch}`); return repo.refs.get(refKey(ref)) ?? (repo.commits.has(ref) ? ref : undefined); }

// REST, GraphQL and MCP share the Git-derived file list and squash commit.
function createPull(repo: Repository, title: string, head: string, base: string, body: string): PullRequest | null {
  const pull = store.createPullRequest(repo, title, head, base, body);
  if (!pull) return null;
  const baseFiles = snapshot(repo, pull.base.sha); const headFiles = snapshot(repo, pull.head.sha);
  pull.files = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter(key => baseFiles.get(key)?.sha !== headFiles.get(key)?.sha).map(filename => {
    const before = baseFiles.get(filename)?.data.toString() ?? ''; const after = headFiles.get(filename)?.data.toString() ?? '';
    const additions = after ? Math.max(1, after.split(/\r?\n/).length - (before ? before.split(/\r?\n/).length : 0)) : 0;
    return { filename, status: before ? (after ? 'modified' : 'removed') : 'added', additions, deletions: before ? Math.max(0, before.split(/\r?\n/).length - (after ? after.split(/\r?\n/).length : 0)) : 0, changes: Math.max(1, additions) };
  });
  return pull;
}
class PullMergeError extends Error {}
function mergePull(repo: Repository, pull: PullRequest): string {
  if (pull.state !== 'open') throw new PullMergeError('Pull request is not mergeable');
  const current = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (current !== pull.base.sha) throw new PullMergeError('Pull request has conflicts');
  const files = new Map(snapshot(repo, pull.base.sha));
  for (const [key, value] of snapshot(repo, pull.head.sha)) files.set(key, value);
  const merge = makeCommit(repo, repo.default_branch, files, `Squash merge #${pull.number}`);
  store.mergePullRequest(repo, pull.number, merge.sha);
  return merge.sha;
}

const GIT_FLUSH = Buffer.from('0000');
const GIT_DELIM = Buffer.from('0001');
const GIT_AGENT = 'makefun-forge/1.0';
const MAX_GIT_REQUEST = 64 * 1024 * 1024;
function pktLine(value: string | Buffer): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  if (data.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

/** Receive-pack stops at its command flush; all remaining bytes belong to its pack. */
function readGitPackets(data: Buffer, stopAtFlush = false): { packets: Array<string | number>; offset: number } {
  const packets: Array<string | number> = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw new Error('Truncated packet header');
    const header = data.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('Invalid packet header');
    const size = Number.parseInt(header, 16);
    if (size < 3) {
      packets.push(size); offset += 4;
      if (packets.length > 100000) throw new Error('Too many packets');
      if (size === 0 && stopAtFlush) return { packets, offset };
      continue;
    }
    if (size < 4 || size > 65520 || offset + size > data.length) throw new Error('Invalid packet length');
    const payload = data.subarray(offset + 4, offset + size);
    // Commands are textual; binary bytes are only allowed in the trailing pack.
    if (payload.includes(13) || payload.includes(10) && payload.indexOf(10) !== payload.length - 1) throw new Error('Invalid command line');
    packets.push(payload.toString('utf8').replace(/\n$/, '')); offset += size;
    if (packets.length > 100000) throw new Error('Too many packets');
  }
  if (stopAtFlush) throw new Error('Missing command flush');
  return { packets, offset };
}

function sideband(data: Buffer, band = 1): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) parts.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + 65515)])));
  return parts;
}

function gitReply(res: ServerResponse, service: string, data: Buffer, advertisement = false): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', `application/x-${service}-${advertisement ? 'advertisement' : 'result'}`);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Length', data.length);
  res.end(data);
}

function peeledOid(repo: Repository, sha: string): string | undefined {
  const seen = new Set<string>(); let current = sha;
  while (repo.objects.get(current)?.type === 'tag') {
    if (seen.has(current)) throw new Error('Tag cycle');
    seen.add(current); current = readGitTag(repo.objects.get(current)!.data).sha;
  }
  return current === sha ? undefined : current;
}

function advertisedRefs(repo: Repository): Array<[string, string]> {
  const refs = [...repo.refs].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  return head ? [['HEAD', head], ...refs] : refs;
}

function gitAdvertisement(repo: Repository, service: string, v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) return Buffer.concat([
    ...['version 2\n', `agent=${GIT_AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pktLine), GIT_FLUSH,
  ]);
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=${GIT_AGENT}`
    : `side-band-64k shallow no-progress ofs-delta object-format=sha1 agent=${GIT_AGENT} symref=HEAD:refs/heads/${repo.default_branch}`;
  const refs = advertisedRefs(repo);
  if (!refs.length) refs.push(['capabilities^{}', ZERO_OID]);
  const parts = [pktLine(`# service=${service}\n`), GIT_FLUSH];
  refs.forEach(([name, sha], index) => {
    parts.push(pktLine(`${sha} ${name}${index === 0 ? `\0${caps}` : ''}\n`));
    const peeled = peeledOid(repo, sha);
    if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
  });
  return Buffer.concat([...parts, GIT_FLUSH]);
}

function lsGitRefs(repo: Repository, args: string[]): Buffer {
  for (const arg of args) if (!['peel', 'symrefs', 'unborn'].includes(arg) && !arg.startsWith('ref-prefix ')) throw new Error('Unsupported ls-refs argument');
  const prefixes = args.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
  const keep = (name: string): boolean => !prefixes.length || prefixes.some(prefix => name.startsWith(prefix));
  const lines: Buffer[] = [];
  for (const [name, sha] of advertisedRefs(repo)) {
    if (!keep(name)) continue;
    const attrs: string[] = [];
    if (name === 'HEAD' && args.includes('symrefs')) attrs.push(`symref-target:refs/heads/${repo.default_branch}`);
    const peeled = args.includes('peel') ? peeledOid(repo, sha) : undefined;
    if (peeled) attrs.push(`peeled:${peeled}`);
    lines.push(pktLine(`${sha} ${name}${attrs.length ? ' ' + attrs.join(' ') : ''}\n`));
  }
  if (!repo.refs.has(`refs/heads/${repo.default_branch}`) && keep('HEAD') && args.includes('unborn')) lines.unshift(pktLine(`unborn HEAD${args.includes('symrefs') ? ` symref-target:refs/heads/${repo.default_branch}` : ''}\n`));
  return Buffer.concat([...lines, GIT_FLUSH]);
}

function fetchGitObjects(repo: Repository, args: string[], v2: boolean): Buffer {
  const wants: string[] = []; const haves: string[] = []; const shallow = new Set<string>();
  let depth: number | undefined; let noProgress = false; let done = false; let useSideband = v2;
  for (const line of args) {
    const [key, value, ...caps] = line.split(' ');
    if (['want', 'have', 'shallow'].includes(key!)) {
      if (!value || !isOid(value) || caps.length && (v2 || key !== 'want')) throw new Error('Invalid fetch object id');
      if (key === 'want') { if (!repo.objects.has(value)) throw new Error('Unknown wanted object'); wants.push(value); }
      else if (key === 'have') haves.push(value);
      else { if (repo.objects.get(value)?.type !== 'commit') throw new Error('Invalid shallow object'); shallow.add(value); }
      if (caps.includes('no-progress')) noProgress = true;
      if (caps.includes('side-band-64k')) useSideband = true;
    } else if (key === 'deepen') {
      if (depth !== undefined || !value || !/^[1-9][0-9]*$/.test(value) || caps.length || !Number.isSafeInteger(Number(value))) throw new Error('Invalid deepen value');
      depth = Number(value);
    } else if (line === 'no-progress') noProgress = true;
    else if (line === 'done') done = true;
    else if (!['thin-pack', 'ofs-delta'].includes(line)) throw new Error('Unsupported fetch argument');
  }
  if (!wants.length) throw new Error('Missing want');
  const lookup = (sha: string): GitObject | undefined => repo.objects.get(sha);
  const held = gitReachable(haves.filter(sha => repo.objects.has(sha)), lookup, shallow);
  const selected = new Set<string>(); const boundaries = new Set<string>();
  const distances = new Map<string, number>();
  const queue = wants.map(sha => ({ sha, generation: 1 }));
  // Breadth first traversal gives the shortest distance for commits with multiple parents/tips.
  for (let i = 0; i < queue.length; i++) {
    const { sha, generation } = queue[i]!;
    if ((distances.get(sha) ?? Infinity) <= generation) continue;
    distances.set(sha, generation);
    const object = lookup(sha); if (!object) throw new Error('Missing reachable object');
    selected.add(sha);
    if (object.type === 'commit') {
      const commit = readGitCommit(object.data);
      queue.push({ sha: commit.tree, generation });
      if (depth !== undefined ? generation >= depth : shallow.has(sha)) {
        if (commit.parents.length) boundaries.add(sha);
      } else { boundaries.delete(sha); for (const parent of commit.parents) queue.push({ sha: parent, generation: generation + 1 }); }
    } else for (const link of gitObjectLinks(object)) queue.push({ sha: link.sha, generation });
  }
  const parts: Buffer[] = [];
  if (v2 && !done) {
    parts.push(pktLine('acknowledgments\n'));
    const common = haves.filter(sha => repo.objects.has(sha));
    parts.push(...(common.length ? common.map(sha => pktLine(`ACK ${sha}\n`)) : [pktLine('NAK\n')]));
    // Without done, advertise readiness only after finding a common object.
    if (!common.length) return Buffer.concat([...parts, GIT_FLUSH]);
    parts.push(pktLine('ready\n'), GIT_DELIM);
  }
  const shallowLines = [...boundaries].filter(sha => !shallow.has(sha)).map(sha => `shallow ${sha}\n`);
  for (const sha of shallow) if (selected.has(sha) && !boundaries.has(sha)) shallowLines.push(`unshallow ${sha}\n`);
  if (shallowLines.length) {
    if (v2) parts.push(pktLine('shallow-info\n'));
    parts.push(...shallowLines.map(pktLine), v2 ? GIT_DELIM : GIT_FLUSH);
  }
  const pack = writeGitPack([...selected].filter(sha => !held.has(sha)).map(sha => repo.objects.get(sha)!));
  if (v2) parts.push(pktLine('packfile\n'));
  else parts.push(pktLine('NAK\n'));
  if (useSideband) {
    if (!noProgress) parts.push(...sideband(Buffer.from('Enumerating objects: done.\n'), 2));
    parts.push(...sideband(pack), GIT_FLUSH);
  } else parts.push(pack);
  return Buffer.concat(parts);
}

function uploadGit(repo: Repository, data: Buffer, v2: boolean): Buffer {
  const { packets } = readGitPackets(data);
  if (packets[packets.length - 1] !== 0) throw new Error('Missing request flush');
  if (v2) {
    const delim = packets.indexOf(1);
    if (delim < 1 || packets.slice(0, delim).some(line => typeof line !== 'string')) throw new Error('Missing command delimiter');
    const [command, ...headers] = packets.slice(0, delim) as string[];
    if (headers.some(line => !line.startsWith('agent=') && line !== 'object-format=sha1')) throw new Error('Unsupported command capability');
    const args = packets.slice(delim + 1, -1);
    if (args.some(line => typeof line !== 'string' || line.includes('\0'))) throw new Error('Unexpected command control');
    if (command === 'command=ls-refs') return lsGitRefs(repo, args as string[]);
    if (command === 'command=fetch') return fetchGitObjects(repo, args as string[], true);
    throw new Error('Unsupported upload-pack command');
  }
  if (packets.some(line => typeof line === 'number' && line !== 0 || typeof line === 'string' && line.includes('\0'))) throw new Error('Invalid v0 fetch request');
  return fetchGitObjects(repo, packets.filter(line => typeof line === 'string') as string[], false);
}

function validGitRef(ref: string): boolean {
  return ref.startsWith('refs/') && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function receiveGit(repo: Repository, data: Buffer): Buffer {
  const { packets, offset } = readGitPackets(data, true);
  const lines = packets.slice(0, -1);
  if (!lines.length || lines.some(line => typeof line !== 'string')) throw new Error('Invalid push commands');
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  const seen = new Set<string>(); let caps: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const split = (lines[i] as string).split('\0');
    if (split.length > 2 || i > 0 && split.length !== 1) throw new Error('Invalid push capabilities');
    if (!i) caps = (split[1] ?? '').split(' ').filter(Boolean);
    const fields = split[0]!.split(' ');
    if (fields.length !== 3 || !isOid(fields[0]!) || !isOid(fields[1]!) || !validGitRef(fields[2]!) || seen.has(fields[2]!)) throw new Error('Invalid push command');
    seen.add(fields[2]!); commands.push({ old: fields[0]!, next: fields[1]!, ref: fields[2]! });
  }
  if (caps.some(cap => !['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'object-format=sha1'].includes(cap) && !cap.startsWith('agent='))) throw new Error('Unsupported push capability');
  let unpackError = ''; let incoming = new Map<string, GitObject>();
  let prepared: ReturnType<typeof prepareGitObjects> | undefined;
  try {
    if (offset < data.length) incoming = readGitPack(data.subarray(offset), sha => repo.objects.get(sha));
    else if (commands.some(command => command.next !== ZERO_OID)) throw new Error('Missing pack');
    prepared = prepareGitObjects(repo, incoming);
  } catch (err) { unpackError = err instanceof Error ? err.message : 'Invalid pack'; }
  const lookup = (sha: string): GitObject | undefined => incoming.get(sha) ?? repo.objects.get(sha);
  const ancestor = (old: string, next: string): boolean => {
    const queue = [next]; const visited = new Set<string>();
    while (queue.length) {
      const sha = queue.pop()!; if (sha === old) return true;
      if (visited.has(sha)) continue; visited.add(sha);
      const object = lookup(sha); if (object?.type === 'commit') queue.push(...readGitCommit(object.data).parents);
    }
    return false;
  };
  const verdicts = commands.map(command => {
    if (unpackError) return 'unpacker error';
    if ((repo.refs.get(command.ref) ?? ZERO_OID) !== command.old) return 'stale old object id';
    if (command.next === ZERO_OID) return command.old === ZERO_OID ? 'missing ref' : '';
    if (!lookup(command.next)) return 'missing object';
    if (command.ref.startsWith('refs/heads/') && lookup(command.next)?.type !== 'commit') return 'branch requires commit';
    if (command.old !== ZERO_OID && command.old !== command.next && (lookup(command.old)?.type !== 'commit' || lookup(command.next)?.type !== 'commit' || !ancestor(command.old, command.next))) return 'non-fast-forward';
    // Ref namespaces cannot contain both a ref and one of its descendants.
    if ([...repo.refs.keys(), ...commands.map(c => c.ref)].some(ref => ref !== command.ref && (ref.startsWith(command.ref + '/') || command.ref.startsWith(ref + '/')))) return 'ref name conflict';
    return '';
  });
  if (!unpackError && prepared) {
    for (const [sha, object] of incoming) repo.objects.set(sha, object);
    for (const [sha, commit] of prepared.commits) repo.commits.set(sha, commit);
    for (const [sha, files] of prepared.snapshots) repo.commitFiles.set(sha, files);
    commands.forEach((command, i) => {
      if (verdicts[i]) return;
      if (command.next === ZERO_OID) store.deleteRef(repo, command.ref);
      else store.setRef(repo, command.ref, command.next);
    });
    const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
    repo.files = new Map(tip ? repo.commitFiles.get(tip) : undefined);
  }
  if (!caps.includes('report-status')) return GIT_FLUSH;
  const report = Buffer.concat([
    pktLine(`unpack ${unpackError || 'ok'}\n`),
    ...commands.map((command, i) => pktLine(verdicts[i] ? `ng ${command.ref} ${verdicts[i]}\n` : `ok ${command.ref}\n`)), GIT_FLUSH,
  ]);
  return caps.includes('side-band-64k') ? Buffer.concat([...sideband(report), GIT_FLUSH]) : report;
}

async function handleGit(req: IncomingMessage, res: ServerResponse, parsed: URL): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(parsed.pathname);
  if (!match) return false;
  try {
    const owner = decodeURIComponent(match[1]!); const name = decodeURIComponent(match[2]!);
    if (owner.includes('/') || name.includes('/')) { error(res, 404, 'Not Found'); return true; }
    const service = match[3] === 'info/refs' ? parsed.searchParams.get('service') : match[3];
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { error(res, 400, 'Unsupported Git service'); return true; }
    if (req.method !== (match[3] === 'info/refs' ? 'GET' : 'POST')) { error(res, 405, 'Method Not Allowed'); return true; }
    const repo = store.getRepository(owner, name);
    if (!repo) { error(res, 404, 'Not Found'); return true; }
    const v2 = String(req.headers['git-protocol'] ?? '').split(':').some(value => value.trim() === 'version=2');
    if (match[3] === 'info/refs') { gitReply(res, service, gitAdvertisement(repo, service, v2), true); return true; }
    if (req.headers['content-type']?.split(';')[0]?.trim() !== `application/x-${service}-request`) { error(res, 415, 'Unsupported Media Type'); return true; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > MAX_GIT_REQUEST) { error(res, 413, 'Git request too large'); return true; } chunks.push(bytes); }
    const data = Buffer.concat(chunks, size);
    gitReply(res, service, service === 'git-receive-pack' ? receiveGit(repo, data) : uploadGit(repo, data, v2));
  } catch (err) { error(res, 400, err instanceof Error ? err.message : 'Malformed Git request'); }
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('X-GitHub-Request-Id', `github-${++requestId}`); const parsed = new URL(req.url ?? '/', 'http://localhost'); const path = parsed.pathname;
  if (req.method === 'POST' && path === '/register') { json(res, 200, { ok: true }); return; } if (req.method === 'GET' && path === '/done') { json(res, 200, { done: true }); return; } if (req.method === 'GET' && path === '/healthz') { json(res, 200, { ok: true }); return; }
  if (await handleGit(req, res, parsed)) return;
  if (path === '/mcp') {
    const token = process.env.MAKEFUN_SHOP_TOKEN;
    let reply;
    if (!token || req.headers.authorization !== `Bearer ${token}`) reply = mcpError(null, -32001, 'Requires authentication', 401);
    else if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply = mcpError(null, -32600, 'Method Not Allowed', 405); }
    else {
      const body = await bodyOf(req);
      reply = body.malformed || body.value === undefined ? mcpError(null, -32700, 'Parse error', 400)
        : executeMcp(body.value, { repoJson, issueJson, pullJson, createPull, mergePull }, req.headers);
    }
    if (reply.body === undefined) { res.statusCode = reply.status; res.end(); }
    else json(res, reply.status, reply.body);
    return;
  }
  if (path === '/api/graphql') {
    const token = process.env.MAKEFUN_SHOP_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) { error(res, 401, 'Requires authentication'); return; }
    if (req.method !== 'POST') { error(res, 405, 'Method Not Allowed'); return; }
    const body = await bodyOf(req);
    if (body.malformed) { error(res, 400, 'Malformed JSON'); return; }
    const execute = (operation: unknown): unknown => executeGraphQL(operation, { createPull, mergePull });
    json(res, 200, Array.isArray(body.value) ? body.value.map(execute) : execute(body.value));
    return;
  }
  if (!path.startsWith('/api/v3')) { error(res, 404, 'Not Found'); return; } if (!req.headers.authorization?.startsWith('Bearer ') || req.headers.authorization.slice(7).trim() === '') { error(res, 401, 'Requires authentication'); return; }
  const parsedBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await bodyOf(req) : { value: undefined, malformed: false }; if (parsedBody.malformed) { error(res, 400, 'Malformed JSON'); return; } const body: any = parsedBody.value ?? {};
  const parts = path.slice('/api/v3'.length).split('/').filter(Boolean).map((part) => decodeURIComponent(part)); const ownerFromPath = parts[1] ?? ''; const repoName = parts[2] ?? ''; const getRepo = (): Repository | null => ownerFromPath && repoName ? store.getRepository(ownerFromPath, repoName) : null; const repoOr404 = (): Repository | null => { const repo = getRepo(); if (!repo) error(res, 404, 'Not Found'); return repo; };
  try {
    if (req.method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) { json(res, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo' }); return; } if (req.method === 'GET' && path === '/api/v3/meta') { json(res, 200, { installed_version: 'github-core-clone-01' }); return; }
    if (req.method === 'GET' && parts[0] === 'user' && parts[1] === 'repos') { const all = store.listRepositories().filter((r) => r.owner !== null); const perPage = Math.max(1, Math.min(100, Number(parsed.searchParams.get('per_page') ?? 30) || 30)); const page = Math.max(1, Number(parsed.searchParams.get('page') ?? 1) || 1); const start = (page - 1) * perPage; const items = all.slice(start, start + perPage).map((r) => repoJson(r, r.owner ?? '')); const headers: Record<string, string> = {}; if (start + perPage < all.length) { const next = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); next.searchParams.set('page', String(page + 1)); next.searchParams.set('per_page', String(perPage)); headers.Link = `<${next.toString()}>; rel="next"`; } json(res, 200, items, headers); return; }
    if (req.method === 'POST' && parts[0] === 'user' && parts[1] === 'repos') { if (typeof body.name !== 'string' || body.name.trim() === '') { error(res, 422, 'Validation Failed'); return; } try { const repo = store.createRepository(body.name, { private: body.private, description: body.description ?? null, default_branch: body.default_branch }); json(res, 201, repoJson(repo)); } catch { error(res, 422, 'Repository already exists'); } return; }
    if (parts[0] !== 'repos' || parts.length < 3) { error(res, 404, 'Not Found'); return; } const repo = repoOr404(); if (!repo) return;
    if (parts.length === 3) { if (req.method === 'GET') { json(res, 200, repoJson(repo, ownerFromPath)); return; } if (req.method === 'PATCH') { if ('description' in body) repo.description = body.description; if (typeof body.default_branch === 'string') repo.default_branch = body.default_branch; repo.updated_at = now(); json(res, 200, repoJson(repo, ownerFromPath)); return; } if (req.method === 'DELETE') { store.deleteRepository(ownerFromPath, repo.name); json(res, 204, undefined); return; } }
    const sub = parts.slice(3);
    if (sub[0] === 'git' && sub[1] === 'refs' && req.method === 'POST') { const ref = typeof body.ref === 'string' ? body.ref : ''; const sha = typeof body.sha === 'string' ? body.sha : ''; if (!ref || !repo.objects.has(sha)) { error(res, 422, 'Validation Failed'); return; } repo.refs.set(refKey(ref), sha); json(res, 201, { ref, object: { sha, type: 'commit' } }); return; }
    if (sub[0] === 'branches' && req.method === 'GET') { json(res, 200, [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }))); return; }
    if (sub[0] === 'commits' && req.method === 'GET') { const history = commitHistory(repo, resolveCommit(repo, parsed.searchParams.get('sha'))); json(res, 200, history.map((sha) => { const c = repo.commits.get(sha)!; return { sha, commit: { message: c.message } }; })); return; }
    if (sub[0] === 'contents') { const contentPath = sub.slice(1).join('/'); const requestedRef = parsed.searchParams.get('ref') ?? (typeof body.branch === 'string' ? body.branch : null); const tip = resolveCommit(repo, requestedRef); const files = snapshot(repo, tip);
      if (req.method === 'GET') { const file = files.get(contentPath); if (file) { json(res, 200, { type: 'file', encoding: 'base64', content: file.data.toString('base64'), sha: file.sha, size: file.data.length, name: contentPath.split('/').pop(), path: contentPath }); return; } const prefix = contentPath ? `${contentPath}/` : ''; const entries = [...files].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => { const rest = key.slice(prefix.length); const name = rest.split('/')[0]!; return { type: rest.includes('/') ? 'dir' : 'file', name, path: prefix + name, sha: value.sha, size: value.data.length }; }).filter((x, i, a) => a.findIndex((y) => y.path === x.path) === i); if (entries.length > 0) { json(res, 200, entries); return; } error(res, 404, 'Not Found'); return; }
      if (req.method === 'PUT' || req.method === 'DELETE') { const old = files.get(contentPath); if (req.method === 'DELETE' && !old) { error(res, 404, 'Not Found'); return; } if (body.sha && (!old || body.sha !== old.sha)) { error(res, 409, 'SHA does not match'); return; } const next = new Map(files); let contentSha = old?.sha ?? ''; if (req.method === 'PUT') { if (typeof body.content !== 'string') { error(res, 422, 'Validation Failed'); return; } const data = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64'); const blob = store.writeObject(repo, 'blob', data); next.set(contentPath, { sha: blob.sha, data }); contentSha = blob.sha; } else next.delete(contentPath); const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch; const commit = makeCommit(repo, branch, next, typeof body.message === 'string' ? body.message : ''); if (req.method === 'PUT') { const entry = next.get(contentPath)!; json(res, old ? 200 : 201, { content: { name: contentPath.split('/').pop(), path: contentPath, sha: contentSha, size: entry.data.length, encoding: 'base64', content: entry.data.toString('base64'), type: 'file' }, commit: { sha: commit.sha, message: body.message ?? '' } }); } else json(res, 200, { content: null, commit: { sha: commit.sha } }); return; }
    }
    if (sub[0] === 'labels' && req.method === 'POST') { const label = store.createLabel(repo, body.name, body.color ?? 'ededed', body.description ?? null); if (!label) { error(res, 422, 'Validation Failed'); return; } json(res, 201, labelJson(label)); return; }
    if (sub[0] === 'issues') { const issueNumber = Number(sub[1]); if (sub.length === 1 && req.method === 'POST') { const labels = Array.isArray(body.labels) ? body.labels : []; const issue = store.createIssue(repo, body.title, body.body ?? '', labels); if (!issue) { error(res, 422, 'Validation Failed'); return; } json(res, 201, issueJson(issue)); return; } if (sub.length === 1 && req.method === 'GET') { const state = parsed.searchParams.get('state'); let list = store.listIssues(repo, state === 'all' ? undefined : state as any || undefined); if (parsed.searchParams.get('sort') === 'created' && parsed.searchParams.get('direction') === 'asc') list = list.reverse(); json(res, 200, list.map(issueJson)); return; } const issue = Number.isInteger(issueNumber) ? store.getIssue(repo, issueNumber) : null; if (!issue) { error(res, 404, 'Not Found'); return; } if (sub.length === 2 && req.method === 'GET') { json(res, 200, issueJson(issue)); return; } if (sub.length === 2 && req.method === 'PATCH') { if (body.state === 'closed') store.closeIssue(repo, issueNumber); if (body.state === 'open') { issue.state = 'open'; issue.updated_at = now(); } json(res, 200, issueJson(issue)); return; } if (sub[2] === 'comments') { if (req.method === 'POST') { if (typeof body.body !== 'string') { error(res, 422, 'Validation Failed'); return; } store.addComment(repo, issueNumber, body.body); json(res, 201, issue.comments[issue.comments.length - 1]); return; } if (req.method === 'GET') { json(res, 200, issue.comments); return; } } }
    if (sub[0] === 'pulls') { const number = Number(sub[1]); if (sub.length === 1 && req.method === 'POST') { const pull = createPull(repo, body.title, body.head, body.base ?? repo.default_branch, body.body ?? ''); if (!pull) { error(res, 422, 'Validation Failed'); return; } json(res, 201, pullJson(pull)); return; } if (sub.length === 1 && req.method === 'GET') { const state = parsed.searchParams.get('state') ?? 'open'; json(res, 200, [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state).sort((a, b) => a.number - b.number).map(pullJson)); return; } const pull = Number.isInteger(number) ? store.getPullRequest(repo, number) : null; if (!pull) { error(res, 404, 'Not Found'); return; } if (sub.length === 2 && req.method === 'GET') { json(res, 200, pullJson(pull)); return; } if (sub[2] === 'files' && req.method === 'GET') { json(res, 200, pull.files); return; } if (sub[2] === 'merge' && req.method === 'PUT') { try { const sha = mergePull(repo, pull); json(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' }); } catch (err) { if (!(err instanceof PullMergeError)) throw err; error(res, 405, err.message); } return; } }
    error(res, 404, 'Not Found');
  } catch (err) { error(res, 500, err instanceof Error ? err.message : 'Internal Server Error'); }
}
export function createApp(): Server { return createServer((req, res) => { void handle(req, res); }); }
