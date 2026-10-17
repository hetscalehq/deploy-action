import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IDS, ROOT, SHA, TOKEN, declaredDefaults, inputEnv, parseOutputs } from './helpers.js';
import { startStub, verify } from './stub-server.mjs';

const exec = promisify(execFile);
const path = (relative) => fileURLToPath(new URL(relative, ROOT));

// Runs a script as the runner would: a fresh process with only the variables it is given.
async function node(script, env) {
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  try {
    const { stdout } = await exec(process.execPath, [path(script)], { env: { ...base, ...env }, cwd: path('.') });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout };
  }
}

describe('the action against the API stub', () => {
  let stub;
  before(async () => {
    stub = await startStub();
  });
  after(() => stub.close());

  async function step(inputs) {
    const output = join(mkdtempSync(join(tmpdir(), 'e2e-')), 'output');
    const values = { ...declaredDefaults(), 'build-id': SHA, token: TOKEN, 'api-url': stub.url, ...inputs };
    const result = await node('src/main.js', { GITHUB_OUTPUT: output, ...inputEnv(values) });
    return { ...result, outputs: parseOutputs(output) };
  }

  it('runs a deploy, a rollout and a new server end to end', async () => {
    const lock = await step({ command: 'lock', group: IDS.group });
    assert.equal(lock.code, 0, lock.stdout);
    assert.match(lock.outputs['locked-until'], /^\d{4}-\d\d-\d\dT/);
    assert.match(lock.stdout, /::warning::api-url points the action at http:\/\/127\.0\.0\.1:/);

    const release = await step({ command: 'release', group: IDS.group, ref: 'ghcr.io/acme/app@sha256:bbb' });
    assert.equal(release.outputs.created, 'true');
    assert.equal(release.outputs.generation, '2');
    const current = release.outputs['release-id'];

    const nodes = await step({ command: 'nodes', group: IDS.group, 'release-id': current, wait: '0' });
    assert.equal(nodes.code, 0, nodes.stdout);
    assert.equal(nodes.outputs.hosts, '203.0.113.10\n203.0.113.11');
    assert.equal(nodes.outputs['adopted-hosts'], '203.0.113.10');
    assert.equal(nodes.outputs['in-flight-older'], [IDS.booting, IDS.fresh, IDS.doomed].join('\n'));

    const ids = `${nodes.outputs['managed-node-ids']}\n${IDS.seed}`;
    const deployed = await step({ command: 'deployed', 'release-id': current, 'node-ids': ids });
    assert.deepEqual(deployed.outputs, { reported: '1', skipped: '1' });

    assert.equal((await step({ command: 'unlock', group: IDS.group })).code, 0);

    const rollout = await step({ command: 'rollout', group: IDS.group });
    assert.equal(rollout.code, 0, rollout.stdout);
    assert.match(rollout.stdout, /answered 503 provider_unavailable; trying again in 1\.0 s/);
    assert.equal(rollout.outputs.older, '3');

    const dispatch = { group: IDS.group, 'node-id': IDS.fresh, 'release-id': IDS.release };
    const first = await step({ command: 'node', ...dispatch });
    assert.equal(first.outputs.deploy, 'true');
    assert.equal(first.outputs.address, '203.0.113.13');
    const ready = await step({ command: 'ready', 'node-id': IDS.fresh, 'release-id': IDS.release, generation: '1' });
    assert.equal(ready.outputs.phase, 'HEALTH_CHECKING');
    const again = await step({ command: 'node', ...dispatch });
    assert.equal(again.outputs.deploy, 'false');

    const report = { 'node-id': IDS.doomed, 'release-id': IDS.release, generation: '1' };
    assert.equal((await step({ command: 'failed', ...report })).outputs.phase, 'DEPLOY_FAILED');
    const late = await step({ command: 'ready', ...report });
    assert.equal(late.code, 1);
    assert.match(late.stdout, /::error::Hetscale answered 409 failure_reported/);

    assert.deepEqual(verify(stub.state.requests), []);
    for (const result of [lock, release, nodes, deployed, rollout, first, ready, again, late]) {
      assert.ok(!result.stdout.split(/\r?\n/).filter((line) => !line.startsWith('::add-mask::')).join('\n').includes('stub_token'));
    }
  });

  it('answers a wrong token, a wrong path and a bad body like the API', async () => {
    const unknown = await step({ command: 'unlock', group: IDS.group, token: '1|wrong' });
    assert.match(unknown.stdout, /Hetscale answered 401 unauthenticated/);
    const other = await step({ command: 'unlock', group: IDS.serving.replace('node', 'grp') });
    assert.match(other.stdout, /Hetscale answered 404 not_found/);
    const status = await new Promise((resolve, reject) => {
      const headers = { Authorization: `Bearer ${TOKEN}` };
      const sent = request(`${stub.url}/groups/${IDS.group}/lock`, { method: 'POST', headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      sent.on('error', reject);
      sent.end('{');
    });
    assert.equal(status, 422);
  });
});

describe('verify', () => {
  const lockReleased = { method: 'DELETE', path: `/v1/groups/${IDS.group}/lock`, key: null, authorized: true, status: 200, code: null };
  const ready = { method: 'POST', path: `/v1/nodes/${IDS.fresh}/ready`, key: 'r', authorized: true, status: 202, code: null };
  const retry = (status, code = null) => ({ method: 'POST', path: '/v1/x', key: 'k', authorized: true, status, code });

  it('finds nothing wrong in a clean run', () => {
    assert.deepEqual(verify([retry(503), retry(201), ready, lockReleased]), []);
  });

  it('names every problem', () => {
    const problems = verify([
      { ...ready, authorized: false, key: null },
      { method: 'GET', path: '/v1/y', key: 'g', authorized: true, status: 200, code: null },
      retry(409, 'already_running'),
      { ...retry(201), path: '/v1/z' },
      { ...lockReleased, method: 'POST', key: 'l' },
    ]);
    assert.deepEqual(problems, [
      `POST /v1/nodes/${IDS.fresh}/ready did not carry the test token.`,
      `POST /v1/nodes/${IDS.fresh}/ready carried no Idempotency-Key.`,
      'GET /v1/y carried an Idempotency-Key.',
      'Idempotency-Key k was sent with different requests.',
      'Idempotency-Key k was sent again after an answer that is not retried.',
      'The deploy lock was not released last.',
    ]);
    assert.deepEqual(verify([]), [
      'The stub saw no request.',
      'No call was retried with its own Idempotency-Key.',
      'The deploy lock was not released last.',
      'The new server was reported ready 0 times, not once.',
    ]);
  });
});

describe('pr-title', () => {
  for (const title of ['feat: add the rollout command', 'fix(api)!: refuse redirects', 'chore(deps): bump the actions group with 2 updates']) {
    it(`takes "${title}"`, async () => {
      assert.equal((await node('scripts/pr-title.mjs', { PR_TITLE: title })).code, 0);
    });
  }

  for (const title of ['', 'Update code', 'feat:no space', 'Feat: capital type', 'feat(API): upper scope', 'feat: ends with a period.', `feat: ${'x'.repeat(70)}`]) {
    it(`refuses "${title.slice(0, 30)}" without echoing it`, async () => {
      const result = await node('scripts/pr-title.mjs', { PR_TITLE: title });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /^::error::The pull request title must /);
      if (title) assert.ok(!result.stdout.includes(title));
    });
  }
});
