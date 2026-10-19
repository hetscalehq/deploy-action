import { randomUUID } from 'node:crypto';
import { hint } from './hints.js';
import { ActionError } from './runner.js';

const TIMEOUT_MS = 30_000;
const ATTEMPTS = 6;
const BUDGET_MS = 300_000;
const MIN_ATTEMPT_MS = 1000;
const BACKOFF_S = [2, 5, 10, 20, 20];

async function read(response) {
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  const object = json !== null && typeof json === 'object' && !Array.isArray(json) ? json : undefined;
  return {
    status: response.status,
    json: object,
    code: typeof object?.code === 'string' ? object.code : undefined,
    message: typeof object?.message === 'string' ? object.message : undefined,
    retryAfter: response.headers.get('retry-after'),
    replayed: response.headers.get('idempotent-replayed') === 'true',
  };
}

const label = (answer) => `${answer.status}${answer.code ? ` ${answer.code}` : ''}`;

export function refusal(command, answer, extra = '') {
  const lines = [`Hetscale answered ${label(answer)}${answer.message ? `: ${answer.message}` : ''}`];
  const errors = answer.json?.errors;
  if (errors !== null && typeof errors === 'object') {
    for (const [field, messages] of Object.entries(errors)) lines.push(`${field}: ${[messages].flat().join(' ')}`);
  }
  const help = hint(command, answer.status, answer.code);
  if (help) lines.push(`Hint: ${help}.`);
  return new ActionError(lines.join('\n') + extra);
}

// One call of the API: a POST carries an Idempotency-Key made once and resent only on its own
// retries, so a retry after a lost answer gets the first answer back instead of a second effect.
export function createClient({ command, baseUrl, token, userAgent, fetch, sleep, now, random, signal, log }) {
  const backoff = (attempt) => BACKOFF_S[attempt - 1] * (0.8 + 0.4 * random());
  const retryAfter = (value) => (/^[0-9]+$/.test(value ?? '') ? Math.min(Math.max(Number(value), 1), 120) : 10);

  function delayFor(answer, attempt) {
    if (answer.status === 429 || answer.status === 503) return retryAfter(answer.retryAfter);
    if (answer.status === 409 && answer.code === 'idempotency_key_in_flight') return backoff(attempt);
    if (answer.status === 502 && answer.code === 'provider_error') return undefined;
    return answer.status >= 500 ? backoff(attempt) : undefined;
  }

  return async function call(method, path, body) {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': userAgent };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = randomUUID();
    const started = now();
    const left = () => BUDGET_MS - (now() - started);

    // Each attempt gets at most the time left in the budget, and none starts with less than a second.
    for (let attempt = 1; ; attempt += 1) {
      let answer;
      let failure;
      let wait;
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(TIMEOUT_MS, left()))]),
        });
        answer = await read(response);
      } catch (error) {
        if (signal.aborted) throw new ActionError('The run was cancelled.');
        const cause = typeof error?.cause?.code === 'string' ? ` (${error.cause.code})` : '';
        failure = error?.name === 'TimeoutError' ? 'timed out' : `could not reach the API${cause}`;
        wait = backoff(attempt);
      }

      if (answer) {
        log.debug(`${method} ${path}: ${label(answer)}${answer.replayed ? ', replayed' : ''}`);
        if (answer.status >= 300 && answer.status < 400) {
          throw new ActionError(`${method} ${path} was answered with a redirect (${answer.status}), which the action does not follow.`);
        }
        wait = delayFor(answer, attempt);
        if (wait === undefined) {
          if (answer.status < 300 && answer.json === undefined) {
            throw new ActionError(`${method} ${path} was answered ${answer.status} without a JSON body.`);
          }
          return answer;
        }
        failure = `was answered ${label(answer)}`;
      }

      if (attempt < ATTEMPTS && left() - wait * 1000 >= MIN_ATTEMPT_MS) {
        log.info(`${method} ${path} ${failure}; trying again in ${wait.toFixed(1)} s.`);
        await sleep(wait * 1000);
        // A sleep can end late, so the time left is checked again as the attempt starts.
        if (left() >= MIN_ATTEMPT_MS) continue;
      }
      const help = answer && hint(command, answer.status, answer.code);
      throw new ActionError(`${method} ${path} ${failure}; gave up after ${attempt} attempts.${help ? `\nHint: ${help}.` : ''}`);
    }
  };
}
