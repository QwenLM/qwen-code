/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeExtensionFeatures,
  normalizeContentLength,
} from './extension-features.js';

describe(
  'extension features',
  () => {
    it.each(['plugin', 'skill', 'subagent', 'mcp'] as const)(
      'always includes the required marketplace fields for %s',
      (kind) => {
        const keys = kind === 'mcp'
          ? ['marketItemId', 'displayName', 'version']
          : ['marketSourceId', 'marketOrgId', 'extensionKind', 'extensionId', 'extensionVersion'];
        const empty = normalizeExtensionFeatures(
          kind,
          {},
        );
        const values = normalizeExtensionFeatures(
          kind,
          Object.fromEntries(keys.map(key => [key, 'provided'])),
        );

        for (const key of keys) {
          expect(empty).toHaveProperty(key, '');
          expect(values).toHaveProperty(key, 'provided');
        }
      },
    );

    it.each([
      ['mcp', 47],
      ['skill', 38],
      ['subagent', 41],
    ] as const)(
      'projects and freezes %s fields',
      (
        kind,
        count
      ) => {
        const rawRecord = {
          success: false,
          durationMs: 0,
          skillName: 'x',
          subagentType: 'a',
          mcpServerName: 'server',
          mcpDispatchSuccess: true,
          errorCode: 'EXPLICIT_CODE',
          plugin: { marketItemId: 'must-stay-private' },
          resourceName: 'not-selected',
        };
        const result = normalizeExtensionFeatures(
          kind,
          rawRecord
        );
        expect(Object.keys(result)).toHaveLength(count);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.success).toBe(false);
        for (const key of [
          'toolName',
          'skillName',
          'subagentType',
          'mcpTargetToolName',
          'durationMs',
          'status',
          'errorType',
          'errorCode',
        ]) {
          expect(Object.keys(result)).not.toContain(key);
        }
        if (kind === 'mcp') {
          expect(result.mcpServerName).toBe('server');
          expect(result.mcpDispatchSuccess).toBe(true);
        } else {
          expect(Object.keys(result).some((key) => key.startsWith('mcp'))).toBe(
            false,
          );
        }
        expect(result.eventId).toBe('');
        expect(
          Object.keys(result).every((key) => /^[a-z][a-zA-Z0-9]*$/.test(key)),
        ).toBe(true);
        expect(result).not.toHaveProperty('plugin');
        expect(result).not.toHaveProperty('resourceName');
        if (kind !== 'skill') expect(result).not.toHaveProperty('skillName');
        if (kind !== 'subagent') expect(result).not.toHaveProperty('subagentType');
        rawRecord.durationMs = 20;
        expect(result).not.toHaveProperty('durationMs');
      }
    );
    it(
      'normalizes result length with presence distinct from zero',
      () => {
        expect(normalizeContentLength(
          true,
          12.9
        )).toBe(12);
        expect(normalizeContentLength(
          true,
          NaN
        )).toBe(0);
        expect(normalizeContentLength(
          true,
          undefined
        )).toBe(0);
        expect(normalizeContentLength(
          true,
          -3
        )).toBe(0);
        expect(normalizeContentLength(
          false,
          undefined
        )).toBe('');
      }
    );
  }
);
