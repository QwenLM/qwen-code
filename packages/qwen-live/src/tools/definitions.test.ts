/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildLiveSessionTools,
  LIVE_SESSION_TOOLS,
  PROACTIVE_SESSION_TOOLS,
} from './definitions.js';

interface TestSchema {
  properties?: Record<string, { type?: unknown }>;
  required?: string[];
}

const PROACTIVE_NAMES = [
  'create_proactive_monitor',
  'create_live_narration',
  'create_proactive_timer',
  'update_proactive_task',
  'cancel_proactive_task',
  'list_proactive_tasks',
];

describe('live session Proactive tools', () => {
  it('advertises exactly the six flat source tools in stable order', () => {
    expect(PROACTIVE_SESSION_TOOLS.map((tool) => tool.function.name)).toEqual(
      PROACTIVE_NAMES,
    );
    expect(PROACTIVE_SESSION_TOOLS).toHaveLength(6);

    for (const tool of PROACTIVE_SESSION_TOOLS) {
      const schema = tool.function.parameters as TestSchema;
      const properties = schema.properties ?? {};
      expect(tool.continuesResponse).toBe(true);
      expect(properties).not.toHaveProperty('op');
      expect(properties).not.toHaveProperty('operations');
      expect(schema.required ?? []).not.toContain('op');
      expect(schema.required ?? []).not.toContain('operations');
      expect(
        Object.values(properties).every(
          (property) => property.type !== 'object',
        ),
      ).toBe(true);
    }
  });

  it('keeps creation, update, and cancellation contracts distinct', () => {
    const schemas = Object.fromEntries(
      PROACTIVE_SESSION_TOOLS.map((tool) => [
        tool.function.name,
        tool.function.parameters as TestSchema,
      ]),
    );

    expect(schemas['create_proactive_monitor'].required).toEqual([
      'title',
      'modalities',
      'condition',
      'trigger_response',
      'repeat',
    ]);
    expect(schemas['create_live_narration'].required).toEqual([
      'title',
      'modalities',
      'narration_focus',
      'narration_style',
    ]);
    expect(schemas['create_proactive_timer'].required).toEqual([
      'title',
      'duration_sec',
      'reminder_text',
    ]);

    expect(schemas['create_proactive_monitor'].properties).not.toHaveProperty(
      'task_id',
    );
    expect(schemas['create_live_narration'].properties).not.toHaveProperty(
      'condition',
    );
    expect(schemas['create_live_narration'].properties).not.toHaveProperty(
      'repeat',
    );
    for (const name of ['create_proactive_monitor', 'update_proactive_task']) {
      expect(schemas[name].properties).not.toHaveProperty('sensitivity');
      expect(schemas[name].properties).not.toHaveProperty('window_size_sec');
    }
    for (const name of ['update_proactive_task', 'cancel_proactive_task']) {
      expect(schemas[name].properties).toHaveProperty('target_title');
      expect(schemas[name].properties).toHaveProperty('target_title_contains');
      expect(schemas[name].properties).not.toHaveProperty('task_id');
    }
  });

  it('selects Proactive tools without changing the compatibility export', () => {
    const enabled = buildLiveSessionTools(true);

    expect(buildLiveSessionTools(false)).toBe(LIVE_SESSION_TOOLS);
    expect(buildLiveSessionTools()).toEqual(enabled);
    expect(enabled.slice(0, LIVE_SESSION_TOOLS.length)).toEqual(
      LIVE_SESSION_TOOLS,
    );
    expect(enabled.slice(LIVE_SESSION_TOOLS.length)).toEqual(
      PROACTIVE_SESSION_TOOLS,
    );
    expect(
      LIVE_SESSION_TOOLS.some((tool) =>
        PROACTIVE_NAMES.includes(tool.function.name),
      ),
    ).toBe(false);
  });
});
