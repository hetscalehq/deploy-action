// What to do about a refusal. The API's own message says what happened; a hint says what fixes it.

const ABILITIES = {
  lock: 'Lock groups (groups:lock)',
  unlock: 'Lock groups (groups:lock)',
  release: 'Change releases (releases:write)',
  nodes: 'Read nodes (nodes:read)',
  node: 'Read nodes (nodes:read)',
  deployed: 'Report nodes (nodes:report)',
  ready: 'Report nodes (nodes:report)',
  failed: 'Report nodes (nodes:report)',
  rollout: 'Replace older servers (rollouts:write)',
};

const NODE_PATHS = new Set(['deployed', 'ready', 'failed']);

const CODES = {
  ref_invalid:
    'a snapshot group takes the numeric id of a snapshot, a webhook group an image digest, a tag or a commit',
  ref_mutable: 'name one build for good, such as an image digest or a version tag, never :latest',
  not_snapshot_group: "this group's releases come from its Coolify deployments, which the action does not record",
  not_webhook_group:
    'only a webhook group takes in-place deploy reports; on a snapshot group, record the release and start a rollout',
  provider_error: "Hetzner refused the group's project token: connect the project again on the panel, then run again",
};

export function hint(command, status, code) {
  if (status === 401) {
    return "the token expired or was revoked, or its member left the organisation: create a new one on the panel's API tokens page";
  }
  if (status === 403) {
    return `the token lacks ${ABILITIES[command]}, or its member may not operate the group`;
  }
  if (status === 404) {
    return `no such ${NODE_PATHS.has(command) ? 'node' : 'group'} for this token: a wrong id, or another organisation's`;
  }
  if (status === 429) {
    return "the organisation's rate limit (60 requests a minute by default) is used up: run again later, or spread the pipelines that call the API";
  }
  return CODES[code];
}
