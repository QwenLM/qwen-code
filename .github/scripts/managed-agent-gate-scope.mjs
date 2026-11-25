#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const JAVA_PATHS = [
  /^packages\/(managed-agent-server|sdk-java)\//,
  /^scripts\/(check-flyway-migrations\.js|check-failsafe-reports\.js)$/,
  /^\.github\/scripts\/(maven-cache-seed|sdk-java-lock)\.sh$/,
];

const DAEMON_PATHS = [
  /^packages\/sdk-java\/qwencode\/src\/(main|test)\/java\/com\/alibaba\/qwen\/code\/daemon\//,
  /^packages\/cli\/src\/serve\//,
  /^packages\/cli\/src\/commands\/serve(\.ts|\/)/,
  /^packages\/core\/src\/managed-runtime\//,
  /^scripts\/run-java-daemon-sdk-e2e\.ts$/,
  /^integration-tests\/fake-openai-server\.ts$/,
];

const SHARED_PATHS = [
  /^\.github\/workflows\/(sdk-java|managed-agent-gate)\.yml$/,
  /^\.github\/scripts\/(managed-agent-gate-(scope\.mjs|tier\.sh)|configure-maven-mirror\.sh)$/,
];

const BACKGROUND_PATHS = [
  /^packages\/cli\/src\/commands\/channel(\.ts|\/)/,
  /^packages\/channels\/github\/src\/managed-/,
  /^integration-tests\/helpers\/hosted-/,
  /^integration-tests\/vitest\.hosted\.config\.ts$/,
  /^scripts\/(run-managed-agent-server-e2e\.ts|run-managed-pr-watch-e2e\.mjs|rocketmq-lite-broker\.sh)$/,
];

export function managedAgentCoverage(paths) {
  const matches = (patterns) =>
    paths.some(
      (path) => !path.endsWith('.md') && patterns.some((re) => re.test(path)),
    );

  if (matches(SHARED_PATHS)) return 'both';

  const java = matches(JAVA_PATHS);
  const daemon = matches(DAEMON_PATHS);
  if (java && daemon) return 'both';
  if (java) return 'java';
  if (daemon) return 'daemon';
  return matches(BACKGROUND_PATHS) ? 'background' : 'none';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0, 'utf8').split('\0');
  process.stdout.write(`${managedAgentCoverage(paths)}\n`);
}
