#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Export one session's omni trajectory as training-consumable JSONL
 * (S6, issue #8190). Thin wrapper over the core exporter — kept as a
 * script instead of a CLI subcommand deliberately: the experiment branch
 * does not grow command surface for a downstream-tooling concern.
 *
 * Usage:
 *   node scripts/export-omni-trajectory.js \
 *     --transcript <path/to/session.jsonl> \
 *     --omni-root <project>/.qwen/omni \
 *     --out <path/to/trajectory.jsonl>
 *
 * The transcript is a chat-record JSONL (found under
 * `~/.qwen/tmp/<project_id>/chats/`); --omni-root holds memory.json.
 */

import path from 'node:path';
import { writeOmniTrajectoryJsonl } from '@qwen-code/qwen-code-core/omni';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const transcriptPath = argValue('--transcript');
const omniRootDir = argValue('--omni-root');
const outPath = argValue('--out');

if (!transcriptPath || !omniRootDir || !outPath) {
  console.error(
    'usage: export-omni-trajectory.js --transcript <session.jsonl> ' +
      '--omni-root <.qwen/omni> --out <trajectory.jsonl>',
  );
  process.exit(2);
}

const { records } = await writeOmniTrajectoryJsonl({
  transcriptPath: path.resolve(transcriptPath),
  omniRootDir: path.resolve(omniRootDir),
  outPath: path.resolve(outPath),
});
console.log(`wrote ${records} record(s) to ${outPath}`);
