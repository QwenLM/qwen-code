/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Template } from 'e2b';
import process from 'node:process';
import console from 'node:console';
const image = process.env['QWEN_E2B_WORKER_IMAGE'];
const alias = process.env['QWEN_E2B_TEMPLATE_ALIAS'];
if (!image || !/@sha256:[a-f0-9]{64}$/u.test(image) || !alias) {
  throw new Error(
    'Supply a digest-pinned Linux worker image and template alias.',
  );
}
const result = await Template.build(
  Template()
    .fromImage(image)
    .setReadyCmd('test -r /opt/qwen/dist/cli.js && node --version'),
  alias,
  { cpuCount: 2, memoryMB: 2048 },
);
console.log(result.templateId);
