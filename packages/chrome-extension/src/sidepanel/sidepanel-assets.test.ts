/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('side panel capability status assets', () => {
  it('loads the generated capability model before the panel host', () => {
    const html = readFileSync(
      path.join(packageRoot, 'public/sidepanel.html'),
      'utf8',
    );

    expect(html).toContain('src="sidepanel/capability-status.js"');
    expect(html.indexOf('sidepanel/capability-status.js')).toBeLessThan(
      html.indexOf('src="sidepanel.js"'),
    );
  });

  it('provides a live region for browser automation warnings', () => {
    const html = readFileSync(
      path.join(packageRoot, 'public/sidepanel.html'),
      'utf8',
    );

    expect(html).toContain('id="capability-warning"');
    expect(html).toContain('role="status"');
  });

  it('derives shell and warning state from the full capability response', () => {
    const script = readFileSync(
      path.join(packageRoot, 'public/sidepanel.js'),
      'utf8',
    );

    expect(script).toContain('deriveCapabilityStatus');
    expect(script).toContain('status.shellReady');
    expect(script).toContain('status.warning');
  });
});
