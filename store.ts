import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { sha: string; type: GitObjectType; data: Buffer; }
export interface CommitInfo { sha: string; tree: string; parents: string[]; message: string; author: string; timestamp: string; }
export interface Label { id: number; name: string; color: string; description: string | null; }
export interface IssueComment { id: number; body: string; user: { login: string }; created_at: string; }
export interface Issue {
  id: number; number: number; node_id: string; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; comments: IssueComment[];
  user: { login: string }; created_at: string; updated_at: string;
}
export interface PullRequest {
  id: number; number: number; node_id: string; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null; head: { ref: string; label: string; sha: string };
  base: { ref: string; label: string; sha: string }; user: { login: string };
  mergeable: boolean; files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  created_at: string; updated_at: string;
}
export interface RepositoryOptions { private?: boolean; description?: string | null; default_branch?: string; }
export interface Repository {
  id: number; owner: string | null; name: string; full_name: string;
  private: boolean; description: string | null; default_branch: string;
  created_at: string; updated_at: string; refs: Map<string, string>;
  objects: Map<string, GitObject>; labels: Map<number, Label>;
  issues: Map<number, Issue>; pulls: Map<number, PullRequest>;
  counters: { nextLabelNumber: number; nextIssueNumber: number; nextCommentNumber: number; nextPullNumber: number };
  files: Map<string, { sha: string; data: Buffer }>;
  commits: Map<string, CommitInfo>;
  commitFiles: Map<string, Map<string, { sha: string; data: Buffer }>>;
}

const DEFAULT_NOW = '2020-01-01T00:00:00.000Z';
function trialTimestamp(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (!raw) return DEFAULT_NOW;
  const milliseconds = /^-?\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(milliseconds)) return DEFAULT_NOW;
  try { return new Date(milliseconds).toISOString(); } catch { return DEFAULT_NOW; }
}
const nodeId = (kind: string, id: number): string => Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');

export class ForgeStore {
  readonly repositories = new Map<number, Repository>();
  private nextRepositoryId = 1;
  private nextEntityId = 1;
  private readonly timestamp: string;

  constructor() { this.timestamp = trialTimestamp(); }
  getTimestamp(): string { return this.timestamp; }

  createRepository(name: string, options: RepositoryOptions = {}): Repository {
    if (!name || !name.trim()) throw new Error('name is required');
    if (Array.from(this.repositories.values()).some(r => r.name === name)) throw new Error('repository already exists');
    const now = this.getTimestamp();
    const repo: Repository = {
      id: this.nextRepositoryId++, owner: null, name, full_name: name,
      private: options.private ?? false, description: options.description ?? null,
      default_branch: options.default_branch ?? 'main', created_at: now, updated_at: now,
      refs: new Map(), objects: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(),
      counters: { nextLabelNumber: 1, nextIssueNumber: 1, nextCommentNumber: 1, nextPullNumber: 1 },
      files: new Map(), commits: new Map(), commitFiles: new Map(),
    };
    this.repositories.set(repo.id, repo);
    return repo;
  }

  getRepository(owner: string, name: string): Repository | null {
    const exact = Array.from(this.repositories.values()).find(r => r.owner === owner && r.name === name);
    if (exact) return exact;
    if (!owner) return null;
    const pending = Array.from(this.repositories.values()).find(r => r.owner === null && r.name === name);
    if (!pending) return null;
    pending.owner = owner;
    pending.full_name = `${owner}/${name}`;
    pending.updated_at = this.getTimestamp();
    return pending;
  }

  listRepositories(owner?: string): Repository[] {
    return Array.from(this.repositories.values())
      .filter(r => owner === undefined ? r.owner !== null : r.owner === owner)
      .sort((a, b) => a.id - b.id);
  }

  getRepositoryById(id: number): Repository | null { return this.repositories.get(id) ?? null; }

  deleteRepository(owner: string, name: string): boolean {
    const repo = Array.from(this.repositories.values()).find(r => r.owner === owner && r.name === name);
    return repo ? this.repositories.delete(repo.id) : false;
  }

  hashObject(type: GitObjectType, data: Uint8Array | string): GitObject {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const header = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
    const sha = createHash('sha1').update(header).update(bytes).digest('hex');
    return { sha, type, data: bytes };
  }

  writeObject(repo: Repository, type: GitObjectType, data: Uint8Array | string): GitObject {
    const object = this.hashObject(type, data);
    repo.objects.set(object.sha, object);
    return object;
  }

  getObject(repo: Repository, sha: string): GitObject | null { return repo.objects.get(sha) ?? null; }

  setRef(repo: Repository, ref: string, sha: string): boolean {
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    repo.updated_at = this.getTimestamp();
    return true;
  }

  deleteRef(repo: Repository, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.updated_at = this.getTimestamp();
    return deleted;
  }

  createLabel(repo: Repository, name: string, color = 'ededed', description: string | null = null): Label | null {
    if (!name || !name.trim() || Array.from(repo.labels.values()).some(x => x.name.toLowerCase() === name.toLowerCase())) return null;
    const label: Label = { id: this.nextEntityId++, name, color: color.replace(/^#/, '').toLowerCase(), description };
    repo.counters.nextLabelNumber++;
    repo.labels.set(label.id, label);
    return label;
  }

  getLabelByName(repo: Repository, name: string): Label | null {
    return Array.from(repo.labels.values()).find(x => x.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  createIssue(repo: Repository, title: string, body = '', labelNames: string[] = [], login = 'adaiversen'): Issue | null {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = this.getLabelByName(repo, name);
      if (!label) return null;
      labels.push(label);
    }
    if (!title || !title.trim()) return null;
    const now = this.getTimestamp();
    const id = this.nextEntityId++;
    const issue: Issue = {
      id, number: repo.counters.nextIssueNumber++, node_id: nodeId('Issue', id),
      title, body, state: 'open', labels, comments: [], user: { login }, created_at: now, updated_at: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repository, number: number): Issue | null { return repo.issues.get(number) ?? null; }
  listIssues(repo: Repository, state?: 'open' | 'closed'): Issue[] {
    return Array.from(repo.issues.values()).filter(i => state === undefined || i.state === state).sort((a, b) => b.number - a.number);
  }

  addComment(repo: Repository, number: number, body: string, login = 'adaiversen'): Issue | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    issue.comments.push({ id: this.nextEntityId++, body, user: { login }, created_at: this.getTimestamp() });
    issue.updated_at = this.getTimestamp();
    repo.counters.nextCommentNumber++;
    return issue;
  }

  closeIssue(repo: Repository, number: number): Issue | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    issue.state = 'closed';
    issue.updated_at = this.getTimestamp();
    return issue;
  }

  createPullRequest(repo: Repository, title: string, headRef: string, baseRef: string, body = '', login = 'adaiversen'): PullRequest | null {
    const headKey = headRef.startsWith('refs/') ? headRef : `refs/heads/${headRef}`;
    const baseKey = baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`;
    const headSha = repo.refs.get(headKey);
    const baseSha = repo.refs.get(baseKey);
    if (!headSha || !baseSha || !title || !title.trim()) return null;
    const now = this.getTimestamp();
    const id = this.nextEntityId++;
    const owner = repo.owner ?? repo.full_name;
    const pull: PullRequest = {
      id, number: repo.counters.nextPullNumber++, node_id: nodeId('PullRequest', id),
      title, body, state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
      head: { ref: headRef.replace(/^refs\/heads\//, ''), label: `${owner}:${headRef}`, sha: headSha },
      base: { ref: baseRef.replace(/^refs\/heads\//, ''), label: `${owner}:${baseRef}`, sha: baseSha },
      user: { login }, mergeable: true, files: [], created_at: now, updated_at: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPullRequest(repo: Repository, number: number): PullRequest | null { return repo.pulls.get(number) ?? null; }

  closePullRequest(repo: Repository, number: number): PullRequest | null {
    const pull = this.getPullRequest(repo, number);
    if (!pull) return null;
    pull.state = 'closed';
    pull.updated_at = this.getTimestamp();
    return pull;
  }

  mergePullRequest(repo: Repository, number: number, mergeSha: string): PullRequest | null {
    const pull = this.getPullRequest(repo, number);
    const object = repo.objects.get(mergeSha);
    if (!pull || !object || object.type !== 'commit') return null;
    repo.refs.set(`refs/heads/${repo.default_branch}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = this.getTimestamp();
    pull.merge_commit_sha = mergeSha;
    pull.updated_at = this.getTimestamp();
    return pull;
  }
}

export const ZERO_OID = '0'.repeat(40);
export const isOid = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_PACK_BYTES = 128 * 1024 * 1024;
const objectTypes: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function readGitCommit(data: Buffer): { tree: string; parents: string[]; author: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) throw new Error('Invalid commit headers');
  const headers = text.slice(0, blank).split('\n');
  const trees = headers.filter(line => line.startsWith('tree '));
  const tree = trees[0]?.slice(5) ?? '';
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (trees.length !== 1 || !isOid(tree) || parents.some(parent => !isOid(parent))) throw new Error('Invalid commit object id');
  return { tree, parents, author: headers.find(line => line.startsWith('author '))?.slice(7) ?? '', message: text.slice(blank + 2) };
}

export function readGitTree(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const nul = space < 0 ? -1 : data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('Truncated tree entry');
    const mode = data.subarray(offset, space).toString('latin1');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (!['40000', '040000', '100644', '100755', '120000', '160000'].includes(mode) || !name || name.includes('/') || name === '.' || name === '..' || names.has(name)) throw new Error('Invalid tree entry');
    names.add(name);
    entries.push({ mode, name, sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

export function readGitTag(data: Buffer): { sha: string; type: GitObjectType } {
  const headers = data.toString('utf8').split('\n\n', 1)[0]!.split('\n');
  const sha = headers.find(line => line.startsWith('object '))?.slice(7) ?? '';
  const type = headers.find(line => line.startsWith('type '))?.slice(5) as GitObjectType;
  if (!isOid(sha) || !['commit', 'tree', 'blob', 'tag'].includes(type)) throw new Error('Invalid tag object');
  return { sha, type };
}

/** Typed edges also validate connectivity before a quarantined push becomes visible. */
export function gitObjectLinks(object: GitObject): Array<{ sha: string; type: GitObjectType }> {
  if (object.type === 'commit') {
    const commit = readGitCommit(object.data);
    return [{ sha: commit.tree, type: 'tree' }, ...commit.parents.map(sha => ({ sha, type: 'commit' as const }))];
  }
  if (object.type === 'tag') return [readGitTag(object.data)];
  if (object.type === 'tree') return readGitTree(object.data).filter(entry => entry.mode !== '160000').map(entry => ({ sha: entry.sha, type: entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob' }));
  return [];
}

/** Walk iteratively: a client's shallow commits stop parent edges, but retain trees/blobs. */
export function gitReachable(roots: Iterable<string>, lookup: (sha: string) => GitObject | undefined, shallow = new Set<string>()): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    const object = lookup(sha);
    if (!object) throw new Error(`Missing object ${sha}`);
    seen.add(sha);
    if (object.type === 'commit' && shallow.has(sha)) queue.push(readGitCommit(object.data).tree);
    else for (const link of gitObjectLinks(object)) queue.push(link.sha);
  }
  return seen;
}

/** Resolve delta instructions with explicit bounds; an invalid pack never mutates a repo. */
function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const byte = (): number => { if (pos >= delta.length) throw new Error('Truncated delta'); return delta[pos++]!; };
  const size = (): number => {
    let value = 0; let factor = 1; let next: number;
    do { next = byte(); value += (next & 127) * factor; factor *= 128; if (!Number.isSafeInteger(value) || factor > 2 ** 49) throw new Error('Delta size overflow'); } while (next & 128);
    return value;
  };
  if (size() !== base.length) throw new Error('Delta base size mismatch');
  const outputSize = size();
  if (outputSize > MAX_OBJECT_BYTES) throw new Error('Delta object too large');
  const output = Buffer.alloc(outputSize);
  let written = 0;
  while (pos < delta.length) {
    const op = byte();
    if (op & 128) {
      let start = 0; let count = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) start += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) count += byte() * 2 ** (8 * i);
      if (!count) count = 65536;
      if (start + count > base.length || written + count > outputSize) throw new Error('Delta copy out of bounds');
      base.copy(output, written, start, start + count); written += count;
    } else {
      if (!op || pos + op > delta.length || written + op > outputSize) throw new Error('Invalid delta literal');
      delta.copy(output, written, pos, pos + op); pos += op; written += op;
    }
  }
  if (written !== outputSize) throw new Error('Delta result size mismatch');
  return output;
}

export function readGitPack(pack: Buffer, lookup: (sha: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.length > MAX_PACK_BYTES || !pack.subarray(0, 4).equals(Buffer.from('PACK')) || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
  const end = pack.length - 20;
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) throw new Error('Pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  if (count > 100000 || count > end - 12) throw new Error('Invalid pack object count');
  type Entry = { offset: number; code: number; data: Buffer; baseOffset?: number; baseSha?: string; object?: GitObject };
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  const objects = new Map<string, GitObject>();
  let pos = 12; let inflatedBytes = 0;
  const byte = (): number => { if (pos >= end) throw new Error('Truncated pack'); return pack[pos++]!; };
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let next = byte(); const code = (next >> 4) & 7;
    let size = next & 15; let factor = 16;
    while (next & 128) { next = byte(); size += (next & 127) * factor; factor *= 128; if (!Number.isSafeInteger(size) || size > MAX_OBJECT_BYTES || factor > 2 ** 49) throw new Error('Pack object too large'); }
    if (!objectTypes[code] && code !== 6 && code !== 7) throw new Error('Invalid pack object type');
    const entry: Entry = { offset, code, data: Buffer.alloc(0) };
    if (code === 6) {
      next = byte(); let distance = next & 127;
      while (next & 128) { next = byte(); distance = (distance + 1) * 128 + (next & 127); if (!Number.isSafeInteger(distance) || distance > offset) throw new Error('Invalid delta offset'); }
      entry.baseOffset = offset - distance;
      if (!byOffset.has(entry.baseOffset)) throw new Error('Missing offset delta base');
    } else if (code === 7) {
      if (pos + 20 > end) throw new Error('Truncated ref delta base');
      entry.baseSha = pack.subarray(pos, pos + 20).toString('hex'); pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos, end), { info: true, maxOutputLength: MAX_OBJECT_BYTES });
    entry.data = inflated.buffer;
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || pos + consumed > end || entry.data.length !== size) throw new Error('Pack object size mismatch');
    pos += consumed; inflatedBytes += size;
    if (inflatedBytes > MAX_PACK_BYTES) throw new Error('Inflated pack too large');
    if (objectTypes[code]) { entry.object = store.hashObject(objectTypes[code]!, entry.data); objects.set(entry.object.sha, entry.object); }
    entries.push(entry); byOffset.set(offset, entry);
  }
  if (pos !== end) throw new Error('Trailing pack bytes');
  let pending = entries.filter(entry => !entry.object);
  // REF_DELTA may reference a later object; resolve in passes rather than recurse into cycles.
  while (pending.length) {
    const next: Entry[] = [];
    for (const entry of pending) {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset)?.object : objects.get(entry.baseSha!) ?? lookup(entry.baseSha!);
      if (!base) { next.push(entry); continue; }
      const data = applyGitDelta(base.data, entry.data);
      inflatedBytes += data.length;
      if (inflatedBytes > MAX_PACK_BYTES) throw new Error('Resolved pack too large');
      entry.object = store.hashObject(base.type, data); objects.set(entry.object.sha, entry.object);
    }
    if (next.length === pending.length) throw new Error('Unresolvable delta base');
    pending = next;
  }
  return objects;
}

export function writeGitPack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects]; const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const parts = [header];
  const codes = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const object of list) {
    let size = object.data.length;
    let value = (codes[object.type] << 4) | (size & 15); size = Math.floor(size / 16);
    const bytes: number[] = [];
    while (size) { bytes.push(value | 128); value = size & 127; size = Math.floor(size / 128); }
    bytes.push(value);
    parts.push(Buffer.from(bytes), deflateSync(object.data));
  }
  const data = Buffer.concat(parts);
  return Buffer.concat([data, createHash('sha1').update(data).digest()]);
}

/** Prepare REST's derived views in quarantine too, so an indexing error cannot half-apply a push. */
export function prepareGitObjects(repo: Repository, incoming: Map<string, GitObject>): { commits: Map<string, CommitInfo>; snapshots: Repository['commitFiles'] } {
  const lookup = (sha: string): GitObject | undefined => incoming.get(sha) ?? repo.objects.get(sha);
  const commits = new Map<string, CommitInfo>();
  const snapshots: Repository['commitFiles'] = new Map();
  for (const object of incoming.values()) {
    for (const link of gitObjectLinks(object)) if (lookup(link.sha)?.type !== link.type) throw new Error(`Missing or invalid ${link.type} ${link.sha}`);
    if (object.type !== 'commit' || repo.commits.has(object.sha)) continue;
    const parsed = readGitCommit(object.data);
    const files: Repository['files'] = new Map();
    const queue = [{ sha: parsed.tree, prefix: '', ancestors: new Set<string>() }];
    let treeCount = 0;
    while (queue.length) {
      const node = queue.pop()!;
      if (++treeCount > 100000) throw new Error('Too many tree paths');
      if (node.ancestors.has(node.sha) || node.ancestors.size > 128) throw new Error('Invalid tree depth');
      const tree = lookup(node.sha);
      if (tree?.type !== 'tree') throw new Error('Missing tree');
      const ancestors = new Set(node.ancestors).add(node.sha);
      for (const entry of readGitTree(tree.data)) {
        if (entry.mode === '160000') continue;
        const path = node.prefix + entry.name;
        if (entry.mode === '40000' || entry.mode === '040000') queue.push({ sha: entry.sha, prefix: path + '/', ancestors });
        else { const blob = lookup(entry.sha); if (blob?.type !== 'blob') throw new Error('Missing blob'); files.set(path, { sha: entry.sha, data: blob.data }); }
        if (files.size + queue.length > 100000) throw new Error('Tree too large');
      }
    }
    commits.set(object.sha, { sha: object.sha, ...parsed, timestamp: store.getTimestamp() });
    snapshots.set(object.sha, files);
  }
  return { commits, snapshots };
}

export const store = new ForgeStore();
