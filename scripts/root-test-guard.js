/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The root vitest config carries none of the packages' test settings (setup
// files, 60s timeouts, forks pool), so running tests from the repo root
// produces failures that never happen inside a package. The root `test`,
// `test:all` and `test:ui` scripts point here instead of running vitest.

console.error(`不要在仓库根目录运行测试：根目录的 vitest 配置缺少各包的 setup 文件、超时和进程池设置，结果不可信。

只跑与改动相关的测试，在对应包目录下运行：
  cd packages/core && npx vitest run src/path/to/file.test.ts
  cd packages/cli && npx vitest run src/path/to/file.test.ts

用户明确要求跑全量时，用各包自己的配置：
  npm run test:ci
`);
process.exit(1);
