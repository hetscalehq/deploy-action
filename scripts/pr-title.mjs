// Checks that a pull request title is a Conventional Commits subject: the squash merge makes it the
// commit on main. The title comes from PR_TITLE and is never printed, since anyone can write it.
const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const MAX = 72;

const title = process.env.PR_TITLE ?? '';
const problems = [];
if (!new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`).test(title)) {
  problems.push(`start with a type (${TYPES.join(', ')}), an optional (scope) in lower case, and ": "`);
}
if (title.length > MAX) problems.push(`stay within ${MAX} characters`);
if (/\.\s*$/.test(title)) problems.push('not end with a period');

if (problems.length > 0) {
  console.log(`::error::The pull request title must ${problems.join(', ')}.`);
  process.exit(1);
}
console.log('The pull request title is a Conventional Commits subject.');
