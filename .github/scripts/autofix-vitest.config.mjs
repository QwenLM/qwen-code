import { resolve } from 'node:path';

const workspace = process.env.AUTOFIX_WORKSPACE;

if (!workspace) {
  throw new Error('Missing isolated Vitest configuration');
}

export default {
  root: resolve(workspace, 'integration-tests'),
  test: {
    // Mirror the integration-tests config default (TB_TIMEOUT_MINUTES=5);
    // that env var is not on the wrapper's env allowlist. Without this,
    // Vitest's 5 s default would fail any future allowlisted case that does
    // not declare its own timeout.
    testTimeout: 5 * 60 * 1000,
    retry: 0,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        isolate: true,
      },
    },
  },
};
