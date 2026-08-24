/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

process.stderr.write('[event] ready\n');
process.stdout.write('{"sequence":1}\n');
globalThis.setTimeout(() => {
  process.stdout.write('{"sequence":2}\n');
  process.stderr.write(
    '{"message":"subscription denied","retryable":false}\n',
    () => process.exit(1),
  );
}, 10);
