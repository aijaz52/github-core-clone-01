import { store, type Repository, type PullRequest } from './store.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };
const string = { type: 'string', minLength: 1 };
const repositoryProperties = { owner: string, repo: string };
const tool = (name: string, description: string, properties: Record<string, any>, required: string[]) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
// Fixed order and canonical property names match the documented github-mcp-server arguments.
const TOOLS = [
  tool('create_repo', 'Create a repository for the authenticated user.', {
    name: string, description: { type: 'string' }, private: { type: 'boolean' },
  }, ['name']),
  tool('get_repo', 'Read a repository by owner and name.', repositoryProperties, ['owner', 'repo']),
  tool('create_issue', 'Create an open issue in a repository.', {
    ...repositoryProperties, title: string, body: { type: 'string' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List repository issues, optionally filtered by state.', {
    ...repositoryProperties, state: { type: 'string', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request between existing branches.', {
    ...repositoryProperties, title: string, head: string, base: string, body: { type: 'string' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash merge an open pull request into the default branch.', {
    ...repositoryProperties, pull_number: { type: 'integer', minimum: 1 },
  }, ['owner', 'repo', 'pull_number']),
];

export interface McpActions {
  repoJson(repo: Repository): unknown;
  issueJson(issue: any): unknown;
  pullJson(pull: PullRequest): unknown;
  createPull(repo: Repository, title: string, head: string, base: string, body: string): PullRequest | null;
  mergePull(repo: Repository, pull: PullRequest): string;
}
type Reply = { status: number; body?: unknown };
const record = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function mcpError(id: string | number | null, code: number, message: string, status = 200, data?: unknown): Reply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } } };
}

function invalidArguments(schema: any, args: Record<string, any>): boolean {
  if (schema.required.some((key: string) => !Object.hasOwn(args, key))) return true;
  return Object.entries(args).some(([key, value]) => {
    if (!Object.hasOwn(schema.properties, key)) return true;
    const property = schema.properties[key];
    if (property.type === 'integer') return !Number.isSafeInteger(value) || value < property.minimum;
    if (typeof value !== property.type) return true;
    if (property.minLength && !value.trim()) return true;
    return property.enum !== undefined && !property.enum.includes(value);
  });
}

function callTool(name: string, args: Record<string, any>, actions: McpActions): unknown {
  if (name === 'create_repo') {
    const repo = store.createRepository(args.name, { description: args.description, private: args.private });
    // The kit's viewer is also the author used by REST and GraphQL. Bind ownership now,
    // so the returned full_name is immediately usable and a different owner cannot claim it.
    store.getRepository('adaiversen', repo.name);
    return actions.repoJson(repo);
  }
  const repo = store.getRepository(args.owner, args.repo);
  if (!repo) throw new Error('Repository not found');
  if (name === 'get_repo') return actions.repoJson(repo);
  if (name === 'create_issue') {
    const issue = store.createIssue(repo, args.title, args.body ?? '');
    if (!issue) throw new Error('Validation Failed: title is required');
    return actions.issueJson(issue);
  }
  if (name === 'list_issues') return { issues: store.listIssues(repo, args.state === 'all' ? undefined : args.state ?? 'open').map(actions.issueJson) };
  if (name === 'create_pull_request') {
    const pull = actions.createPull(repo, args.title, args.head, args.base, args.body ?? '');
    if (!pull) throw new Error('Validation Failed: title, head and base branches are required');
    return actions.pullJson(pull);
  }
  const pull = store.getPullRequest(repo, args.pull_number);
  if (!pull) throw new Error('Pull request not found');
  return { sha: actions.mergePull(repo, pull), merged: true, message: 'Pull Request successfully merged' };
}

/** Stateless transport: every request owns its id, revision and result, including concurrent calls. */
export function executeMcp(request: unknown, actions: McpActions, headers: Record<string, string | string[] | undefined> = {}): Reply {
  if (!record(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      Object.hasOwn(request, 'id') && request.id !== null && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id))) {
    return mcpError(null, -32600, 'Invalid Request', 400);
  }
  const id = request.id ?? null;
  // JSON-RPC notifications never get a response envelope, and never invoke a tool mutation.
  if (!Object.hasOwn(request, 'id')) return { status: 202 };
  const success = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const params = request.params ?? {};
  if (!record(params)) return mcpError(id, -32602, 'Invalid params');
  const metaVersion = record(params._meta) ? params._meta['io.modelcontextprotocol/protocolVersion'] ?? params._meta.protocolVersion : undefined;
  const headerVersion = headers['mcp-protocol-version'];
  if (headers['mcp-method'] !== undefined && headers['mcp-method'] !== request.method ||
      request.method === 'tools/call' && headers['mcp-name'] !== undefined && headers['mcp-name'] !== params.name ||
      metaVersion !== undefined && headerVersion !== undefined && metaVersion !== headerVersion) {
    return mcpError(id, -32020, 'MCP header mismatch', 400);
  }
  const revision = headerVersion ?? metaVersion;
  if (request.method !== 'initialize' && revision !== undefined && !REVISIONS.includes(revision as string)) {
    return mcpError(id, -32022, 'Unsupported protocol version', 400, { supported: REVISIONS });
  }
  if (request.method === 'server/discover') return success({
    supportedVersions: REVISIONS, capabilities: CAPABILITIES, serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  });
  if (request.method === 'initialize') {
    if (typeof params.protocolVersion !== 'string' || !record(params.capabilities) || !record(params.clientInfo)) return mcpError(id, -32602, 'Invalid initialize params');
    return success({ protocolVersion: REVISIONS.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
  }
  if (request.method === 'ping') return success({});
  if (request.method === 'tools/list') return success({ tools: TOOLS });
  if (request.method !== 'tools/call') return mcpError(id, -32601, 'Method not found');
  const definition = TOOLS.find(tool => tool.name === params.name);
  if (!definition) return mcpError(id, -32602, 'Unknown tool');
  const args = params.arguments ?? {};
  if (!record(args) || invalidArguments(definition.inputSchema, args)) return mcpError(id, -32602, 'Invalid tool arguments');
  try {
    const value = callTool(definition.name, args, actions);
    return success({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
  } catch (error) {
    return success({ content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool execution failed' }], isError: true });
  }
}
