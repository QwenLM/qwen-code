#!/usr/bin/env node
// Reads changed paths on stdin and prints whether any of them can break the
// Managed Agent suite that sdk-java.yml runs. Everything else is left to the
// nightly full run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MANAGED_AGENT_PATHS = [
  /^packages\/managed-agent-server\//,
  /^packages\/sdk-java\//,
  /^packages\/cli\/src\/serve\//,
  /^packages\/cli\/src\/commands\/channel\//,
  // The file that mounts the `channel` subcommand beside that directory: a
  // subcommand added or rerouted here changes the managed adapters' entry
  // points without touching anything under commands/channel/.
  /^packages\/cli\/src\/commands\/channel\.ts$/,
  /^packages\/channels\/github\//,
  /^packages\/core\/src\/managed-runtime\//,
  /^integration-tests\/helpers\/hosted-/,
  /^integration-tests\/vitest\.hosted\.config\.ts$/,
  /^scripts\/(run-managed-agent-server-e2e\.ts|run-managed-pr-watch-e2e\.mjs|run-java-daemon-sdk-e2e\.ts|check-failsafe-reports\.js|check-flyway-migrations\.js|rocketmq-lite-broker\.sh)$/,
  /^\.github\/workflows\/(sdk-java|managed-agent-gate)\.yml$/,
  /^\.github\/scripts\/managed-agent-gate-(scope\.mjs|tier\.sh)$/,
];

export function touchesManagedAgent(paths) {
  return paths.some((path) => MANAGED_AGENT_PATHS.some((re) => re.test(path)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  process.stdout.write(`${touchesManagedAgent(paths)}\n`);
}
