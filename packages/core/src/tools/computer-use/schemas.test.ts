/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { COMPUTER_USE_SCHEMAS, COMPUTER_USE_TOOL_NAMES } from './schemas.js';

describe('computer-use schemas (cua-driver full tool surface)', () => {
  it('exports the complete cua-driver tool set (no curation)', () => {
    // Every tool cua-driver advertises is exposed; if upstream adds/removes
    // tools, re-run scripts/sync-computer-use-schemas.ts and bump this count.
    expect(Object.keys(COMPUTER_USE_SCHEMAS)).toHaveLength(35);
    expect(COMPUTER_USE_TOOL_NAMES).toHaveLength(35);
  });

  it('includes the renamed screenshot+AX tool (get_window_state, not get_app_state)', () => {
    expect(COMPUTER_USE_TOOL_NAMES).toContain('get_window_state');
    expect(COMPUTER_USE_TOOL_NAMES).not.toContain('get_app_state');
  });

  it('includes the page (CDP/Electron) tool and other full-surface tools', () => {
    // `page` reaches Electron/webview content the native AX tree can't —
    // it must NOT be curated out.
    for (const t of [
      'page',
      'launch_app',
      'kill_app',
      'start_session',
      'move_cursor',
      'set_config',
      'get_accessibility_tree',
    ]) {
      expect(COMPUTER_USE_TOOL_NAMES).toContain(t);
    }
  });

  it('keeps the core action tools', () => {
    for (const t of [
      'list_apps',
      'click',
      'scroll',
      'drag',
      'type_text',
      'press_key',
      'set_value',
    ]) {
      expect(COMPUTER_USE_TOOL_NAMES).toContain(t);
    }
  });

  it('each tool name is an upstream name (no computer_use__ prefix)', () => {
    for (const name of COMPUTER_USE_TOOL_NAMES) {
      expect(name).not.toContain('computer_use__');
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  it('every schema has the standard object structure', () => {
    for (const [name, schema] of Object.entries(COMPUTER_USE_SCHEMAS)) {
      expect(schema.description, `${name} missing description`).toBeTruthy();
      expect(
        schema.parameterSchema,
        `${name} missing parameterSchema`,
      ).toBeTruthy();
      expect((schema.parameterSchema as { type: string }).type).toBe('object');
    }
  });

  it('list_apps takes no required parameters', () => {
    const schema = COMPUTER_USE_SCHEMAS.list_apps.parameterSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required ?? []).toHaveLength(0);
  });

  it('click targets a pid (cua-driver semantics, not the old ocu app string)', () => {
    const schema = COMPUTER_USE_SCHEMAS.click.parameterSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty('pid');
    expect(schema.properties).toHaveProperty('element_index');
    expect(schema.properties).toHaveProperty('x');
    expect(schema.properties).toHaveProperty('y');
    expect(schema.required).toContain('pid');
    expect(schema.properties).not.toHaveProperty('app');
  });
});
