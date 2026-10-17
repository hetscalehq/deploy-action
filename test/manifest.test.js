import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ROOT, declaredDefaults } from './helpers.js';

const manifest = readFileSync(new URL('action.yml', ROOT), 'utf8');
const sources = readdirSync(new URL('src/', ROOT)).map((name) => readFileSync(new URL(`src/${name}`, ROOT), 'utf8'));
const code = sources.join('\n');

function declared(section) {
  const start = manifest.indexOf(`\n${section}:`);
  const end = manifest.indexOf('\n\n', start + 1);
  return new Set([...manifest.slice(start, end).matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]));
}

const used = (pattern) => new Set([...code.matchAll(pattern)].map((match) => match[1]));

describe('action.yml', () => {
  it('runs src/main.js on node24, with no pre or post step', () => {
    assert.match(manifest, /\nruns:\n {2}using: node24\n {2}main: src\/main\.js\n$/);
    assert.doesNotMatch(manifest, /^ {2}(pre|post)(-if)?:/m);
  });

  it('declares every input the code reads, and reads every input it declares', () => {
    const read = used(/(?:input|need\(ctx,)\s*\(?'([a-z-]+)'/g);
    assert.deepEqual([...declared('inputs')].sort(), [...read].sort());
  });

  it('declares every output the code writes, and writes every output it declares', () => {
    assert.deepEqual([...declared('outputs')].sort(), [...used(/output\('([a-z-]+)'/g)].sort());
  });

  it('defaults to the Hetscale API and to the documented values', () => {
    assert.deepEqual(declaredDefaults(), {
      ttl: '1800',
      'build-id': '${{ github.sha }}',
      address: 'ipv4',
      wait: '600',
      'api-url': 'https://api.hetscale.com/v1',
    });
  });

  it('has a description that fits a Marketplace listing', () => {
    const description = manifest.match(/^description: (.*)$/m)[1];
    assert.ok(description.length <= 125, `${description.length} characters`);
  });
});

describe('the source', () => {
  it('imports only Node built-ins and its own modules', () => {
    for (const [, specifier] of code.matchAll(/^import .* from '([^']+)';$/gm)) {
      assert.match(specifier, /^(node:|\.\/[a-z]+\.js$)/, specifier);
    }
    assert.doesNotMatch(code, /\brequire\(|\bimport\(/);
  });

  it('spawns no process and reads no proxy setting of its own', () => {
    assert.doesNotMatch(code, /child_process|\bexec\(|\bspawn\(|HTTPS?_PROXY/);
  });

  it('has no dependencies and no lockfile', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.equal(pkg.type, 'module');
    assert.ok(!existsSync(new URL('package-lock.json', ROOT)));
    assert.equal(readFileSync(new URL('.node-version', ROOT), 'utf8').trim(), manifest.match(/using: node(\d+)/)[1]);
  });
});
