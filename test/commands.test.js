import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDS, OTHER_RELEASE, SHA, act, inventory, json, server } from './helpers.js';

const API = 'https://api.hetscale.com/v1';
const RUN_ENV = {
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_SHA: SHA,
  GITHUB_WORKFLOW: 'Deploy',
  GITHUB_RUN_ID: '99',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SERVER_URL: 'https://github.com',
};
const release = (overrides = {}) => ({
  id: OTHER_RELEASE,
  version: 4,
  ref: 'ghcr.io/acme/app@sha256:abc',
  build_id: SHA,
  source: 'api',
  created_at: '2026-10-17T10:00:00Z',
  ...overrides,
});
const nodeState = (phase, overrides = {}) => ({
  node: { id: IDS.fresh, phase, generation: 7, release: IDS.release, ready_reported_at: null, failed_reported_at: null, ...overrides },
});
const refusal = (status, code, message = 'Refused.', extra = {}) => json(status, { message, code, ...extra });

describe('lock', () => {
  it('holds the lock with the ttl and a reason naming the run', async () => {
    const result = await act({ command: 'lock', group: IDS.group.toUpperCase() }, [
      json(200, { locked_until: '2026-10-17T12:30:00Z', reason: 'x' }),
    ], { env: RUN_ENV });
    assert.equal(result.code, 0);
    assert.equal(result.requests[0].url, `${API}/groups/${IDS.group}/lock`);
    assert.equal(result.requests[0].method, 'POST');
    assert.deepEqual(result.body(0), { ttl: 1800, reason: 'acme/app@0123456: Deploy run 99' });
    assert.equal(result.outputs['locked-until'], '2026-10-17T12:30:00Z');
  });

  it('takes a reason and a ttl of its own', async () => {
    const result = await act({ command: 'lock', group: IDS.group, ttl: '60', reason: 'hotfix' }, [
      json(200, { locked_until: 'later', reason: 'hotfix' }),
    ]);
    assert.deepEqual(result.body(0), { ttl: 60, reason: 'hotfix' });
  });

  it('gives a plain reason outside a workflow run', async () => {
    const result = await act({ command: 'lock', group: IDS.group }, [json(200, { locked_until: 'later', reason: 'x' })]);
    assert.equal(result.body(0).reason, 'deploy from GitHub Actions');
  });

  it('cuts a long default reason to 200 characters', async () => {
    const env = { ...RUN_ENV, GITHUB_WORKFLOW: 'w'.repeat(300) };
    const result = await act({ command: 'lock', group: IDS.group }, [json(200, { locked_until: 'later', reason: 'x' })], { env });
    assert.equal(result.body(0).reason.length, 200);
  });

  for (const [inputs, message] of [
    [{ group: '' }, 'lock needs the group input.'],
    [{ group: 'grp_nope' }, 'group is not a group id'],
    [{ group: IDS.group, ttl: '59' }, 'ttl must be a whole number from 60 to 7200'],
    [{ group: IDS.group, ttl: '' }, 'lock needs the ttl input.'],
    [{ group: IDS.group, reason: 'x'.repeat(201) }, 'reason is longer than 200 characters'],
  ]) {
    it(`fails before any request: ${message}`, async () => {
      const result = await act({ command: 'lock', ...inputs });
      assert.equal(result.code, 1);
      assert.equal(result.requests.length, 0);
      assert.match(result.log, new RegExp(`::error::${message.replace(/[.()]/g, '\\$&')}`));
    });
  }

  it('fails on a group that is not Live', async () => {
    const result = await act({ command: 'lock', group: IDS.group }, [refusal(409, 'not_live', 'The group is not in a state for this.')]);
    assert.equal(result.code, 1);
    assert.match(result.log, /::error::Hetscale answered 409 not_live: The group is not in a state for this\./);
  });
});

describe('unlock', () => {
  it('releases the lock with a DELETE that carries no key and no body', async () => {
    const result = await act({ command: 'unlock', group: IDS.group }, [json(200, { locked_until: null, reason: null })]);
    assert.equal(result.code, 0);
    assert.equal(result.requests[0].method, 'DELETE');
    assert.equal(result.requests[0].body, undefined);
    assert.equal(result.requests[0].headers['Idempotency-Key'], undefined);
    assert.equal(result.requests[0].headers['Content-Type'], undefined);
  });

  it('names a new token on 401', async () => {
    const result = await act({ command: 'unlock', group: IDS.group }, [refusal(401, 'unauthenticated')]);
    assert.equal(result.code, 1);
    assert.match(result.log, /Hint: the token expired or was revoked/);
  });
});

describe('release', () => {
  it('records a release with the build id', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'ghcr.io/acme/app@sha256:abc' }, [
      json(201, { release: release(), group: { id: IDS.group, name: 'web', generation: 8 } }),
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.body(0), { ref: 'ghcr.io/acme/app@sha256:abc', build_id: SHA });
    assert.deepEqual(result.outputs, { 'release-id': OTHER_RELEASE, 'release-version': '4', generation: '8', created: 'true' });
  });

  it('says so when the release already is the current one', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'abc', 'build-id': '' }, [
      json(200, { release: release({ version: undefined }), group: { id: IDS.group, name: 'web', generation: 8 } }),
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.body(0), { ref: 'abc' });
    assert.equal(result.outputs.created, 'false');
    assert.equal(result.outputs['release-version'], '');
    assert.match(result.log, /::notice::Release .* already is the current release/);
  });

  it('logs a release without a version plainly', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'abc' }, [
      json(201, { release: release({ version: undefined }), group: { id: IDS.group, name: 'web', generation: 8 } }),
    ]);
    assert.match(result.log, new RegExp(`Recorded release ${OTHER_RELEASE} as current`));
  });

  it('needs a ref', async () => {
    const result = await act({ command: 'release', group: IDS.group });
    assert.match(result.log, /release needs the ref input\./);
  });

  it('explains a ref of the wrong kind', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'web:latest' }, [refusal(422, 'ref_invalid')]);
    assert.equal(result.code, 1);
    assert.match(result.log, /Hint: a snapshot group takes the numeric id of a snapshot/);
  });

  it('lists the fields of a validation failure', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'x' }, [
      refusal(422, 'validation_failed', 'The request body is not valid.', { errors: { ref: ['Too long.'], build_id: 'Bad.' } }),
    ]);
    assert.match(result.log, /validation_failed: The request body is not valid\.%0Aref: Too long\.%0Abuild_id: Bad\./);
  });

  it('fails unexpectedly on an answer outside the contract', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: 'x' }, [json(201, {})]);
    assert.equal(result.code, 1);
    assert.match(result.log, /::error::The action failed unexpectedly: /);
    assert.match(result.log, /::debug::TypeError/);
  });
});

describe('nodes', () => {
  const seed = server(10, { class: 'adopted', release: null, build_id: null, private_ip: null });

  it('gives the serving servers, the seed included, and the managed ids', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [
      inventory(seed, server(11), server(12, { phase: 'DEPLOYING' }), server(13, { phase: 'DRAINING' })),
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.requests[0].url, `${API}/groups/${IDS.group}/nodes`);
    assert.equal(result.requests[0].headers['Idempotency-Key'], undefined);
    assert.equal(result.outputs.hosts, '203.0.113.10\n203.0.113.11');
    assert.equal(result.outputs['adopted-hosts'], '203.0.113.10');
    assert.equal(result.outputs['managed-node-ids'], server(11).id);
    assert.equal(result.outputs.count, '2');
    assert.deepEqual(JSON.parse(result.outputs.nodes), [seed, server(11)]);
    assert.equal(result.outputs['in-flight-older'], '');
    assert.doesNotMatch(result.log, /203\.0\.113/);
  });

  it('gives private addresses on request', async () => {
    const result = await act({ command: 'nodes', group: IDS.group, address: 'private_ip' }, [inventory(server(11), server(12))]);
    assert.equal(result.outputs.hosts, '10.0.0.11\n10.0.0.12');
  });

  it('fails when a serving server has no address of the kind asked for', async () => {
    const result = await act({ command: 'nodes', group: IDS.group, address: 'private_ip' }, [inventory(seed)]);
    assert.equal(result.code, 1);
    assert.match(result.log, new RegExp(`::error::Node ${seed.id} has no private_ip address\\. Set address to ipv4`));
    assert.deepEqual(result.outputs, {});
  });

  it('suggests private_ip for a server without a public address', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [inventory(server(11, { ipv4: null }))]);
    assert.match(result.log, /has no ipv4 address\. Set address to private_ip/);
  });

  it('gives empty outputs for an empty group', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [inventory()]);
    assert.equal(result.code, 0);
    assert.equal(result.outputs.hosts, '');
    assert.equal(result.outputs.count, '0');
    assert.equal(result.outputs.nodes, '[]');
    assert.match(result.log, /::notice::Group .* has no serving servers/);
  });

  it('waits for servers that started on an earlier release until they serve', async () => {
    const old = { ...release(), id: IDS.release };
    const result = await act({ command: 'nodes', group: IDS.group, 'release-id': OTHER_RELEASE }, [
      inventory(server(11, { release: release() }), server(12, { phase: 'BOOTING', release: old }), server(13, { phase: 'DEPLOYING', release: release() })),
      inventory(server(11, { release: release() }), server(12, { phase: 'HEALTH_CHECKING', release: old })),
      inventory(server(11, { release: release() }), server(12, { release: old })),
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.sleeps, [15_000, 15_000]);
    assert.equal(result.outputs.hosts, '203.0.113.11\n203.0.113.12');
    assert.equal(result.outputs['in-flight-older'], '');
    assert.match(result.log, /Waiting for 1 server\(s\) that started on an earlier release\./);
  });

  it('stops waiting at the bound and names the servers left out', async () => {
    const starting = server(12, { phase: 'PROVISIONING', release: null });
    const result = await act({ command: 'nodes', group: IDS.group, 'release-id': OTHER_RELEASE.toUpperCase(), wait: '20' }, [
      inventory(server(11), starting),
      inventory(server(11), starting),
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.sleeps, [15_000]);
    assert.equal(result.pending, 0);
    assert.equal(result.outputs['in-flight-older'], starting.id);
    assert.match(result.log, new RegExp(`::warning::1 server\\(s\\) still start on an earlier release \\(${starting.id}\\)`));
  });

  it('does not wait with wait 0', async () => {
    const result = await act({ command: 'nodes', group: IDS.group, 'release-id': OTHER_RELEASE, wait: '0' }, [
      inventory(server(12, { phase: 'BOOTING' })),
    ]);
    assert.deepEqual(result.sleeps, []);
    assert.equal(result.outputs['in-flight-older'], server(12).id);
  });

  it('does not wait without a release', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [inventory(server(12, { phase: 'BOOTING' }))]);
    assert.deepEqual(result.sleeps, []);
    assert.equal(result.outputs['in-flight-older'], '');
  });

  it('checks the wait and the release id', async () => {
    assert.match((await act({ command: 'nodes', group: IDS.group, wait: '3601' })).log, /wait must be a whole number from 0 to 3600/);
    assert.match((await act({ command: 'nodes', group: IDS.group, 'release-id': 'rel_x' })).log, /release-id is not a release id/);
    assert.match((await act({ command: 'nodes', group: IDS.group, address: 'ipv6' })).log, /address must be ipv4 or private_ip/);
  });

  it('fails on a list without nodes', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [json(200, { group: {} })]);
    assert.match(result.log, /::error::The API answered a node list without nodes\./);
  });

  it('names the ability on 403', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [refusal(403, 'forbidden')]);
    assert.match(result.log, /Hint: the token lacks Read nodes \(nodes:read\), or its member may not operate the group/);
  });

  it('names a wrong group on 404', async () => {
    const result = await act({ command: 'nodes', group: IDS.group }, [refusal(404, 'not_found')]);
    assert.match(result.log, /Hint: no such group for this token/);
  });
});

describe('node', () => {
  const inputs = { command: 'node', group: IDS.group, 'node-id': server(14).id, 'release-id': IDS.release };

  for (const phase of ['BOOTING', 'DEPLOYING']) {
    it(`deploys a node in ${phase}, at the address from the inventory`, async () => {
      const result = await act(inputs, [inventory(server(11), server(14, { id: server(14).id.toUpperCase(), phase }))]);
      assert.equal(result.code, 0);
      assert.deepEqual(result.outputs, {
        deploy: 'true',
        address: '203.0.113.14',
        'release-ref': 'ghcr.io/acme/app:1.0.0',
        'build-id': '41',
        phase,
      });
    });
  }

  for (const [phase, annotation] of [
    ['HEALTH_CHECKING', 'notice'],
    ['ACTIVE', 'notice'],
    ['DEPLOY_FAILED', 'warning'],
    ['DRAINING', 'warning'],
  ]) {
    it(`deploys nothing to a node in ${phase}`, async () => {
      const result = await act(inputs, [inventory(server(14, { phase, private_ip: null }))]);
      assert.equal(result.code, 0);
      assert.equal(result.outputs.deploy, 'false');
      assert.equal(result.outputs.phase, phase);
      assert.match(result.log, new RegExp(`::${annotation}::Node ${server(14).id} is ${phase}`));
    });
  }

  it('gives no address it does not have to a node it will not deploy', async () => {
    const result = await act({ ...inputs, address: 'private_ip' }, [inventory(server(14, { phase: 'ACTIVE', private_ip: null }))]);
    assert.equal(result.outputs.address, '');
  });

  it('fails for a node without the address to deploy to', async () => {
    const result = await act(inputs, [inventory(server(14, { phase: 'DEPLOYING', ipv4: null }))]);
    assert.equal(result.code, 1);
    assert.match(result.log, /has no ipv4 address/);
  });

  it('fails for a node the group does not have', async () => {
    const result = await act(inputs, [inventory(server(11))]);
    assert.match(result.log, /is not a current node of group/);
  });

  it('fails for a dispatch that names another release', async () => {
    const other = await act({ ...inputs, 'release-id': OTHER_RELEASE }, [inventory(server(14, { phase: 'DEPLOYING' }))]);
    assert.match(other.log, new RegExp(`::error::The dispatch names release ${OTHER_RELEASE}, but node .* boots ${IDS.release}\\.`));
    const none = await act(inputs, [inventory(server(14, { phase: 'DEPLOYING', release: null }))]);
    assert.match(none.log, /boots no release\./);
  });

  it('gives an empty build id for a release without one', async () => {
    const result = await act(inputs, [inventory(server(14, { phase: 'DEPLOYING', release: { ...server(14).release, build_id: null } }))]);
    assert.equal(result.outputs['build-id'], '');
  });

  it('needs the node and the release', async () => {
    assert.match((await act({ ...inputs, 'node-id': '' })).log, /node needs the node-id input\./);
    assert.match((await act({ ...inputs, 'release-id': '' })).log, /node needs the release-id input\./);
  });
});

describe('deployed', () => {
  const inputs = (ids) => ({ command: 'deployed', 'release-id': OTHER_RELEASE, 'node-ids': ids });
  const done = (number) => json(200, { node: { id: server(number).id, phase: 'ACTIVE', generation: 3, release: OTHER_RELEASE, build_id: SHA } });

  it('reports each node once, each call with its own key', async () => {
    const ids = `${server(11).id}\n ${server(12).id.toUpperCase()}  ${server(11).id}\n`;
    const result = await act(inputs(ids), [done(11), done(12)]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.requests.map((request) => request.url), [
      `${API}/nodes/${server(11).id}/deployed`,
      `${API}/nodes/${server(12).id}/deployed`,
    ]);
    assert.deepEqual(result.body(0), { release: OTHER_RELEASE });
    assert.notEqual(result.requests[0].headers['Idempotency-Key'], result.requests[1].headers['Idempotency-Key']);
    assert.deepEqual(result.outputs, { reported: '2', skipped: '0' });
  });

  it('skips a node that left or is not managed', async () => {
    const result = await act(inputs(`${server(10).id} ${server(11).id} ${server(12).id}`), [
      refusal(409, 'node_not_managed'),
      refusal(409, 'node_not_active'),
      done(12),
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.outputs, { reported: '1', skipped: '2' });
    assert.match(result.log, new RegExp(`::warning::Node ${server(10).id} was not reported \\(node_not_managed\\)`));
    assert.match(result.log, /skipped 2/);
  });

  it('stops at the first other refusal', async () => {
    const result = await act(inputs(`${server(11).id} ${server(12).id} ${server(13).id}`), [done(11), refusal(422, 'release_unknown')]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 2);
    assert.deepEqual(result.outputs, { reported: '1', skipped: '0' });
    assert.match(result.log, new RegExp(`Stopped at node ${server(12).id}: 1 of 3 node\\(s\\) were not attempted\\.`));
  });

  it('reports nothing for no ids', async () => {
    const result = await act(inputs(''));
    assert.equal(result.code, 0);
    assert.deepEqual(result.outputs, { reported: '0', skipped: '0' });
  });

  it('checks every id before the first call', async () => {
    const result = await act(inputs(`${server(11).id} ../groups/x/rollout`));
    assert.equal(result.requests.length, 0);
    assert.match(result.log, /node-ids is not a node id/);
  });

  it('names a wrong node on 404', async () => {
    const result = await act(inputs(server(11).id), [refusal(404, 'not_found')]);
    assert.match(result.log, /Hint: no such node for this token/);
  });
});

describe('rollout', () => {
  const inputs = { command: 'rollout', group: IDS.group };

  it('starts a rollout with a key and no body', async () => {
    const rollout = { id: 'rol_01k7hsc0000000000000000001', started_at: 'now', release: OTHER_RELEASE, older: 3 };
    const result = await act(inputs, [json(201, { rollout })]);
    assert.equal(result.code, 0);
    assert.equal(result.requests[0].body, undefined);
    assert.match(result.requests[0].headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(result.outputs, { 'rollout-id': rollout.id, older: '3' });
  });

  it('succeeds when there is nothing to replace', async () => {
    const result = await act(inputs, [refusal(409, 'nothing_to_replace')]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.outputs, { 'rollout-id': '', older: '0' });
    assert.match(result.log, /::notice::Every server of group/);
  });

  it('warns when a rollout already runs', async () => {
    const result = await act(inputs, [refusal(409, 'already_running')]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.outputs, { 'rollout-id': '', older: '' });
    assert.match(result.log, /::warning::A rollout of group .* already runs/);
  });

  it('fails on a paused group and names the ability on 403', async () => {
    assert.equal((await act(inputs, [refusal(409, 'not_live')])).code, 1);
    assert.match((await act(inputs, [refusal(403, 'forbidden')])).log, /Replace older servers \(rollouts:write\)/);
  });
});

describe('ready', () => {
  const inputs = { command: 'ready', 'node-id': IDS.fresh, 'release-id': IDS.release, generation: '7' };

  it('reports the node ready, bound to its release and generation', async () => {
    const result = await act(inputs, [json(202, nodeState('HEALTH_CHECKING'))]);
    assert.equal(result.code, 0);
    assert.equal(result.requests[0].url, `${API}/nodes/${IDS.fresh}/ready`);
    assert.deepEqual(result.body(0), { release: IDS.release, generation: 7 });
    assert.equal(result.outputs.phase, 'HEALTH_CHECKING');
  });

  for (const phase of ['DEPLOYING', 'DRAINING', 'TERMINATED']) {
    it(`warns when a node in ${phase} no longer waits for the report`, async () => {
      const result = await act(inputs, [refusal(409, 'not_in_readiness', 'No.', nodeState(phase))]);
      assert.equal(result.code, 0);
      assert.equal(result.outputs.phase, phase);
      assert.match(result.log, /::warning::Node .* did not take the ready report/);
    });
  }

  it('fails when a failed node no longer waits for the report', async () => {
    const result = await act(inputs, [refusal(409, 'not_in_readiness', 'No.', nodeState('DEPLOY_FAILED'))]);
    assert.equal(result.code, 1);
    assert.match(result.log, new RegExp(`%0ANode ${IDS.fresh}: phase DEPLOY_FAILED, generation 7, release ${IDS.release}\\.`));
  });

  it('fails on another generation and shows the node as it stands', async () => {
    const result = await act(inputs, [refusal(409, 'stale_generation', 'Other generation.', nodeState('DEPLOYING', { release: null }))]);
    assert.equal(result.code, 1);
    assert.match(result.log, /stale_generation: Other generation\.%0ANode .*: phase DEPLOYING, generation 7, release none\./);
  });

  it('fails on a refusal without the node', async () => {
    const result = await act(inputs, [refusal(409, 'not_in_readiness')]);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.log, /%0ANode /);
  });

  it('checks the generation', async () => {
    assert.match((await act({ ...inputs, generation: '0' })).log, /generation must be a whole number from 1/);
    assert.match((await act({ ...inputs, generation: '' })).log, /ready needs the generation input\./);
  });
});

describe('failed', () => {
  const inputs = { command: 'failed', 'node-id': IDS.fresh, 'release-id': IDS.release, generation: '7' };

  it('reports the failure with a link to the run', async () => {
    const result = await act(inputs, [json(202, nodeState('DEPLOY_FAILED'))], { env: RUN_ENV });
    assert.equal(result.code, 0);
    assert.deepEqual(result.body(0), {
      release: IDS.release,
      generation: 7,
      reason: 'deploy failed in https://github.com/acme/app/actions/runs/99/attempts/2',
    });
    assert.equal(result.outputs.phase, 'DEPLOY_FAILED');
  });

  it('takes a reason of its own, up to 500 characters', async () => {
    const result = await act({ ...inputs, reason: 'compose exited 1' }, [json(202, nodeState('DEPLOY_FAILED'))]);
    assert.equal(result.body(0).reason, 'compose exited 1');
    assert.match((await act({ ...inputs, reason: 'x'.repeat(501) })).log, /reason is longer than 500 characters/);
  });

  it('gives a plain reason outside a workflow run, and the first attempt by default', async () => {
    assert.equal((await act(inputs, [json(202, nodeState('DEPLOY_FAILED'))])).body(0).reason, 'deploy failed');
    const env = { ...RUN_ENV, GITHUB_RUN_ATTEMPT: '' };
    assert.match((await act(inputs, [json(202, nodeState('DEPLOY_FAILED'))], { env })).body(0).reason, /attempts\/1$/);
  });

  it('fails on a node that no longer waits, showing its state', async () => {
    const result = await act(inputs, [refusal(409, 'not_in_readiness', 'No.', nodeState('ACTIVE'))]);
    assert.equal(result.code, 1);
    assert.match(result.log, /phase ACTIVE/);
  });
});
