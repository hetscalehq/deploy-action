// A loopback stub of the eight API operations the action calls, for its tests and its CI self-test.
// It answers like the API reference at https://hetscale.com/docs/api, for one group and five servers.
//
//   node test/stub-server.mjs start          starts it in the background and prints its url
//   node test/stub-server.mjs verify <url>   checks the requests it saw, then stops it
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const TOKEN = '1|stub_token';

export const ulid = (n) => `01k7hsc${'0'.repeat(17)}${String(n).padStart(2, '0')}`;

export const IDS = {
  group: `grp_${ulid(1)}`,
  release: `rel_${ulid(1)}`,
  seed: `node_${ulid(1)}`,
  serving: `node_${ulid(2)}`,
  booting: `node_${ulid(3)}`,
  fresh: `node_${ulid(4)}`,
  doomed: `node_${ulid(5)}`,
};

const STARTING = new Set(['BOOTING', 'DEPLOYING', 'HEALTH_CHECKING']);

function createState() {
  const first = {
    id: IDS.release,
    version: 1,
    ref: `ghcr.io/acme/app@sha256:${'a'.repeat(64)}`,
    build_id: '1',
    source: 'api',
    created_at: '2026-10-01T10:00:00Z',
  };
  const server = (id, number, kind, phase, release, ipv4, privateIp) => ({
    node: {
      id,
      server_id: 1000 + number,
      name: kind === 'adopted' ? 'web-seed' : `hetscale-web-${number}`,
      class: kind,
      phase,
      ipv4,
      ipv6: null,
      private_ip: privateIp,
      location: 'nbg1',
      server_type: 'cx23',
      release,
      build_id: release?.build_id ?? null,
      phase_entered_at: '2026-10-01T10:00:00Z',
      older: false,
    },
    generation: 1,
    readyAt: null,
    failedAt: null,
  });
  return {
    group: { id: IDS.group, name: 'web', generation: 1 },
    releases: [first],
    current: first,
    servers: [
      server(IDS.seed, 0, 'adopted', 'ACTIVE', null, '203.0.113.10', null),
      server(IDS.serving, 1, 'managed', 'ACTIVE', first, '203.0.113.11', '10.0.0.11'),
      server(IDS.booting, 2, 'managed', 'BOOTING', first, '203.0.113.12', '10.0.0.12'),
      server(IDS.fresh, 3, 'managed', 'DEPLOYING', first, '203.0.113.13', '10.0.0.13'),
      server(IDS.doomed, 4, 'managed', 'DEPLOYING', first, '203.0.113.14', '10.0.0.14'),
    ],
    rollout: null,
    // The first rollout request is answered 503, so a retry with its own key is part of every run.
    faults: { rollout: 1 },
    keys: new Map(),
    requests: [],
  };
}

const error = (status, code, message, extra = {}) => ({ status, json: { message, code, ...extra } });
const invalid = (field, message) => error(422, 'validation_failed', 'The request body is not valid.', { errors: { [field]: [message] } });

function view(state, entry) {
  const older = entry.node.class === 'managed' && entry.node.release?.id !== state.current.id;
  return { ...entry.node, older };
}

function nodeState(entry) {
  return {
    id: entry.node.id,
    phase: entry.node.phase,
    generation: entry.generation,
    release: entry.node.release?.id ?? null,
    ready_reported_at: entry.readyAt,
    failed_reported_at: entry.failedAt,
  };
}

function lock(state, method, body) {
  if (method === 'DELETE') return { status: 200, json: { locked_until: null, reason: null } };
  if (!Number.isInteger(body.ttl) || body.ttl < 60 || body.ttl > 7200) return invalid('ttl', 'From 60 to 7200.');
  if (typeof body.reason !== 'string' || body.reason.length < 1 || body.reason.length > 200) {
    return invalid('reason', 'From 1 to 200 characters.');
  }
  const until = new Date(Date.now() + body.ttl * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  return { status: 200, json: { locked_until: until, reason: body.reason } };
}

function release(state, body) {
  if (typeof body.ref !== 'string' || body.ref.length < 1 || body.ref.length > 200) return invalid('ref', 'From 1 to 200 characters.');
  const buildId = body.build_id ?? null;
  if (buildId !== null && (typeof buildId !== 'string' || buildId.length > 120)) return invalid('build_id', 'At most 120 characters.');
  if (state.current.ref === body.ref && state.current.build_id === buildId) {
    return { status: 200, json: { release: state.current, group: state.group } };
  }
  const version = state.releases.length + 1;
  const created = { id: `rel_${ulid(version)}`, version, ref: body.ref, build_id: buildId, source: 'api', created_at: new Date().toISOString() };
  state.releases.push(created);
  state.current = created;
  state.group.generation += 1;
  return { status: 201, json: { release: created, group: state.group } };
}

function nodes(state, url) {
  const listed = state.servers
    .filter((entry) => entry.node.phase !== 'TERMINATED')
    .filter((entry) => url.searchParams.get('phase') !== 'active' || entry.node.phase === 'ACTIVE')
    .map((entry) => view(state, entry));
  // Each read moves the servers that need no pipeline one step on, so a wait for them ends.
  for (const entry of state.servers) {
    if (entry.node.phase === 'BOOTING' || entry.node.phase === 'HEALTH_CHECKING') entry.node.phase = 'ACTIVE';
  }
  return { status: 200, json: { group: state.group, nodes: listed } };
}

function rollout(state) {
  if (state.rollout) return error(409, 'already_running', 'Older servers of this group are already being replaced.');
  const older = state.servers.filter((entry) => view(state, entry).older && entry.node.phase !== 'TERMINATED').length;
  if (older === 0) return error(409, 'nothing_to_replace', 'Every server of the group runs the current release and template.');
  state.rollout = { id: `rol_${ulid(1)}`, started_at: new Date().toISOString(), release: state.current.id, older };
  return { status: 201, json: { rollout: state.rollout } };
}

function deployed(state, entry, body) {
  if (typeof body.release !== 'string') return invalid('release', 'Required.');
  const named = state.releases.find((item) => item.id === body.release.toLowerCase());
  if (!named) return error(422, 'release_unknown', "The release is not one of the node's group.");
  if (entry.node.class !== 'managed') return error(409, 'node_not_managed', 'The node is not one Hetscale manages.');
  if (entry.node.phase !== 'ACTIVE') return error(409, 'node_not_active', 'The node is not serving.');
  entry.node.release = named;
  entry.node.build_id = named.build_id;
  return { status: 200, json: { node: { id: entry.node.id, phase: entry.node.phase, generation: entry.generation, release: named.id, build_id: named.build_id } } };
}

function report(state, entry, kind, body) {
  if (typeof body.release !== 'string' || !/^rel_[0-7][0-9a-hjkmnp-tv-z]{25}$/i.test(body.release)) {
    return invalid('release', 'A release id.');
  }
  if (!Number.isInteger(body.generation) || body.generation < 1) return invalid('generation', 'A whole number from 1.');
  if (kind === 'failed' && (typeof body.reason !== 'string' || body.reason.length > 500)) {
    return invalid('reason', 'At most 500 characters.');
  }
  const conflict = (code, message) => error(409, code, message, { node: nodeState(entry) });
  if (entry.node.release?.id !== body.release.toLowerCase()) return conflict('stale_release', "The report names another release than the node's.");
  if (entry.generation !== body.generation) return conflict('stale_generation', "The report names another generation than the node's.");
  const accepted = () => ({ status: 202, json: { node: nodeState(entry) } });

  if (kind === 'ready') {
    if (entry.failedAt) return conflict('failure_reported', 'A failure was reported for this node already.');
    if (entry.readyAt || entry.node.phase === 'ACTIVE') return accepted();
    if (!STARTING.has(entry.node.phase)) return conflict('not_in_readiness', 'The node no longer waits for its deploy.');
    entry.readyAt = new Date().toISOString();
    entry.node.phase = 'HEALTH_CHECKING';
    return accepted();
  }
  if (entry.failedAt) return accepted();
  if (!STARTING.has(entry.node.phase)) return conflict('not_in_readiness', 'The node no longer waits for its deploy.');
  entry.failedAt = new Date().toISOString();
  entry.node.phase = 'DEPLOY_FAILED';
  return accepted();
}

function route(state, method, url, body) {
  let match = url.pathname.match(/^\/v1\/groups\/([^/]+)\/(lock|releases|nodes|rollout)$/);
  if (match) {
    const [, group, what] = match;
    const allowed = { lock: ['POST', 'DELETE'], releases: ['POST'], nodes: ['GET'], rollout: ['POST'] }[what];
    if (!allowed.includes(method)) return error(405, 'method_not_allowed', 'This path does not take that method.');
    if (group.toLowerCase() !== state.group.id) return error(404, 'not_found', 'Not found.');
    if (what === 'lock') return lock(state, method, body);
    if (what === 'releases') return release(state, body);
    if (what === 'nodes') return nodes(state, url);
    return rollout(state);
  }
  match = url.pathname.match(/^\/v1\/nodes\/([^/]+)\/(deployed|ready|failed)$/);
  if (match) {
    const [, nodeId, kind] = match;
    if (method !== 'POST') return error(405, 'method_not_allowed', 'This path does not take that method.');
    const entry = state.servers.find((item) => item.node.id === nodeId.toLowerCase());
    if (!entry) return error(404, 'not_found', 'Not found.');
    return kind === 'deployed' ? deployed(state, entry, body) : report(state, entry, kind, body);
  }
  return error(404, 'not_found', 'Not found.');
}

function answer(state, request, url, text) {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return error(401, 'unauthenticated', 'The API token is missing, unknown, expired or revoked.');
  }
  const key = request.headers['idempotency-key'];
  const fingerprint = `${request.method} ${url.pathname}${url.search} ${text}`;
  const stored = key === undefined ? undefined : state.keys.get(key);
  if (stored) {
    if (stored.fingerprint !== fingerprint) return error(422, 'idempotency_key_reused', 'This Idempotency-Key was sent with a different request.');
    return { ...stored.answer, headers: { 'Idempotent-Replayed': 'true' } };
  }
  if (url.pathname.endsWith('/rollout') && state.faults.rollout > 0) {
    state.faults.rollout -= 1;
    return { ...error(503, 'provider_unavailable', 'Hetzner could not be asked just now.'), headers: { 'Retry-After': '1' } };
  }
  let body = {};
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      return error(422, 'validation_failed', 'The request body is not valid.');
    }
  }
  const result = route(state, request.method, url, body ?? {});
  if (key !== undefined && (result.status < 300 || result.status === 409)) state.keys.set(key, { fingerprint, answer: result });
  return result;
}

export function startStub({ port = 0 } = {}) {
  const state = createState();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, json, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(json));
    };
    if (url.pathname === '/_stub/requests') return send(200, state.requests);
    if (url.pathname === '/_stub/stop') {
      send(200, {});
      server.close();
      server.closeAllConnections();
      return undefined;
    }
    const result = answer(state, request, url, text);
    state.requests.push({
      method: request.method,
      path: url.pathname,
      key: request.headers['idempotency-key'] ?? null,
      authorized: request.headers.authorization === `Bearer ${TOKEN}`,
      status: result.status,
      code: result.json.code ?? null,
    });
    return send(result.status, result.json, result.headers);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        state,
        close: () =>
          new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          }),
      });
    });
  });
}

// What every self-test run must show, whatever its steps: the token on every call, a key on every
// POST and on its retries only, a retry that happened, the lock released last, and one ready report
// for the new server however often it was dispatched.
export function verify(requests) {
  const problems = [];
  if (requests.length === 0) problems.push('The stub saw no request.');
  const byKey = new Map();
  for (const request of requests) {
    const call = `${request.method} ${request.path}`;
    if (!request.authorized) problems.push(`${call} did not carry the test token.`);
    if (request.method === 'POST' && !request.key) problems.push(`${call} carried no Idempotency-Key.`);
    if (request.method !== 'POST' && request.key) problems.push(`${call} carried an Idempotency-Key.`);
    if (request.key) byKey.set(request.key, [...(byKey.get(request.key) ?? []), request]);
  }
  let retried = 0;
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    retried += 1;
    if (list.some((request) => request.method !== list[0].method || request.path !== list[0].path)) {
      problems.push(`Idempotency-Key ${key} was sent with different requests.`);
    }
    const retryable = (request) => request.status >= 500 || request.status === 429 || request.code === 'idempotency_key_in_flight';
    if (!list.slice(0, -1).every(retryable)) problems.push(`Idempotency-Key ${key} was sent again after an answer that is not retried.`);
  }
  if (retried === 0) problems.push('No call was retried with its own Idempotency-Key.');
  const last = requests.filter((request) => request.path.endsWith('/lock')).at(-1);
  if (last?.method !== 'DELETE' || last?.status !== 200) problems.push('The deploy lock was not released last.');
  const readies = requests.filter((request) => request.method === 'POST' && request.path === `/v1/nodes/${IDS.fresh}/ready`).length;
  if (readies !== 1) problems.push(`The new server was reported ready ${readies} times, not once.`);
  return problems;
}

async function start() {
  const ready = join(tmpdir(), `deploy-action-stub-${randomUUID()}`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', ready], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let tries = 0; tries < 100 && !existsSync(ready); tries += 1) await delay(100);
  if (!existsSync(ready)) throw new Error('The stub did not start within 10 seconds.');
  const url = readFileSync(ready, 'utf8');
  rmSync(ready);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}${EOL}`);
  console.log(`The API stub listens at ${url}.`);
}

async function serve(ready) {
  const { url } = await startStub();
  writeFileSync(`${ready}.tmp`, url);
  renameSync(`${ready}.tmp`, ready);
}

async function check(url) {
  const base = new URL(url);
  const requests = await (await fetch(new URL('/_stub/requests', base))).json();
  await fetch(new URL('/_stub/stop', base), { method: 'POST' });
  const problems = verify(requests);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`The stub saw ${requests.length} requests, as the self-test expects.`);
}

if (import.meta.main) {
  const [mode, argument] = process.argv.slice(2);
  const modes = { start, serve, verify: check };
  if (!Object.hasOwn(modes, mode)) {
    console.error('Usage: node test/stub-server.mjs start | verify <url>');
    process.exit(2);
  }
  await modes[mode](argument);
}
