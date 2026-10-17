import { ActionError } from './runner.js';
import { address, host, id, integer, text } from './validate.js';

// Phases of a server on its way to serving, and of a server on its way out.
const STARTING = new Set(['REQUESTED', 'PROVISIONING', 'BOOTING', 'DEPLOYING', 'HEALTH_CHECKING']);
const LEAVING = new Set(['DRAINING', 'TERMINATING', 'TERMINATED']);
const POLL_MS = 15_000;

function need(ctx, name) {
  const value = ctx.input(name);
  if (value === '') throw new ActionError(`${ctx.command} needs the ${name} input.`);
  return value;
}

const groupOf = (ctx) => id('group', 'group', need(ctx, 'group'));
const nodeOf = (ctx) => id('node', 'node-id', need(ctx, 'node-id'));
const releaseOf = (ctx) => id('release', 'release-id', need(ctx, 'release-id'));
const generationOf = (ctx) => integer('generation', need(ctx, 'generation'), 1, Number.MAX_SAFE_INTEGER);
const cut = (value, max) => [...value].slice(0, max).join('');

function expect(ctx, answer, ...statuses) {
  if (!statuses.includes(answer.status)) throw ctx.refusal(answer);
  return answer.json;
}

function lockReason(env) {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_WORKFLOW: workflow, GITHUB_RUN_ID: run } = env;
  if (!repo || !sha || !workflow || !run) return 'deploy from GitHub Actions';
  return cut(`${repo}@${sha.slice(0, 7)}: ${workflow} run ${run}`, 200);
}

function failReason(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (!server || !repo || !run) return 'deploy failed';
  return cut(`deploy failed in ${server}/${repo}/actions/runs/${run}/attempts/${attempt || 1}`, 500);
}

function missingAddress(nodeId, field) {
  const other = field === 'ipv4' ? 'private_ip' : 'ipv4';
  return `Node ${nodeId} has no ${field} address. Set address to ${other} if the runner reaches the servers that way.`;
}

function describe(state) {
  if (state === null || typeof state !== 'object') return '';
  return `\nNode ${state.id}: phase ${state.phase}, generation ${state.generation}, release ${state.release ?? 'none'}.`;
}

async function inventory(ctx, group) {
  const body = expect(ctx, await ctx.api('GET', `/groups/${group}/nodes`), 200);
  if (!Array.isArray(body.nodes)) throw new ActionError('The API answered a node list without nodes.');
  return body.nodes;
}

// Servers that started before the release was recorded boot the earlier one.
const startingOlder = (list, release) =>
  list.filter((server) => STARTING.has(server.phase) && server.release?.id?.toLowerCase() !== release).map((server) => server.id);

async function lock(ctx) {
  const group = groupOf(ctx);
  const ttl = integer('ttl', need(ctx, 'ttl'), 60, 7200);
  const reason = ctx.input('reason') ? text('reason', ctx.input('reason'), 200) : lockReason(ctx.env);
  const body = expect(ctx, await ctx.api('POST', `/groups/${group}/lock`, { ttl, reason }), 200);
  ctx.out.output('locked-until', body.locked_until);
  ctx.out.info(`Group ${group} is locked until ${body.locked_until}.`);
}

async function unlock(ctx) {
  const group = groupOf(ctx);
  expect(ctx, await ctx.api('DELETE', `/groups/${group}/lock`), 200);
  ctx.out.info(`Group ${group} holds no deploy lock now.`);
}

async function release(ctx) {
  const group = groupOf(ctx);
  const ref = need(ctx, 'ref');
  const buildId = ctx.input('build-id');
  const answer = await ctx.api('POST', `/groups/${group}/releases`, buildId ? { ref, build_id: buildId } : { ref });
  const body = expect(ctx, answer, 201, 200);
  const version = body.release.version ?? '';
  ctx.out.output('release-id', body.release.id);
  ctx.out.output('release-version', version);
  ctx.out.output('generation', body.group.generation);
  ctx.out.output('created', answer.status === 201);
  if (answer.status === 200) {
    ctx.out.notice(`Release ${body.release.id} already is the current release of group ${group}: nothing changed.`);
  } else {
    ctx.out.info(`Recorded release ${body.release.id}${version === '' ? '' : ` (v${version})`} as current; generation ${body.group.generation}.`);
  }
}

async function nodes(ctx) {
  const group = groupOf(ctx);
  const field = address(ctx.input('address'));
  const current = ctx.input('release-id') ? id('release', 'release-id', ctx.input('release-id')) : undefined;
  const wait = integer('wait', need(ctx, 'wait'), 0, 3600) * 1000;
  const started = ctx.now();

  let list = await inventory(ctx, group);
  let older = current ? startingOlder(list, current) : [];
  while (older.length > 0 && ctx.now() - started + POLL_MS <= wait) {
    ctx.out.info(`Waiting for ${older.length} server(s) that started on an earlier release.`);
    await ctx.sleep(POLL_MS);
    list = await inventory(ctx, group);
    older = startingOlder(list, current);
  }
  if (older.length > 0) {
    ctx.out.warning(
      `${older.length} server(s) still start on an earlier release (${older.join(', ')}): ` +
        'they are not in hosts and stay older until a rollout or the next deploy.',
    );
  }

  const serving = list.filter((server) => server.phase === 'ACTIVE');
  const hosts = serving.map((server) => {
    const value = host(server[field]);
    if (!value) throw new ActionError(missingAddress(server.id, field));
    return value;
  });
  const adopted = hosts.filter((_, index) => serving[index].class === 'adopted');
  const managed = serving.filter((server) => server.class === 'managed').map((server) => server.id);

  ctx.out.output('hosts', hosts.join('\n'));
  ctx.out.output('adopted-hosts', adopted.join('\n'));
  ctx.out.output('managed-node-ids', managed.join('\n'));
  ctx.out.output('count', serving.length);
  ctx.out.output('nodes', JSON.stringify(serving));
  ctx.out.output('in-flight-older', older.join('\n'));
  if (serving.length === 0) {
    ctx.out.notice(`Group ${group} has no serving servers: hosts is empty.`);
  } else {
    ctx.out.info(`Group ${group} has ${serving.length} serving server(s): ${managed.length} managed, ${adopted.length} adopted.`);
  }
}

async function node(ctx) {
  const group = groupOf(ctx);
  const nodeId = nodeOf(ctx);
  const wanted = releaseOf(ctx);
  const field = address(ctx.input('address'));

  const found = (await inventory(ctx, group)).find((server) => String(server.id).toLowerCase() === nodeId);
  if (!found) {
    throw new ActionError(`Node ${nodeId} is not a current node of group ${group}: it terminated, belongs to another group, or the id is wrong.`);
  }
  const boots = found.release?.id?.toLowerCase();
  if (boots !== wanted) {
    throw new ActionError(`The dispatch names release ${wanted}, but node ${nodeId} boots ${boots ?? 'no release'}.`);
  }
  // A webhook node waits for its pipeline in BOOTING and DEPLOYING; from HEALTH_CHECKING on, its
  // ready report was taken and it is a load balancer target, so a repeated dispatch deploys nothing.
  const deploy = found.phase === 'BOOTING' || found.phase === 'DEPLOYING';
  const value = host(found[field]);
  if (deploy && !value) throw new ActionError(missingAddress(nodeId, field));

  ctx.out.output('deploy', deploy);
  ctx.out.output('address', value ?? '');
  ctx.out.output('release-ref', found.release.ref);
  ctx.out.output('build-id', found.release.build_id ?? '');
  ctx.out.output('phase', found.phase);
  if (deploy) {
    ctx.out.info(`Node ${nodeId} waits for its deploy (${found.phase}).`);
  } else if (found.phase === 'HEALTH_CHECKING' || found.phase === 'ACTIVE') {
    ctx.out.notice(`Node ${nodeId} is ${found.phase}: its deploy was reported already, so there is nothing to deploy.`);
  } else {
    ctx.out.warning(`Node ${nodeId} is ${found.phase}: it does not wait for a deploy.`);
  }
}

async function deployed(ctx) {
  const wanted = releaseOf(ctx);
  const ids = [...new Set(ctx.input('node-ids').split(/\s+/).filter(Boolean).map((value) => id('node', 'node-ids', value)))];
  let reported = 0;
  let skipped = 0;
  const finish = () => {
    ctx.out.output('reported', reported);
    ctx.out.output('skipped', skipped);
  };

  for (const [index, nodeId] of ids.entries()) {
    const answer = await ctx.api('POST', `/nodes/${nodeId}/deployed`, { release: wanted });
    if (answer.status === 200) {
      reported += 1;
    } else if (answer.status === 409 && (answer.code === 'node_not_active' || answer.code === 'node_not_managed')) {
      skipped += 1;
      ctx.out.warning(`Node ${nodeId} was not reported (${answer.code}): it left or failed meanwhile, or Hetscale does not manage it.`);
    } else {
      // Every other refusal applies to the remaining nodes too, and each call spends the shared rate limit.
      finish();
      throw ctx.refusal(answer, `\nStopped at node ${nodeId}: ${ids.length - index - 1} of ${ids.length} node(s) were not attempted.`);
    }
  }
  finish();
  ctx.out.info(`Reported ${reported} node(s) deployed with release ${wanted}${skipped ? `; skipped ${skipped}` : ''}.`);
}

async function rollout(ctx) {
  const group = groupOf(ctx);
  const answer = await ctx.api('POST', `/groups/${group}/rollout`);
  if (answer.status === 201) {
    const { id: rolloutId, older } = answer.json.rollout;
    ctx.out.output('rollout-id', rolloutId);
    ctx.out.output('older', older);
    ctx.out.info(`Rollout ${rolloutId} started: ${older} older server(s) to replace.`);
  } else if (answer.status === 409 && answer.code === 'nothing_to_replace') {
    ctx.out.output('rollout-id', '');
    ctx.out.output('older', 0);
    ctx.out.notice(`Every server of group ${group} runs the current release and template: nothing to replace.`);
  } else if (answer.status === 409 && answer.code === 'already_running') {
    ctx.out.output('rollout-id', '');
    ctx.out.output('older', '');
    ctx.out.warning(`A rollout of group ${group} already runs: no second one was started.`);
  } else {
    throw ctx.refusal(answer);
  }
}

function reported(ctx, nodeId, kind, state) {
  ctx.out.output('phase', state.phase);
  ctx.out.info(`Node ${nodeId} reported ${kind}; it is ${state.phase}.`);
}

async function ready(ctx) {
  const nodeId = nodeOf(ctx);
  const body = { release: releaseOf(ctx), generation: generationOf(ctx) };
  const answer = await ctx.api('POST', `/nodes/${nodeId}/ready`, body);
  const state = answer.json?.node;
  if (answer.status === 202) return reported(ctx, nodeId, 'ready', state);
  // A node still starting or already leaving was cancelled during its deploy; a failed one is a failure.
  if (answer.status === 409 && answer.code === 'not_in_readiness' && (STARTING.has(state?.phase) || LEAVING.has(state?.phase))) {
    ctx.out.output('phase', state.phase);
    ctx.out.warning(`Node ${nodeId} did not take the ready report: it is ${state.phase}, so its deploy was cancelled. Nothing changed.`);
    return undefined;
  }
  throw ctx.refusal(answer, describe(state));
}

async function failed(ctx) {
  const nodeId = nodeOf(ctx);
  const body = {
    release: releaseOf(ctx),
    generation: generationOf(ctx),
    reason: ctx.input('reason') ? text('reason', ctx.input('reason'), 500) : failReason(ctx.env),
  };
  const answer = await ctx.api('POST', `/nodes/${nodeId}/failed`, body);
  if (answer.status === 202) return reported(ctx, nodeId, 'failed', answer.json.node);
  throw ctx.refusal(answer, describe(answer.json?.node));
}

export const COMMANDS = { lock, unlock, release, nodes, node, deployed, rollout, ready, failed };
