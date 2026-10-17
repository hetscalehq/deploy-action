import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';

// GitHub's documented workflow commands and environment files, in place of a toolkit dependency.

export class ActionError extends Error {}

export function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function createRunner({ env, write }) {
  const command = (name, message) => write(`::${name}::${escapeData(message)}${EOL}`);

  return {
    input: (name) => (env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim(),

    output(name, value) {
      if (!env.GITHUB_OUTPUT) {
        throw new ActionError('GITHUB_OUTPUT is not set: run the action as a step of a GitHub Actions job.');
      }
      const delimiter = `ghadelimiter_${randomUUID()}`;
      appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
    },

    mask(value) {
      for (const part of new Set([value, ...value.split(/\r?\n/)])) {
        if (part.trim() !== '') command('add-mask', part);
      }
    },

    info: (message) => write(`${message}${EOL}`),
    debug: (message) => command('debug', message),
    notice: (message) => command('notice', message),
    warning: (message) => command('warning', message),
    error: (message) => command('error', message),
  };
}
