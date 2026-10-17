import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../src/action.js';
import { IDS, TOKEN, act, inputEnv, json, parseOutputs } from './helpers.js';

const lock = { command: 'lock', group: IDS.group };
const locked = () => json(200, { locked_until: '2026-10-17T12:30:00Z', reason: 'x' });

function eventFile(payload) {
  const file = join(mkdtempSync(join(tmpdir(), 'event-')), 'event.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return file;
}

describe('triggers', () => {
  it('refuses pull_request_target before any request', async () => {
    const result = await act(lock, [], { env: { GITHUB_EVENT_NAME: 'pull_request_target' } });
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 0);
    assert.match(result.log, /::error::Deploy workflows must not run on pull_request_target/);
  });

  it('runs for a workflow_run from the same repository', async () => {
    const env = {
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: eventFile({ workflow_run: { head_repository: { id: 7 } }, repository: { id: 7 } }),
    };
    assert.equal((await act(lock, [locked()], { env })).code, 0);
  });

  for (const [what, payload] of [
    ['from a fork', { workflow_run: { head_repository: { id: 8 } }, repository: { id: 7 } }],
    ['without a head repository', { workflow_run: { head_repository: null }, repository: { id: 7 } }],
    ['without a repository', { workflow_run: { head_repository: { id: 7 } } }],
  ]) {
    it(`refuses a workflow_run ${what}`, async () => {
      const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventFile(payload) };
      const result = await act(lock, [], { env });
      assert.equal(result.code, 1);
      assert.match(result.log, /::error::This workflow_run was triggered by a run from another repository/);
    });
  }

  it('refuses a workflow_run whose event it cannot read', async () => {
    for (const env of [{ GITHUB_EVENT_PATH: eventFile('{') }, {}]) {
      const result = await act(lock, [], { env: { GITHUB_EVENT_NAME: 'workflow_run', ...env } });
      assert.match(result.log, /::error::The workflow_run event could not be read/);
    }
  });
});

describe('inputs', () => {
  it('names the commands for an unknown one', async () => {
    for (const command of ['', 'deploy', 'constructor', '__proto__']) {
      const result = await act({ command });
      assert.equal(result.code, 1);
      assert.match(result.log, /::error::command must be one of lock, unlock, release, nodes, node, deployed, rollout, ready, failed\./);
    }
  });

  it('explains an empty token', async () => {
    const result = await act({ ...lock, token: '' });
    assert.match(result.log, /::error::token is empty: the secret is not set, or this run gets no secrets/);
  });

  it('warns about another API and refuses plain http elsewhere', async () => {
    const other = await act({ ...lock, 'api-url': 'https://api.example.com/v1/' }, [locked()]);
    assert.equal(other.code, 0);
    assert.equal(other.requests[0].url, `https://api.example.com/v1/groups/${IDS.group}/lock`);
    assert.match(other.log, /::warning::api-url points the action at https:\/\/api\.example\.com\/v1, not at the Hetscale API\./);
    const plain = await act({ ...lock, 'api-url': 'http://api.example.com/v1' });
    assert.equal(plain.code, 1);
    assert.equal(plain.requests.length, 0);
  });

  it('uses the Hetscale API when api-url is empty', async () => {
    const result = await act({ ...lock, 'api-url': '' }, [locked()]);
    assert.equal(result.requests[0].url, `https://api.hetscale.com/v1/groups/${IDS.group}/lock`);
    assert.doesNotMatch(result.log, /::warning::/);
  });
});

describe('the token', () => {
  it('is masked whole and by its secret, and appears nowhere else', async () => {
    const secret = TOKEN.slice(TOKEN.indexOf('|') + 1);
    const result = await act(lock, [locked()]);
    const lines = result.log.split(/\r?\n/);
    assert.deepEqual(lines.slice(0, 2), [`::add-mask::${TOKEN}`, `::add-mask::${secret}`]);
    assert.ok(!lines.slice(2).join('\n').includes(secret));
    assert.ok(!JSON.stringify(result.outputs).includes(secret));
  });

  it('is masked even when it has the wrong shape', async () => {
    const result = await act({ ...lock, token: 'not-a-token' });
    assert.match(result.log, /^::add-mask::not-a-token\r?\n/);
    assert.doesNotMatch(result.log, /::error::.*not-a-token/);
  });
});

describe('run', () => {
  it('runs with the default clock and sleep, and fails a cancelled wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-'));
    const env = {
      GITHUB_OUTPUT: join(dir, 'output'),
      ...inputEnv({ command: 'lock', token: TOKEN, group: IDS.group, ttl: '1800' }),
    };
    let printed = '';
    const write = (chunk) => {
      printed += chunk;
    };
    assert.equal(await run({ env, write, fetch: async () => locked() }), 0);
    assert.equal(parseOutputs(env.GITHUB_OUTPUT)['locked-until'], '2026-10-17T12:30:00Z');

    const controller = new AbortController();
    controller.abort();
    const busy = async () => json(503, { message: 'Later.', code: 'provider_unavailable' }, { 'Retry-After': '1' });
    assert.equal(await run({ env, write, fetch: busy, signal: controller.signal }), 1);
    assert.match(printed, /::error::The run was cancelled\./);
  });

  it('reports a failure that is not an Error', async () => {
    let printed = '';
    const env = inputEnv({ command: 'lock', token: TOKEN, group: IDS.group, ttl: '1800' });
    const code = await run({
      env,
      write: (chunk) => {
        printed += chunk;
      },
      fetch: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
      sleep: () => Promise.resolve(),
      now: () => {
        throw 'clock broke';
      },
    });
    assert.equal(code, 1);
    assert.match(printed, /::error::The action failed unexpectedly: clock broke/);
  });
});
