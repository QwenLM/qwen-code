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
    expect(Object.keys(COMPUTER_USE_SCHEMAS)).toHaveLength(54);
    expect(COMPUTER_USE_TOOL_NAMES).toHaveLength(54);
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
      'get_desktop_state',
      'browser_prepare',
      'browser_download',
      'clipboard_read',
      'clipboard_write',
      'health_report',
      'verify_state',
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
      expect(schema.annotations, `${name} missing annotations`).toBeTruthy();
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(
          typeof schema.annotations[hint],
          `${name}.${hint} must be a boolean`,
        ).toBe('boolean');
      }
      expect(
        schema.description,
        `${name} leaked a payload-filter marker`,
      ).not.toContain('__cuaf_');
    }
  });

  it('preserves upstream destructive annotations', () => {
    expect(COMPUTER_USE_SCHEMAS.click.annotations.destructiveHint).toBe(true);
    expect(COMPUTER_USE_SCHEMAS.list_apps.annotations.destructiveHint).toBe(
      false,
    );
  });

  it('list_apps takes no required parameters', () => {
    const schema = COMPUTER_USE_SCHEMAS.list_apps.parameterSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required ?? []).toHaveLength(0);
  });

  it('click supports window and absolute desktop addressing', () => {
    const schema = COMPUTER_USE_SCHEMAS.click.parameterSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).toHaveProperty('pid');
    expect(schema.properties).toHaveProperty('window_id');
    expect(schema.properties).toHaveProperty('scope');
    expect(schema.properties).toHaveProperty('element_index');
    expect(schema.properties).toHaveProperty('x');
    expect(schema.properties).toHaveProperty('y');
    expect(schema.properties).not.toHaveProperty('app');
  });

  it('keeps deprecated capture_mode permissive because every value is ignored', () => {
    const schema = COMPUTER_USE_SCHEMAS.get_window_state.parameterSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties['capture_mode'].enum).toBeUndefined();
  });

  it('advertises every macOS action that accepts coordinates from zoom', () => {
    for (const name of [
      'click',
      'drag',
      'type_text',
      'press_key',
      'hotkey',
    ] as const) {
      const schema = COMPUTER_USE_SCHEMAS[name].parameterSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties, `${name} missing from_zoom`).toHaveProperty(
        'from_zoom',
      );
    }
  });

  it('rejects unknown parameters for every tool (additionalProperties: false)', () => {
    // The client-side validator relies on this to fail fast on hallucinated
    // params instead of forwarding them to a driver that silently ignores
    // them. The sync script normalizes any upstream `true` to `false`.
    for (const [name, schema] of Object.entries(COMPUTER_USE_SCHEMAS)) {
      expect(
        schema.parameterSchema['additionalProperties'],
        `${name} must set additionalProperties: false`,
      ).toBe(false);
    }
  });
});
