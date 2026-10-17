import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../src/runner.js';
import { DEFAULT_API_URL, address, apiUrl, host, id, integer, text, token } from '../src/validate.js';

const fails = (fn, pattern) => assert.throws(fn, (error) => error instanceof ActionError && pattern.test(error.message));

describe('token', () => {
  it('takes <id>|<secret> in visible ASCII', () => {
    assert.equal(token('12|hetscale_abc-DEF.~'), '12|hetscale_abc-DEF.~');
  });

  it('names the usual reasons for an empty token', () => {
    fails(() => token(''), /fork.*Dependabot/);
  });

  for (const value of ['abc', '12|', '|secret', 'x1|secret', '12|sec ret', '12|secret\nInjected: 1', '12|sécret']) {
    it(`refuses ${JSON.stringify(value)} without echoing it`, () => {
      assert.throws(() => token(value), (error) => error instanceof ActionError && !error.message.includes(value));
    });
  }
});

describe('id', () => {
  const ulid = '01k7hsc00000000000000000ab';

  it('takes each prefix in either case and returns it in lower case', () => {
    assert.equal(id('group', 'group', `grp_${ulid}`), `grp_${ulid}`);
    assert.equal(id('node', 'node-id', `NODE_${ulid.toUpperCase()}`), `node_${ulid}`);
    assert.equal(id('release', 'release-id', `rel_${ulid}`), `rel_${ulid}`);
  });

  for (const value of [
    '',
    `grp_${ulid}`.slice(0, -1),
    `grp_${ulid}x`,
    `grp_8${ulid.slice(1)}`,
    `grp_${ulid.slice(0, -1)}i`,
    `grp_${ulid.slice(0, -1)}u`,
    `node_${ulid}`,
    '../groups/x/rollout',
    `grp_${ulid}/../../nodes`,
    `grp_${ulid}?phase=active`,
  ]) {
    it(`refuses ${JSON.stringify(value)} as a group id`, () => {
      fails(() => id('group', 'group', value), /^group is not a group id/);
    });
  }
});

describe('integer', () => {
  it('takes whole numbers in range', () => {
    assert.equal(integer('ttl', '60', 60, 7200), 60);
    assert.equal(integer('ttl', '7200', 60, 7200), 7200);
  });

  for (const value of ['59', '7201', '-1', '1.5', '1e3', ' 600', '0x10', '', '1234567890123456']) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      fails(() => integer('ttl', value, 60, 7200), /^ttl must be a whole number from 60 to 7200/);
    });
  }
});

describe('text, address and host', () => {
  it('counts characters, not bytes', () => {
    assert.equal(text('reason', 'é'.repeat(200), 200), 'é'.repeat(200));
    fails(() => text('reason', 'x'.repeat(201), 200), /longer than 200/);
  });

  it('takes ipv4 or private_ip only', () => {
    assert.equal(address('ipv4'), 'ipv4');
    assert.equal(address('private_ip'), 'private_ip');
    fails(() => address('ipv6'), /ipv4 or private_ip/);
  });

  it('gives a host only for an IPv4 address', () => {
    assert.equal(host('10.0.0.1'), '10.0.0.1');
    assert.equal(host('2001:db8::/64'), undefined);
    assert.equal(host('example.com'), undefined);
    assert.equal(host(null), undefined);
  });
});

describe('apiUrl', () => {
  it('takes https and loopback http, without a trailing slash', () => {
    assert.equal(apiUrl(DEFAULT_API_URL), DEFAULT_API_URL);
    assert.equal(apiUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(apiUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
    assert.equal(apiUrl('http://localhost:1/v1'), 'http://localhost:1/v1');
    assert.equal(apiUrl('http://[::1]:1/v1'), 'http://[::1]:1/v1');
  });

  it('refuses what is not a URL', () => fails(() => apiUrl('api.hetscale.com'), /not a URL/));

  for (const value of ['http://api.hetscale.com/v1', 'http://127.0.0.2/v1', 'ftp://127.0.0.1/v1', 'file:///etc/passwd']) {
    it(`refuses ${value}`, () => fails(() => apiUrl(value), /must be an https URL/));
  }

  for (const value of ['https://user:pass@api.hetscale.com/v1', 'https://api.hetscale.com/v1?x=1', 'https://api.hetscale.com/v1#x']) {
    it(`refuses ${value}`, () => fails(() => apiUrl(value), /credentials, a query or a fragment/));
  }
});
