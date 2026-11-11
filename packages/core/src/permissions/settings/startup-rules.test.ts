/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { permissionRulesFromStartup } from './startup-rules.js';

describe('permissionRulesFromStartup', () => {
  // A headless run started with an empty `--tools` used to keep exactly these
  // two, and spent its turn messaging other sessions with them.
  it('denies the messaging tools when --tools leaves them out', () => {
    const deny = permissionRulesFromStartup({ coreTools: [] }).deny.cliArg;
    expect(deny).toEqual(expect.arrayContaining(['SendMessage', 'ListAgents']));
  });

  it('keeps a messaging tool that --tools names', () => {
    const deny = permissionRulesFromStartup({ coreTools: ['SendMessage'] }).deny
      .cliArg;
    expect(deny).not.toContain('SendMessage');
    expect(deny).toContain('ListAgents');
  });

  it('splits a comma-separated --allowed-tools value into bare allow rules', () => {
    const allow = permissionRulesFromStartup({
      allowedTools: ['Write,Edit'],
    }).allow.cliArg;
    expect(allow).toEqual(['Write', 'Edit']);
  });
});
