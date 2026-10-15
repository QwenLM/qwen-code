/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

process.stderr.write('[event] ready\n');
process.stderr.write('{"message":"stale marker","retryable":false}\n');
process.stdout.write('{"type":"recovered"}\n', () => process.exit(0));
