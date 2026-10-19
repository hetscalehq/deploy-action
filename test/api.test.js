import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDS, TOKEN, act, json } from './helpers.js';

const lock = { command: 'lock', group: IDS.group };
const locked = () => json(200, { locked_until: '2026-10-17T12:30:00Z', reason: 'x' });
const status = (code, body = { message: 'Busy.', code: 'x' }, headers = {}) => () => json(code, body, headers);
const limited = (seconds) => status(429, { message: 'Slow down.', code: 'rate_limited' }, { 'Retry-After': String(seconds) });
const keys = (result) => result.requests.map((request) => request.headers['Idempotency-Key']);

describe('every request', () => {
  it('carries the token, JSON headers, the user agent and a fresh key', async () => {
    const result = await act(lock, [locked()], { env: { GITHUB_ACTION_REF: 'v1' } });
    const { headers, redirect, signal } = result.requests[0];
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['User-Agent'], 'hetscale-deploy-action/v1');
    assert.match(headers['Idempotency-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(redirect, 'manual');
    assert.ok(signal instanceof AbortSignal);
  });

  it('names no ref it cannot send in the user agent', async () => {
    const result = await act(lock, [locked()], { env: { GITHUB_ACTION_REF: 'bad ref' } });
    assert.equal(result.requests[0].headers['User-Agent'], 'hetscale-deploy-action/local');
  });
});

describe('retries', () => {
  it('waits Retry-After on 429 and resends the same key and body', async () => {
    const result = await act(lock, [status(429, { message: 'Slow down.', code: 'rate_limited' }, { 'Retry-After': '3' }), locked()]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.sleeps, [3000]);
    assert.equal(new Set(keys(result)).size, 1);
    assert.equal(result.requests[0].body, result.requests[1].body);
    assert.match(result.log, /POST \/groups\/.*\/lock was answered 429 rate_limited; trying again in 3\.0 s\./);
  });

  for (const [header, wait] of [
    ['500', 120_000],
    ['0', 1000],
    [undefined, 10_000],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 10_000],
  ]) {
    it(`waits ${wait} ms for Retry-After ${header} on 503`, async () => {
      const headers = header === undefined ? {} : { 'Retry-After': header };
      const result = await act(lock, [status(503, { message: 'Later.', code: 'provider_unavailable' }, headers), locked()]);
      assert.deepEqual(result.sleeps, [wait]);
    });
  }

  it('backs off with jitter on 5xx, timeouts and network errors', async () => {
    const timeout = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    const refused = () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    const odd = () => {
      throw new Error('socket hang up');
    };
    const result = await act(lock, [status(500), () => new Response('<html>', { status: 502 }), timeout, refused, odd, locked()]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.sleeps, [2000, 5000, 10_000, 20_000, 20_000]);
    assert.equal(new Set(keys(result)).size, 1);
    assert.match(result.log, /timed out; trying again/);
    assert.match(result.log, /could not reach the API \(ECONNREFUSED\); trying again/);
    assert.match(result.log, /could not reach the API; trying again/);
  });

  it('retries a request whose key is still in flight', async () => {
    const result = await act(lock, [status(409, { message: 'Running.', code: 'idempotency_key_in_flight' }), locked()]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.sleeps, [2000]);
    assert.equal(new Set(keys(result)).size, 1);
  });

  it('gives up after six attempts', async () => {
    const result = await act(lock, Array.from({ length: 6 }, () => status(500)));
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 6);
    assert.match(result.log, /::error::POST \/groups\/.*\/lock was answered 500 x; gave up after 6 attempts\./);
  });

  it('gives up when the next wait would pass five minutes', async () => {
    const result = await act(lock, [limited(120), limited(120), limited(120)]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.sleeps, [120_000, 120_000]);
    assert.match(result.log, /gave up after 3 attempts\.%0AHint: the organisation's rate limit/);
  });

  it('gives the last attempt only the time left in five minutes', async (t) => {
    // The fake clock moves only with sleeps, so a fetch that hangs lasts as long as the timeout it
    // was given: the timeouts are recorded, and the hanging fetch fails at once as one that timed out.
    const timeout = t.mock.method(AbortSignal, 'timeout');
    const hang = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    const result = await act(lock, [limited(120), limited(120), limited(59), hang]);
    const timeouts = timeout.mock.calls.map((call) => call.arguments[0]);
    const ended = result.sleeps.reduce((sum, ms) => sum + ms, 0) + timeouts.at(-1);
    assert.ok(ended <= 300_000, `the call ended after ${ended} ms`);
    assert.deepEqual(result.sleeps, [120_000, 120_000, 59_000]);
    assert.deepEqual(timeouts, [30_000, 30_000, 30_000, 1000]);
    assert.equal(result.code, 1);
    assert.match(result.log, /::error::POST \/groups\/.*\/lock timed out; gave up after 4 attempts\./);
  });

  it('starts no attempt with less than a second left', async () => {
    const result = await act(lock, [limited(120), limited(120), limited(60)]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.sleeps, [120_000, 120_000]);
    assert.match(result.log, /::error::POST \/groups\/.*\/lock was answered 429 rate_limited; gave up after 3 attempts\./);
  });

  it('starts no attempt with less than a second left after a sleep that ends late', async () => {
    const result = await act(lock, [limited(120), limited(120), limited(58)], { late: 500 });
    assert.equal(result.code, 1);
    assert.deepEqual(result.sleeps, [120_000, 120_000, 58_000]);
    assert.match(result.log, /::error::POST \/groups\/.*\/lock was answered 429 rate_limited; gave up after 3 attempts\./);
  });

  it('never retries provider_error', async () => {
    const result = await act({ command: 'release', group: IDS.group, ref: '123' }, [
      status(502, { message: 'Hetzner refused.', code: 'provider_error' }),
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.log, /Hint: Hetzner refused the group's project token/);
  });

  it('does not retry other client errors', async () => {
    const result = await act(lock, [() => new Response('Bad Request', { status: 400 })]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.log, /::error::Hetscale answered 400(\r?\n|$)/m);
  });
});

describe('answers', () => {
  it('refuses to follow a redirect', async () => {
    const result = await act(lock, [() => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/' } })]);
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.log, /was answered with a redirect \(307\), which the action does not follow/);
  });

  it('fails on a success without a JSON object', async () => {
    for (const body of ['ok', '[]', 'null', '']) {
      const result = await act(lock, [() => new Response(body, { status: 200 })]);
      assert.equal(result.code, 1);
      assert.match(result.log, /was answered 200 without a JSON body/);
    }
  });

  it('logs a replayed answer for step debugging', async () => {
    const result = await act(lock, [json(200, { locked_until: 'later', reason: 'x' }, { 'Idempotent-Replayed': 'true' })]);
    assert.match(result.log, /::debug::POST \/groups\/.*\/lock: 200, replayed/);
  });
});

describe('cancellation', () => {
  it('stops the call in flight', async () => {
    const controller = new AbortController();
    const result = await act(lock, [
      () => {
        controller.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    ], { signal: controller.signal });
    assert.equal(result.code, 1);
    assert.equal(result.requests.length, 1);
    assert.match(result.log, /::error::The run was cancelled\./);
  });
});
