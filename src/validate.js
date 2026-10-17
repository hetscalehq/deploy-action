import { isIPv4 } from 'node:net';
import { ActionError } from './runner.js';

export const DEFAULT_API_URL = 'https://api.hetscale.com/v1';

const PREFIXES = { group: 'grp', node: 'node', release: 'rel' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function token(value) {
  if (value === '') {
    throw new ActionError(
      'token is empty: the secret is not set, or this run gets no secrets ' +
        '(a pull request from a fork, or a Dependabot run).',
    );
  }
  if (!/^[0-9]+\|[\x21-\x7E]+$/.test(value)) {
    throw new ActionError('token is not a Hetscale API token of the form <id>|<secret>.');
  }
  return value;
}

// An id enters a URL path only in its documented form: a prefix and a ULID, read in either case.
export function id(kind, input, value) {
  const prefix = PREFIXES[kind];
  if (!new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`, 'i').test(value)) {
    throw new ActionError(`${input} is not a ${kind} id: ${prefix}_ followed by a ULID of 26 characters.`);
  }
  return value.toLowerCase();
}

export function integer(input, value, min, max) {
  const number = /^[0-9]{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!(number >= min && number <= max)) {
    throw new ActionError(`${input} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

export function text(input, value, max) {
  if ([...value].length > max) {
    throw new ActionError(`${input} is longer than ${max} characters.`);
  }
  return value;
}

export function address(value) {
  if (value !== 'ipv4' && value !== 'private_ip') {
    throw new ActionError('address must be ipv4 or private_ip.');
  }
  return value;
}

export function host(value) {
  return typeof value === 'string' && isIPv4(value) ? value : undefined;
}

export function apiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ActionError('api-url is not a URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new ActionError('api-url must be an https URL; plain http is taken only on a loopback address.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ActionError('api-url must not carry credentials, a query or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}
