# Contributing

Thanks for looking into the action. Bug reports and pull requests are welcome; for a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## What the code is

- One JavaScript action that runs on the `node24` runtime: `action.yml` points at `src/main.js`.
- Plain ES modules that import only Node built-ins (`node:*`). There are no dependencies, no lockfile, no TypeScript, no bundler and no build step: the commit a workflow pins is the code it runs. Please keep it that way; a pull request that adds a dependency will not be merged.
- Every command is one documented call of the [Hetscale API](https://hetscale.com/docs/api). The action reads only the operations, fields and error codes the API reference documents, and fails with the status, code and message on anything else.

| File | Holds |
|---|---|
| `src/main.js` | The entry point: cancellation and the exit code |
| `src/action.js` | Trigger checks, the token, the base URL, and the command dispatch |
| `src/commands.js` | The nine commands |
| `src/api.js` | Requests, idempotency keys, retries and error messages |
| `src/hints.js` | What to do about a refusal |
| `src/validate.js` | Input checks: the token's shape, ids, numbers, addresses, the base URL |
| `src/runner.js` | GitHub's workflow commands: inputs, outputs, masks and annotations |
| `test/stub-server.mjs` | A loopback stub of the eight API operations, for the tests and the CI self-test |

## Running the tests

You need Node.js 24 (see `.node-version`) and nothing else:

```bash
npm test
```

It runs `node:test` with coverage and fails below 90% of lines, branches or functions in `src/`. No test reaches the network: tests inject a fake `fetch`, and the end-to-end tests talk to the stub on `127.0.0.1`.

CI runs the same tests, a self-test that runs the action through `action.yml` on Ubuntu and Windows against the stub, and a check of the pull request title.

## Pull requests

- One change per pull request, with a test for every new behaviour.
- The title is a [Conventional Commits](https://www.conventionalcommits.org/) subject of at most 72 characters, such as `fix(api): retry a 409 while the key is in flight`: pull requests are squash-merged, and the title becomes the commit on `main`. No trailers.
- The description says what changes, why, and how you tested it.
- Everything is in English: code, comments, messages, docs.
- The repository is public. Describe behaviour in terms of the public API reference, and never paste tokens, real server addresses or anything else from a private system into an issue, a test or a fixture. Fixtures use made-up lower-case ids and documentation addresses (`203.0.113.0/24`, `10.0.0.0/8`).
- The CI workflows use only GitHub's own actions, pinned by full commit SHA with the version in a comment.

## Releases

Maintainers publish releases by hand from a green `main`; no workflow can write to the repository.

- Versions follow [semver](https://semver.org/). A fix is a patch. A new command, input or output is a minor version. A removed or renamed command, input or output, a changed default, or a new Node runtime is a major version.
- Each `vX.Y.Z` is an immutable GitHub release. The plain tag `vN` (such as `v1`) is then moved to it, so `@v1` follows the latest `v1.x.y`.
- The release notes are the changelog. A runtime change names the minimum runner version.
