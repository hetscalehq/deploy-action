# Hetscale Deploy

A GitHub Action for [Hetscale](https://hetscale.com) node groups. It takes a group's deploy lock, records the release your pipeline built, lists the servers to deploy to, and reports each deploy back, so a workflow needs no curl, jq or bash of its own for the [Hetscale API](https://hetscale.com/docs/api).

Use it as `hetscalehq/deploy-action@v1`, one step per call. The workflows below do what the [GitHub Actions recipes](https://hetscale.com/docs/github-actions) do with curl and jq.

- [Commands](#commands)
- [Deploy a release to the running servers](#deploy-a-release-to-the-running-servers)
- [Let Hetscale replace the servers instead](#let-hetscale-replace-the-servers-instead)
- [Deploy each new server](#deploy-each-new-server)
- [Keeping deploys apart](#keeping-deploys-apart)
- [Inputs](#inputs) and [outputs](#outputs)
- [Errors and retries](#errors-and-retries)
- [Security](#security)
- [Versions](#versions)

## Commands

Each step runs one `command`, and each command is one call of the API. The token needs the ability in the third column; abilities are chosen when the token is made on the panel's **API tokens** page, by a member who may operate the group.

| Command | API call | Token ability | Needs | Gives |
|---|---|---|---|---|
| `lock` | `POST /groups/{id}/lock` | Lock groups (`groups:lock`) | `group`, `ttl`, `reason` | `locked-until` |
| `unlock` | `DELETE /groups/{id}/lock` | Lock groups (`groups:lock`) | `group` | |
| `release` | `POST /groups/{id}/releases` | Change releases (`releases:write`) | `group`, `ref`, `build-id` | `release-id`, `release-version`, `generation`, `created` |
| `nodes` | `GET /groups/{id}/nodes` | Read nodes (`nodes:read`) | `group`, `address`, `release-id`, `wait` | `hosts`, `adopted-hosts`, `managed-node-ids`, `count`, `nodes`, `in-flight-older` |
| `node` | `GET /groups/{id}/nodes` | Read nodes (`nodes:read`) | `group`, `node-id`, `release-id`, `address` | `deploy`, `address`, `release-ref`, `build-id`, `phase` |
| `deployed` | `POST /nodes/{id}/deployed`, once per node | Report nodes (`nodes:report`) | `release-id`, `node-ids` | `reported`, `skipped` |
| `rollout` | `POST /groups/{id}/rollout` | Replace older servers (`rollouts:write`) | `group` | `rollout-id`, `older` |
| `ready` | `POST /nodes/{id}/ready` | Report nodes (`nodes:report`) | `node-id`, `release-id`, `generation` | `phase` |
| `failed` | `POST /nodes/{id}/failed` | Report nodes (`nodes:report`) | `node-id`, `release-id`, `generation`, `reason` | `phase` |

## Deploy a release to the running servers

For a group on the [webhook adapter](https://hetscale.com/docs/webhook-adapter). The workflow takes the deploy lock, records the release, reads the serving servers, deploys to each of them as your job already does, reports Hetscale's servers deployed, and releases the lock. Store the token as the secret `HETSCALE_TOKEN` (abilities: Lock groups, Change releases, Read nodes, Report nodes) and the group id (`grp_…`) as the variable `HETSCALE_GROUP`.

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read

# One deploy per group at a time: the lock has no owner, so this is what keeps runs apart.
concurrency:
  group: hetscale-deploy-${{ vars.HETSCALE_GROUP }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 25 # below the lock's ttl of 1800 seconds
    env:
      IMAGE: ghcr.io/acme/app:${{ github.sha }}
    steps:
      - uses: actions/checkout@v7

      # Build and push $IMAGE here, as the job already does.

      - name: Take the deploy lock
        id: lock
        uses: hetscalehq/deploy-action@v1
        with:
          command: lock
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
          ttl: 1800

      - name: Record the release
        id: release
        uses: hetscalehq/deploy-action@v1
        with:
          command: release
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
          ref: ${{ env.IMAGE }}

      - name: Read the serving servers
        id: nodes
        uses: hetscalehq/deploy-action@v1
        with:
          command: nodes
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
          release-id: ${{ steps.release.outputs.release-id }}
          address: ipv4 # private_ip when the runner reaches the private network

      - name: Deploy to each server
        shell: bash
        env:
          HOSTS: ${{ steps.nodes.outputs.hosts }} # outputs reach scripts through env, never ${{ }} in run
        run: |
          while IFS= read -r host; do
            [ -n "$host" ] || continue
            ssh -n "deploy@$host" "./deploy.sh $IMAGE" # the deploy your job already runs
          done <<< "$HOSTS"

      - name: Report the servers deployed # never with if: always(), which would report a failed deploy
        uses: hetscalehq/deploy-action@v1
        with:
          command: deployed
          token: ${{ secrets.HETSCALE_TOKEN }}
          release-id: ${{ steps.release.outputs.release-id }}
          node-ids: ${{ steps.nodes.outputs.managed-node-ids }}

      - name: Release the deploy lock
        if: always() && steps.lock.outcome != 'skipped'
        uses: hetscalehq/deploy-action@v1
        with:
          command: unlock
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
```

- The release is recorded before the deploy, so every server created from then on boots it.
- Servers that started before the release was recorded boot the earlier one. With `release-id`, `nodes` waits for them (up to `wait`, 600 seconds by default, asking every 15 seconds) so that they serve and are in `hosts` when the deploy runs. If some are still starting at the end, it warns and names them in `in-flight-older`; they stay older until a rollout or the next deploy.
- `hosts` holds every serving server, the seed included. `managed-node-ids` holds only Hetscale's own servers, the ones `deployed` reports; a server that left or failed during the deploy is skipped with a warning.
- If the deploy fails half-way, `deployed` does not run and the servers stay older. Run the job again, or make the earlier release current on the group's **Deployment** page.
- A deploy longer than the TTL takes the lock again before its long part: another `lock` step sets a new end, up to 7,200 seconds from then.
- [Kamal](https://hetscale.com/docs/kamal) deploys to the same list: its guide reads `HETSCALE_HOSTS` with commas, so join the lines first, as in `HETSCALE_HOSTS=$(paste -sd, - <<< "$HOSTS") kamal deploy`.

## Let Hetscale replace the servers instead

Hetscale can replace the older servers one at a time, each new one deployed by the [new-server workflow](#deploy-each-new-server). A rollout never replaces the seed, so the job still deploys to the seed itself, under the lock, and starts the rollout once the lock is released. The token also needs Replace older servers (`rollouts:write`). Replace the steps from **Read the serving servers** to the end with:

```yaml
      - name: Read the serving servers
        id: nodes
        uses: hetscalehq/deploy-action@v1
        with:
          command: nodes
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}

      - name: Deploy to the seed
        shell: bash
        env:
          HOSTS: ${{ steps.nodes.outputs.adopted-hosts }}
        run: |
          while IFS= read -r host; do
            [ -n "$host" ] || continue
            ssh -n "deploy@$host" "./deploy.sh $IMAGE"
          done <<< "$HOSTS"

      - name: Release the deploy lock
        if: always() && steps.lock.outcome != 'skipped'
        uses: hetscalehq/deploy-action@v1
        with:
          command: unlock
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}

      - name: Replace the older servers
        uses: hetscalehq/deploy-action@v1
        with:
          command: rollout
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
```

`rollout` succeeds with an empty `rollout-id` when every server already runs the current release, and with a warning when a rollout already runs.

## Deploy each new server

Hetscale sends `node.created` to the group's endpoint when a new server has booted. A small relay, as in the [GitHub Actions recipe](https://hetscale.com/docs/github-actions), verifies the delivery and starts this workflow with the node's id, the release and the generation. The workflow reads the server from the inventory, deploys the node's release to it, and reports it `ready`, or `failed` when the deploy fails. A token with only Read nodes and Report nodes is enough.

```yaml
name: Deploy a new server

on:
  workflow_dispatch:
    inputs:
      node_id: { type: string, required: true }
      release: { type: string, required: true }
      generation: { type: string, required: true }
      ip: { type: string, required: false } # sent by the relay; the address comes from the inventory

permissions:
  contents: read

# A repeated delivery waits for the first run, and then finds nothing to deploy.
concurrency:
  group: hetscale-node-${{ inputs.node_id }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 12 # the readiness deadline (15 minutes by default) also counts the time in the queue
    steps:
      - uses: actions/checkout@v7

      - name: Read the new server
        id: node
        uses: hetscalehq/deploy-action@v1
        with:
          command: node
          token: ${{ secrets.HETSCALE_TOKEN }}
          group: ${{ vars.HETSCALE_GROUP }}
          node-id: ${{ inputs.node_id }}
          release-id: ${{ inputs.release }}
          address: ipv4

      - name: Deploy the node's release
        id: deploy
        if: steps.node.outputs.deploy == 'true'
        shell: bash
        env:
          HOST: ${{ steps.node.outputs.address }}
          REF: ${{ steps.node.outputs.release-ref }}
        run: ssh -n "deploy@$HOST" "./deploy.sh $(printf %q "$REF")"

      - name: Report ready
        if: steps.node.outputs.deploy == 'true'
        uses: hetscalehq/deploy-action@v1
        with:
          command: ready
          token: ${{ secrets.HETSCALE_TOKEN }}
          node-id: ${{ inputs.node_id }}
          release-id: ${{ inputs.release }}
          generation: ${{ inputs.generation }}

      # Only on a failed deploy, not on a cancel: a cancelled run leaves the node to a re-run or its deadline.
      - name: Report failed
        if: failure() && steps.deploy.outcome == 'failure'
        uses: hetscalehq/deploy-action@v1
        with:
          command: failed
          token: ${{ secrets.HETSCALE_TOKEN }}
          node-id: ${{ inputs.node_id }}
          release-id: ${{ inputs.release }}
          generation: ${{ inputs.generation }}
```

- `node` takes the address and the ref from the inventory, never from the dispatch, and fails when the dispatch names another release than the server boots.
- `deploy` is `true` only while the server waits for its pipeline (`BOOTING` or `DEPLOYING`). Once its `ready` report was taken it is a load balancer target, and a repeated dispatch deploys nothing. Traffic opens only when the load balancer's health check passes, whatever the report says.
- `ready` warns, and succeeds, when the server no longer waits because it is leaving or its deploy was cancelled. It fails when the server failed, for example after its deadline.

## Keeping deploys apart

The API's deploy lock has no owner: any token with Lock groups extends or releases it. So the workflow keeps its own runs apart, and the lock's TTL covers the rest.

- Run the deploy under `concurrency: hetscale-deploy-<group>` with `cancel-in-progress: false`, and lock each group from one workflow only.
- GitHub's concurrency groups apply within one repository. A lock taken or released from another repository or another tool, such as Kamal or a script, shares only the TTL with this workflow.
- Release the lock in an explicit step with `if: always() && steps.lock.outcome != 'skipped'`, so it runs after a failure or a cancel, but not when the job never took the lock.
- Set `timeout-minutes` below the TTL. A force-cancelled job or a lost runner runs no further step: the lock then ends on its own at `locked-until`.

## Inputs

| Input | Used by | Default | Description |
|---|---|---|---|
| `command` | all | | `lock`, `unlock`, `release`, `nodes`, `node`, `deployed`, `rollout`, `ready` or `failed` |
| `token` | all | | The API token (`<id>\|<secret>`), always from a secret |
| `group` | `lock`, `unlock`, `release`, `nodes`, `node`, `rollout` | | The group id (`grp_…`) |
| `ttl` | `lock` | `1800` | Seconds until the lock ends on its own, from 60 to 7,200 |
| `reason` | `lock`, `failed` | the repository, commit and run; a link to the run | Why the lock is held (at most 200 characters), or why the deploy failed (at most 500) |
| `ref` | `release` | | An image digest, a tag or a commit on a webhook group; the numeric snapshot id on a snapshot group. Never `:latest` |
| `build-id` | `release` | the commit SHA | Your own build id, at most 120 characters; empty sends none |
| `release-id` | `nodes`, `node`, `deployed`, `ready`, `failed` | | The release id (`rel_…`) |
| `address` | `nodes`, `node` | `ipv4` | `ipv4`, or `private_ip` when the runner reaches the group's private network |
| `wait` | `nodes` | `600` | With `release-id`: seconds to wait for servers that started on an earlier release, from 0 to 3,600 |
| `node-id` | `node`, `ready`, `failed` | | The node id (`node_…`), as `node.created` sent it |
| `node-ids` | `deployed` | | Node ids separated by spaces or new lines, normally `managed-node-ids` |
| `generation` | `ready`, `failed` | | The group generation the node was created for, as `node.created` sent it |
| `api-url` | all | `https://api.hetscale.com/v1` | Leave it unset |

## Outputs

| Output | Set by | Value |
|---|---|---|
| `locked-until` | `lock` | When the lock ends on its own (ISO 8601) |
| `release-id` | `release` | The current release (`rel_…`) |
| `release-version` | `release` | Its number within the group |
| `generation` | `release` | The group's generation after the release |
| `created` | `release` | `true` for a new release, `false` when it already was the current one |
| `hosts` | `nodes` | The address of each serving server, the seed included, one per line |
| `adopted-hosts` | `nodes` | The address of each serving seed, one per line |
| `managed-node-ids` | `nodes` | The ids of the serving servers Hetscale manages, one per line |
| `count` | `nodes` | How many servers serve |
| `nodes` | `nodes` | The serving servers as a JSON array of the API's node objects |
| `in-flight-older` | `nodes` | The ids of servers still starting on an earlier release when the wait ended |
| `deploy` | `node` | `true` while the node waits for its deploy |
| `address` | `node` | The node's address, from the inventory |
| `release-ref` | `node` | The ref of the node's release: the build to deploy |
| `build-id` | `node` | The build id of the node's release |
| `phase` | `node`, `ready`, `failed` | The node's phase |
| `reported`, `skipped` | `deployed` | How many nodes were reported, and how many were skipped |
| `rollout-id` | `rollout` | The rollout that started; empty when none started |
| `older` | `rollout` | How many servers were older when it started |

## Errors and retries

- Every `POST` carries an `Idempotency-Key` made for that call and sent again only on its own retries, so a retry after a lost answer gets the first answer back instead of a second effect. A re-run of the workflow makes new keys and stays safe because each call is safe to repeat.
- 429 and 503 wait the seconds in `Retry-After` (1 to 120, 10 when it is missing). Other 5xx answers, timeouts, network errors and a request whose key is still in flight are tried again after 2, 5, 10 and 20 seconds, with jitter. A call gives up after 6 attempts or 5 minutes. A 502 `provider_error` is never retried: fix the group's Hetzner connection on the panel first.
- These refusals are not failures: `node_not_active` and `node_not_managed` on `deployed`, `nothing_to_replace` and `already_running` on `rollout`, and `not_in_readiness` on `ready` for a server that is still starting or already leaving.
- Every other refusal fails the step with the API's status, code and message, and a hint where one helps. `deployed` stops at the first such refusal, since it would apply to the remaining servers too.

## Security

- The token is read only from the `token` input, masked in the log, checked for its shape only, and sent only in the `Authorization` header to the API. The action follows no redirect.
- The log shows ids, counts and status codes, never server addresses, headers or bodies. Your own deploy step's `env:`, such as `HOSTS`, does show in its log, which in a public repository anyone can read.
- The action refuses to run under `pull_request_target`, and under `workflow_run` when the triggering run came from another repository, such as a pull request from a fork. Runs for pull requests from forks and Dependabot runs get no secrets; the action says so when the token is empty.
- It starts no process, so no input reaches a shell, and it sends nothing but the calls your workflow asks for: no telemetry.
- Give each token only the abilities its workflow needs, and an expiry.

On a self-hosted runner that reaches the internet through a proxy, set `NODE_USE_ENV_PROXY: 1` in the step's `env:`, next to `HTTPS_PROXY`: Node's built-in HTTP client uses the proxy variables only then.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Versions

Releases follow [semver](https://semver.org/), and each `vX.Y.Z` is an immutable release. `@v1` follows the latest `v1.x.y`. To pin the exact code, use the full commit SHA with the version beside it, which Dependabot keeps up to date:

```yaml
uses: hetscalehq/deploy-action@<full commit sha> # v1.0.0
```

A new command, input or output is a minor version. A removed or renamed one, a changed default, or a move to a new Node runtime is a major version; its notes name the minimum runner version.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
