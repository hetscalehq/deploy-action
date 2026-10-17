import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ActionError, createRunner, escapeData } from '../src/runner.js';
import { parseOutputs } from './helpers.js';

function runner(env = {}) {
  let printed = '';
  const out = createRunner({ env, write: (chunk) => (printed += chunk) });
  return { out, printed: () => printed };
}

describe('runner', () => {
  it('reads an input by its documented variable, trimmed', () => {
    const { out } = runner({ 'INPUT_RELEASE-ID': '  rel_x \n', INPUT_A_B: 'spaced' });
    assert.equal(out.input('release-id'), 'rel_x');
    assert.equal(out.input('a b'), 'spaced');
    assert.equal(out.input('missing'), '');
  });

  it('writes outputs with a random delimiter, so a value cannot end its own block', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'runner-')), 'output');
    const { out } = runner({ GITHUB_OUTPUT: file });
    out.output('hosts', '203.0.113.1\n203.0.113.2');
    out.output('trap', 'EOF\nghadelimiter_\nx=y');
    out.output('count', 2);
    const text = readFileSync(file, 'utf8');
    const delimiters = [...text.matchAll(/<<(ghadelimiter_[0-9a-f-]{36})/g)].map((match) => match[1]);
    assert.equal(new Set(delimiters).size, 3);
    assert.deepEqual(parseOutputs(file), { hosts: '203.0.113.1\n203.0.113.2', trap: 'EOF\nghadelimiter_\nx=y', count: '2' });
  });

  it('refuses to run without GITHUB_OUTPUT', () => {
    const { out } = runner({});
    assert.throws(() => out.output('x', 'y'), ActionError);
  });

  it('masks a value and each of its lines, and nothing for an empty one', () => {
    const { out, printed } = runner();
    out.mask('');
    out.mask('one');
    out.mask('a\nb');
    assert.equal(printed(), ['::add-mask::one', '::add-mask::a%0Ab', '::add-mask::a', '::add-mask::b', ''].join(EOL));
  });

  it('escapes annotations so server text cannot start a workflow command', () => {
    const { out, printed } = runner();
    out.error('bad\n::add-mask::x 100%\r');
    out.warning('w');
    out.notice('n');
    out.debug('d');
    out.info('plain');
    assert.equal(
      printed(),
      ['::error::bad%0A::add-mask::x 100%25%0D', '::warning::w', '::notice::n', '::debug::d', 'plain', ''].join(EOL),
    );
    assert.equal(escapeData(42), '42');
  });
});
