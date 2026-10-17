import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/action.js';
import { IDS, TOKEN, ulid } from './stub-server.mjs';

export { IDS, TOKEN };

// No test reaches the network: anything that falls back to the real fetch fails at once.
globalThis.fetch = async () => {
  throw new Error('A test tried to reach the network.');
};

export const ROOT = new URL('../', import.meta.url);
export const SHA = '0123456789abcdef0123456789abcdef01234567';

// The input defaults of action.yml, read from the file so that tests run the action as declared.
export function declaredDefaults() {
  const text = readFileSync(new URL('action.yml', ROOT), 'utf8');
  const section = text.slice(text.indexOf('\ninputs:'), text.indexOf('\noutputs:'));
  const defaults = {};
  let name;
  for (const line of section.split(/\r?\n/)) {
    const key = line.match(/^ {2}([a-z-]+):$/);
    if (key) [, name] = key;
    const value = line.match(/^ {4}default: (.*)$/);
    if (value) defaults[name] = value[1].replace(/^'(.*)'$/, '$1');
  }
  return defaults;
}

export const OTHER_RELEASE = `rel_${ulid(99)}`;

export function server(number, overrides = {}) {
  return {
    id: `node_${ulid(number)}`,
    server_id: 1000 + number,
    name: `hetscale-web-${number}`,
    class: 'managed',
    phase: 'ACTIVE',
    ipv4: `203.0.113.${number}`,
    ipv6: null,
    private_ip: `10.0.0.${number}`,
    location: 'nbg1',
    server_type: 'cx23',
    release: { id: IDS.release, version: 1, ref: 'ghcr.io/acme/app:1.0.0', build_id: '41', source: 'api', created_at: '2026-10-01T10:00:00Z' },
    build_id: '41',
    phase_entered_at: '2026-10-01T10:00:00Z',
    older: false,
    ...overrides,
  };
}

export const inventory = (...servers) => json(200, { group: { id: IDS.group, name: 'web', generation: 3 }, nodes: servers });

export function inputEnv(values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));
}

export function parseOutputs(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const outputs = {};
  for (const match of text.matchAll(/^([a-z-]+)<<(ghadelimiter_[0-9a-f-]{36})\r?\n([\s\S]*?)\r?\n\2\r?\n/gm)) {
    outputs[match[1]] = match[3];
  }
  return outputs;
}

export function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Runs the action once with the declared defaults, a fake fetch that answers from a queue, a fake
// clock that only sleeps move, and GITHUB_OUTPUT in a temporary file.
export async function act(values, answers = [], { env = {}, signal } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'deploy-action-')), 'output');
  const queue = [...answers];
  const requests = [];
  const sleeps = [];
  let clock = 1_000_000;
  let printed = '';

  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`No answer queued for ${init.method} ${url}.`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  const defaults = { ...declaredDefaults(), 'build-id': SHA, token: TOKEN };
  const code = await run({
    env: { GITHUB_OUTPUT: file, ...inputEnv({ ...defaults, ...values }), ...env },
    write: (chunk) => {
      printed += chunk;
    },
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    ...(signal ? { signal } : {}),
  });
  return {
    code,
    outputs: parseOutputs(file),
    log: printed,
    requests,
    sleeps,
    pending: queue.length,
    body: (index) => JSON.parse(requests[index].body),
  };
}
