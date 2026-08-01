import { resolve } from 'node:path';

const workspace = process.env.AUTOFIX_WORKSPACE;

if (!workspace) {
  throw new Error('Missing isolated Vitest configuration');
}

export default {
  root: resolve(workspace, 'integration-tests'),
  test: {
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
