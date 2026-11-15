import { Buffer } from 'node:buffer';
import { store, type Repository, type PullRequest } from './store.ts';

// wire.ts's fixed scenario identifies the token's viewer as adaiversen, also the
// default author used by the existing REST store. The token itself is opaque.
const VIEWER_LOGIN = 'adaiversen';
type Value = any;
type Token = { text: string; offset: number; string?: boolean };
type Selection = { name: string; alias: string; args: Record<string, Value>; fields: Selection[]; offset: number; on?: string; spread?: string };
type Variable = { name: string; type: string; fallback?: Value };
type Operation = { kind: string; name?: string; variables: Variable[]; fields: Selection[] };

class GraphError extends Error {
  offset?: number;
  constructor(message: string, offset?: number) { super(message); this.offset = offset; }
}

/** A bounded recursive-descent parser; documents are never evaluated as code. */
class Parser {
  tokens: Token[] = [];
  index = 0;
  fragments = new Map<string, Selection>();
  constructor(source: string) {
    if (source.length > 1_000_000) throw new GraphError('Document is too large');
    const pattern = /\s+|#[^\r\n]*|,|\uFEFF|\.\.\.|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{}|]/gy;
    let offset = 0;
    while (offset < source.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(source);
      if (!match) throw new GraphError('Syntax Error: Unexpected character', offset);
      const text = match[0]; offset = pattern.lastIndex;
      if (/^(?:\s|#|,|\uFEFF)/u.test(text)) continue;
      this.tokens.push({ text: text.startsWith('"') ? JSON.parse(text) : text, offset: match.index, string: text.startsWith('"') });
      if (this.tokens.length > 50_000) throw new GraphError('Document has too many tokens');
    }
    this.tokens.push({ text: '<EOF>', offset: source.length });
  }
  peek(): string { return this.tokens[this.index]!.text; }
  take(text?: string): Token {
    const token = this.tokens[this.index]!;
    if (text !== undefined && (token.string || token.text !== text) || token.text === '<EOF>' && !token.string) throw new GraphError(`Syntax Error: Expected ${text ?? 'a token'}, found ${token.text}`, token.offset);
    this.index++; return token;
  }
  eat(text: string): boolean { if (!this.tokens[this.index]!.string && this.peek() === text) { this.index++; return true; } return false; }
  name(): string { const token = this.take(); if (token.string || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(token.text)) throw new GraphError('Syntax Error: Expected a name', token.offset); return token.text; }
  type(): string {
    let type: string;
    if (this.eat('[')) { type = `[${this.type()}]`; this.take(']'); }
    else type = this.name();
    return type + (this.eat('!') ? '!' : '');
  }
  value(depth = 0): Value {
    if (depth > 64) throw new GraphError('Input is too deeply nested');
    if (this.eat('$')) return { variable: this.name() };
    if (this.eat('[')) { const list = []; while (!this.eat(']')) list.push(this.value(depth + 1)); return list; }
    if (this.eat('{')) { const object: Record<string, Value> = Object.create(null); while (!this.eat('}')) { const key = this.name(); this.take(':'); object[key] = this.value(depth + 1); } return object; }
    const token = this.take();
    if (token.string) return token.text;
    if (token.text === 'null') return null;
    if (token.text === 'true' || token.text === 'false') return token.text === 'true';
    if (/^-?\d/.test(token.text)) return Number(token.text);
    if (/^[_A-Za-z][_0-9A-Za-z]*$/.test(token.text)) return token.text;
    throw new GraphError('Syntax Error: Expected a value', token.offset);
  }
  selections(depth = 0): Selection[] {
    if (depth > 64) throw new GraphError('Selection is too deeply nested');
    this.take('{'); const fields: Selection[] = [];
    while (!this.eat('}')) {
      const offset = this.tokens[this.index]!.offset;
      if (this.eat('...')) {
        if (this.eat('on')) { const on = this.name(); fields.push({ name: '', alias: '', args: {}, fields: this.selections(depth + 1), offset, on }); }
        else fields.push({ name: '', alias: '', args: {}, fields: [], offset, spread: this.name() });
        continue;
      }
      const first = this.name(); const name = this.eat(':') ? this.name() : first;
      const args: Record<string, Value> = Object.create(null);
      if (this.eat('(')) while (!this.eat(')')) { const key = this.name(); this.take(':'); args[key] = this.value(); }
      fields.push({ name, alias: first, args, fields: this.peek() === '{' ? this.selections(depth + 1) : [], offset });
    }
    if (!fields.length) throw new GraphError('Syntax Error: Empty selection set');
    return fields;
  }
  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== '<EOF>') {
      if (this.eat('fragment')) { const name = this.name(); this.take('on'); const on = this.name(); if (this.fragments.has(name)) throw new GraphError(`Duplicate fragment ${name}`); this.fragments.set(name, { name: '', alias: '', args: {}, fields: this.selections(), offset: 0, on }); continue; }
      let kind = 'query'; let name: string | undefined; const variables: Variable[] = [];
      if (this.peek() !== '{') {
        kind = this.name(); if (!['query', 'mutation'].includes(kind)) throw new GraphError(`Unsupported operation ${kind}`);
        if (this.peek() !== '(' && this.peek() !== '{') name = this.name();
        if (this.eat('(')) while (!this.eat(')')) { this.take('$'); const name = this.name(); this.take(':'); const type = this.type(); const fallback = this.eat('=') ? this.value() : undefined; variables.push({ name, type, fallback }); }
      }
      operations.push({ kind, name, variables, fields: this.selections() });
    }
    if (!operations.length) throw new GraphError('Syntax Error: Expected an operation');
    return operations;
  }
}

type Field = { type: string; args?: Record<string, string> };
const f = (type: string, args?: Record<string, string>): Field => ({ type, args });
const pageArgs = { first: 'Int', after: 'String' };
const schema: Record<string, Record<string, Field>> = {
  Query: { viewer: f('User'), repository: f('Repository', { owner: 'String!', name: 'String!' }), node: f('Node', { id: 'ID!' }), __type: f('__Type', { name: 'String!' }) },
  Mutation: { createIssue: f('CreateIssuePayload', { input: 'CreateIssueInput!' }), closeIssue: f('CloseIssuePayload', { input: 'CloseIssueInput!' }), createPullRequest: f('CreatePullRequestPayload', { input: 'CreatePullRequestInput!' }), mergePullRequest: f('MergePullRequestPayload', { input: 'MergePullRequestInput!' }), addComment: f('AddCommentPayload', { input: 'AddCommentInput!' }) },
  Repository: { id: f('ID'), databaseId: f('Int'), name: f('String'), nameWithOwner: f('String'), owner: f('User'), defaultBranchRef: f('Ref'), viewerPermission: f('RepositoryPermission'), hasIssuesEnabled: f('Boolean'), issue: f('Issue', { number: 'Int!' }), issues: f('IssueConnection', { ...pageArgs, states: '[IssueState!]', orderBy: 'IssueOrder' }), pullRequests: f('PullRequestConnection', { ...pageArgs, states: '[PullRequestState!]' }), pullRequest: f('PullRequest', { number: 'Int!' }) },
  Node: { id: f('ID') }, User: { login: f('String') }, Ref: { name: f('String') },
  Issue: { id: f('ID'), number: f('Int'), title: f('String'), state: f('IssueState'), body: f('String') },
  PullRequest: { id: f('ID'), number: f('Int'), title: f('String'), body: f('String'), state: f('PullRequestState'), merged: f('Boolean'), headRefName: f('String'), baseRefName: f('String'), mergeable: f('MergeableState'), files: f('PullRequestChangedFileConnection', pageArgs) },
  IssueConnection: { nodes: f('Issue'), edges: f('IssueEdge'), pageInfo: f('PageInfo'), totalCount: f('Int') },
  PullRequestConnection: { nodes: f('PullRequest'), edges: f('PullRequestEdge'), pageInfo: f('PageInfo'), totalCount: f('Int') },
  PullRequestChangedFileConnection: { nodes: f('PullRequestChangedFile'), pageInfo: f('PageInfo'), totalCount: f('Int') },
  IssueEdge: { node: f('Issue'), cursor: f('String') }, PullRequestEdge: { node: f('PullRequest'), cursor: f('String') },
  PageInfo: { hasNextPage: f('Boolean'), hasPreviousPage: f('Boolean'), endCursor: f('String'), startCursor: f('String') },
  PullRequestChangedFile: { path: f('String') },
  CreateIssuePayload: { issue: f('Issue'), clientMutationId: f('String') }, CloseIssuePayload: { issue: f('Issue'), clientMutationId: f('String') },
  CreatePullRequestPayload: { pullRequest: f('PullRequest'), clientMutationId: f('String') }, MergePullRequestPayload: { pullRequest: f('PullRequest'), clientMutationId: f('String') },
  AddCommentPayload: { commentEdge: f('IssueCommentEdge'), clientMutationId: f('String') }, IssueCommentEdge: { node: f('IssueComment') }, IssueComment: { id: f('ID'), body: f('String') },
  __Type: { name: f('String'), kind: f('String'), fields: f('__Field', { includeDeprecated: 'Boolean' }), enumValues: f('__EnumValue', { includeDeprecated: 'Boolean' }) },
  __Field: { name: f('String') }, __EnumValue: { name: f('String') },
};
const enums: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'],
};
const inputs: Record<string, Record<string, string>> = {
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  CloseIssueInput: { issueId: 'ID!', clientMutationId: 'String' },
  CreatePullRequestInput: { repositoryId: 'ID!', title: 'String!', body: 'String', headRefName: 'String!', baseRefName: 'String!', draft: 'Boolean', clientMutationId: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
};
const own = (object: object, key: string): boolean => Object.hasOwn(object, key);
function coerce(value: Value, type: string, label: string): Value {
  if (type.endsWith('!')) { if (value === null || value === undefined) throw new GraphError(`${label} of required type ${type} was not provided`); return coerce(value, type.slice(0, -1), label); }
  if (value === null || value === undefined) return value;
  if (type.startsWith('[')) return (Array.isArray(value) ? value : [value]).map(item => coerce(item, type.slice(1, -1), label));
  if (own(inputs, type)) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new GraphError(`${label} must be an input object`);
    const fields = inputs[type]!; const result: Record<string, Value> = Object.create(null);
    for (const key of Object.keys(value)) if (!own(fields, key)) throw new GraphError(`Field ${key} is not defined by type ${type}`);
    for (const [key, fieldType] of Object.entries(fields)) { const item = coerce(value[key], fieldType, `${label}.${key}`); if (item !== undefined) result[key] = item; }
    return result;
  }
  const valid = own(enums, type) ? enums[type]!.includes(value) : type === 'Int' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 : type === 'Boolean' ? typeof value === 'boolean' : type === 'ID' ? typeof value === 'string' || Number.isInteger(value) : type === 'String' && typeof value === 'string';
  if (!valid) throw new GraphError(`${label} has an invalid value for type ${type}`);
  return type === 'ID' ? String(value) : value;
}
function valueOf(value: Value, variables: Record<string, Value>): Value {
  if (Array.isArray(value)) return value.map(item => valueOf(item, variables));
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== null && own(value, 'variable')) { if (!own(variables, value.variable)) throw new GraphError(`Variable $${value.variable} is not defined`); return variables[value.variable]; }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueOf(item, variables)]));
  }
  return value;
}

type ObjectValue = { type: string; value: any; repo?: Repository };
const object = (type: string, value: any, repo?: Repository): ObjectValue | null => value == null ? null : { type, value, repo };
const idOf = (type: string, id: number): string => Buffer.from(`${type}:${id}`).toString('base64');
function findNode(id: string): ObjectValue | null {
  if (typeof id !== 'string') return null;
  const match = /^(Repository|Issue|PullRequest):([1-9][0-9]*)$/.exec(Buffer.from(id, 'base64').toString());
  if (!match || idOf(match[1]!, Number(match[2])) !== id) return null;
  const [_, kind, databaseId] = match; const number = Number(databaseId);
  if (kind === 'Repository') return object(kind, store.getRepositoryById(number));
  for (const repo of store.repositories.values()) {
    const entity = kind === 'Issue' ? [...repo.issues.values()].find(issue => issue.id === number) : [...repo.pulls.values()].find(pull => pull.id === number);
    if (entity) return object(kind!, entity, repo);
  }
  return null;
}

export interface GraphQLActions {
  createPull(repo: Repository, title: string, head: string, base: string, body: string): PullRequest | null;
  mergePull(repo: Repository, pull: PullRequest): string;
}

function connection(items: ObjectValue[], args: Record<string, Value>, scope: string, edgeType?: string): any {
  const cursor = (item: ObjectValue): string => Buffer.from(`cursor:${scope}:${item.value.id ?? item.value.path}`).toString('base64');
  let start = 0;
  if (args.after != null) { const index = items.findIndex(item => cursor(item) === args.after); if (index < 0) throw new GraphError('Invalid cursor'); start = index + 1; }
  const first = args.first ?? 100;
  if (!Number.isInteger(first) || first < 0 || first > 100) throw new GraphError('first must be between 0 and 100');
  const nodes = items.slice(start, start + first);
  return { nodes, edges: edgeType ? nodes.map(node => object(edgeType, { node, cursor: cursor(node) })) : [], totalCount: items.length,
    pageInfo: object('PageInfo', { hasNextPage: start + nodes.length < items.length, hasPreviousPage: start > 0, startCursor: nodes.length ? cursor(nodes[0]!) : null, endCursor: nodes.length ? cursor(nodes[nodes.length - 1]!) : null }) };
}

function resolve(parent: ObjectValue, name: string, args: Record<string, Value>, actions: GraphQLActions): Value {
  const { type, value, repo } = parent;
  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return object('User', { login: VIEWER_LOGIN });
    if (name === 'repository') return object('Repository', store.getRepository(args.owner, args.name));
    if (name === 'node') return findNode(args.id);
    if (name === '__type') return own(schema, args.name) || own(enums, args.name) ? object('__Type', { name: args.name }) : null;
  }
  if (type === '__Type') {
    if (name === 'name') return value.name;
    if (name === 'kind') return own(enums, value.name) ? 'ENUM' : value.name === 'Node' ? 'INTERFACE' : 'OBJECT';
    if (name === 'fields') return own(schema, value.name) ? Object.keys(schema[value.name]!).map(name => object('__Field', { name })) : null;
    if (name === 'enumValues') return own(enums, value.name) ? enums[value.name]!.map(name => object('__EnumValue', { name })) : null;
  }
  if (type === 'Repository') {
    const repository = value as Repository;
    if (name === 'id') return idOf(type, repository.id);
    if (name === 'databaseId') return repository.id;
    if (name === 'nameWithOwner') return repository.full_name;
    if (name === 'owner') return object('User', { login: repository.owner ?? VIEWER_LOGIN });
    if (name === 'defaultBranchRef') return repository.refs.has(`refs/heads/${repository.default_branch}`) ? object('Ref', { name: repository.default_branch }) : null;
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') return object('Issue', store.getIssue(repository, args.number), repository);
    if (name === 'pullRequest') return object('PullRequest', store.getPullRequest(repository, args.number), repository);
    if (name === 'issues') {
      const issues = [...repository.issues.values()].filter(issue => args.states == null || args.states.includes(issue.state.toUpperCase()));
      const order = args.orderBy ?? { field: 'CREATED_AT', direction: 'ASC' }; const direction = order.direction === 'DESC' ? -1 : 1;
      issues.sort((a, b) => direction * ((order.field === 'COMMENTS' ? a.comments.length - b.comments.length : (order.field === 'UPDATED_AT' ? a.updated_at : a.created_at).localeCompare(order.field === 'UPDATED_AT' ? b.updated_at : b.created_at)) || a.number - b.number));
      return object('IssueConnection', connection(issues.map(issue => object('Issue', issue, repository)!), args, `issues:${repository.id}`, 'IssueEdge'));
    }
    if (name === 'pullRequests') {
      const pulls = [...repository.pulls.values()].filter(pull => args.states == null || args.states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase())).sort((a, b) => a.number - b.number);
      return object('PullRequestConnection', connection(pulls.map(pull => object('PullRequest', pull, repository)!), args, `pulls:${repository.id}`, 'PullRequestEdge'));
    }
  }
  if (type === 'Issue' || type === 'PullRequest') {
    if (name === 'id') return value.node_id;
    if (name === 'state') return type === 'PullRequest' && value.merged ? 'MERGED' : value.state.toUpperCase();
    if (type === 'PullRequest') {
      if (name === 'headRefName') return value.head.ref;
      if (name === 'baseRefName') return value.base.ref;
      if (name === 'mergeable') return value.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      if (name === 'files') return object('PullRequestChangedFileConnection', connection(value.files.map((file: any) => object('PullRequestChangedFile', { path: file.filename })), args, `files:${repo!.id}:${value.id}`));
    }
  }
  if (type === 'Mutation') {
    const input = args.input;
    const node = findNode(input.repositoryId ?? input.issueId ?? input.pullRequestId ?? input.subjectId);
    const expected = ['createIssue', 'createPullRequest'].includes(name) ? 'Repository' : name === 'mergePullRequest' ? 'PullRequest' : 'Issue';
    if (!node || node.type !== expected) throw new GraphError(`Could not resolve to a node with the global id provided for ${name}`);
    const repository = node.type === 'Repository' ? node.value as Repository : node.repo!;
    const clientMutationId = input.clientMutationId ?? null;
    if (name === 'createIssue') {
      const issue = store.createIssue(repository, input.title, input.body ?? '');
      if (!issue) throw new GraphError('Validation Failed: title is required');
      return object('CreateIssuePayload', { issue: object('Issue', issue, repository), clientMutationId });
    }
    if (name === 'closeIssue') return object('CloseIssuePayload', { issue: object('Issue', store.closeIssue(repository, node.value.number), repository), clientMutationId });
    if (name === 'createPullRequest') {
      const pull = actions.createPull(repository, input.title, input.headRefName, input.baseRefName, input.body ?? '');
      if (!pull) throw new GraphError('Validation Failed: title, head and base branches are required');
      return object('CreatePullRequestPayload', { pullRequest: object('PullRequest', pull, repository), clientMutationId });
    }
    if (name === 'mergePullRequest') {
      if (input.mergeMethod != null && input.mergeMethod !== 'SQUASH') throw new GraphError('Only SQUASH merges are supported');
      actions.mergePull(repository, node.value);
      return object('MergePullRequestPayload', { pullRequest: node, clientMutationId });
    }
    if (name === 'addComment') {
      const issue = store.addComment(repository, node.value.number, input.body)!;
      const comment = issue.comments[issue.comments.length - 1]!;
      return object('AddCommentPayload', { commentEdge: object('IssueCommentEdge', { node: object('IssueComment', { id: idOf('IssueComment', comment.id), body: comment.body }) }), clientMutationId });
    }
  }
  return value[name] ?? null;
}

/** Each operation gets its own envelope; batches execute in request order. */
export function executeGraphQL(request: any, actions: GraphQLActions): any {
  const source = typeof request?.query === 'string' ? request.query : '';
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request) || !source.trim()) throw new GraphError('A query string is required');
    const parser = new Parser(source); const operations = parser.document();
    const operation = request.operationName != null ? operations.find(item => item.name === request.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!operation) throw new GraphError(request.operationName != null ? `Unknown operation named ${request.operationName}` : 'Must provide operationName for multiple operations');
    if (request.variables != null && (typeof request.variables !== 'object' || Array.isArray(request.variables))) throw new GraphError('variables must be an object');
    const variables: Record<string, Value> = Object.create(null);
    for (const variable of operation.variables) { if (own(variables, variable.name)) throw new GraphError(`Duplicate variable $${variable.name}`); variables[variable.name] = coerce(request.variables?.[variable.name] === undefined ? variable.fallback : request.variables[variable.name], variable.type, `Variable $${variable.name}`); }
    const argumentsOf = new Map<Selection, Record<string, Value>>();
    const validate = (type: string, fields: Selection[], fragments = new Set<string>()): void => {
      for (const field of fields) {
        if (field.spread) {
          if (fragments.has(field.spread)) throw new GraphError(`Fragment cycle involving ${field.spread}`);
          const fragment = parser.fragments.get(field.spread); if (!fragment) throw new GraphError(`Unknown fragment ${field.spread}`);
          validate(type, [fragment], new Set(fragments).add(field.spread)); continue;
        }
        if (field.on) { if (!own(schema, field.on)) throw new GraphError(`Unknown type ${field.on}`); validate(field.on, field.fields, fragments); continue; }
        const descriptor = field.name === '__typename' ? f('String') : own(schema[type]!, field.name) ? schema[type]![field.name] : undefined;
        if (!descriptor) throw new GraphError(`Cannot query field "${field.name}" on type "${type}".`, field.offset);
        const args: Record<string, Value> = Object.create(null);
        for (const key of Object.keys(field.args)) if (!descriptor.args || !own(descriptor.args, key)) throw new GraphError(`Unknown argument ${key} on field ${field.name}`, field.offset);
        for (const [key, argType] of Object.entries(descriptor.args ?? {})) args[key] = coerce(valueOf(field.args[key], variables), argType, `Argument ${key}`);
        argumentsOf.set(field, args);
        if (own(schema, descriptor.type)) { if (!field.fields.length) throw new GraphError(`Field ${field.name} requires a selection of subfields`, field.offset); validate(descriptor.type, field.fields, fragments); }
        else if (field.fields.length) throw new GraphError(`Field ${field.name} must not have a selection`, field.offset);
      }
    };
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(rootType, operation.fields);
    const errors: any[] = [];
    const project = (parent: ObjectValue, fields: Selection[], path: (string | number)[] = []): any => {
      const result: Record<string, Value> = Object.create(null);
      for (const field of fields) {
        if (field.spread) { Object.assign(result, project(parent, [parser.fragments.get(field.spread)!], path)); continue; }
        if (field.on) { if (parent.type === field.on || field.on === 'Node' && ['Repository', 'Issue', 'PullRequest'].includes(parent.type)) Object.assign(result, project(parent, field.fields, path)); continue; }
        const fieldPath = [...path, field.alias];
        try {
          const value = resolve(parent, field.name, argumentsOf.get(field)!, actions);
          result[field.alias] = value == null ? null : Array.isArray(value) ? value.map((item, index) => field.fields.length && item != null ? project(item, field.fields, [...fieldPath, index]) : item) : field.fields.length ? project(value, field.fields, fieldPath) : value;
        } catch (error) { result[field.alias] = null; errors.push({ message: error instanceof Error ? error.message : 'Execution failed', path: fieldPath }); }
      }
      return result;
    };
    const data = project(object(rootType, {})!, operation.fields);
    return errors.length ? { data, errors } : { data };
  } catch (error) {
    const entry: any = { message: error instanceof Error ? error.message : 'Invalid GraphQL request' };
    if (error instanceof GraphError && error.offset !== undefined) { const lines = source.slice(0, error.offset).split('\n'); entry.locations = [{ line: lines.length, column: lines[lines.length - 1]!.length + 1 }]; }
    return { errors: [entry] };
  }
}
