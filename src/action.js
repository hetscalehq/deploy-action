import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, refusal } from './api.js';
import { COMMANDS } from './commands.js';
import { ActionError, createRunner } from './runner.js';
import { DEFAULT_API_URL, apiUrl, token as checkToken } from './validate.js';

const NAMES = Object.keys(COMMANDS).join(', ');

// Secrets reach code from forks only through these triggers, so a deploy never runs under them.
function guardEvent(env) {
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new ActionError('Deploy workflows must not run on pull_request_target: it hands secrets to runs for pull requests from forks.');
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') return;
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    throw new ActionError('The workflow_run event could not be read to check which repository the triggering run came from.');
  }
  const head = event?.workflow_run?.head_repository?.id;
  if (head === undefined || head !== event?.repository?.id) {
    throw new ActionError('This workflow_run was triggered by a run from another repository, such as a pull request from a fork: deploy workflows must not run for it.');
  }
}

function userAgent(env) {
  const ref = env.GITHUB_ACTION_REF ?? '';
  return `hetscale-deploy-action/${/^[\x21-\x7E]{1,100}$/.test(ref) ? ref : 'local'}`;
}

export async function run({
  env = process.env,
  write = (chunk) => process.stdout.write(chunk),
  fetch = globalThis.fetch,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  now = Date.now,
  random = Math.random,
  signal = new AbortController().signal,
} = {}) {
  const out = createRunner({ env, write });
  const raw = out.input('token');
  out.mask(raw);
  if (raw.includes('|')) out.mask(raw.slice(raw.indexOf('|') + 1));

  try {
    guardEvent(env);
    const name = out.input('command');
    if (!Object.hasOwn(COMMANDS, name)) throw new ActionError(`command must be one of ${NAMES}.`);
    const token = checkToken(raw);
    const baseUrl = apiUrl(out.input('api-url') || DEFAULT_API_URL);
    if (baseUrl !== DEFAULT_API_URL) out.warning(`api-url points the action at ${baseUrl}, not at the Hetscale API.`);

    const pause = (ms) =>
      sleep(ms, signal).catch(() => {
        throw new ActionError('The run was cancelled.');
      });
    const api = createClient({ command: name, baseUrl, token, userAgent: userAgent(env), fetch, sleep: pause, now, random, signal, log: out });
    await COMMANDS[name]({
      command: name,
      input: out.input,
      env,
      out,
      api,
      now,
      sleep: pause,
      refusal: (answer, extra) => refusal(name, answer, extra),
    });
    return 0;
  } catch (error) {
    if (error instanceof ActionError) {
      out.error(error.message);
    } else {
      out.error(`The action failed unexpectedly: ${error?.message ?? error}`);
      out.debug(String(error?.stack ?? ''));
    }
    return 1;
  }
}
