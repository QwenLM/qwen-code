/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

process.stderr.write('[event] ready\n');
process.stdout.write('{"type":"final"}\n', () => {
  process.stderr.write(
    '{"message":"stale stderr error","retryable":false}\n',
    () => process.exit(0),
  );
});
