/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PermissionController } from './permissionController.js';
import type { IControlContext } from '../ControlContext.js';
import type { IPendingRequestRegistry } from './baseController.js';

/**
 * `buildPermissionSuggestions` is a pure transformation from a
 * confirmation-details payload to a `PermissionSuggestion[]`. It does
 * not touch the controller's context, registry, or pending-request
 * state, so we can construct the controller with empty stubs cast to
 * the relevant interfaces. The tests cover:
 *
 *   1. The exec branch passes through the command in `description` and
 *      appends one `⚠ <warning>` segment per warning when the payload
 *      carries a `warnings: string[]` field — see #4386 (round 3 review)
 *      for why this branch needs explicit coverage.
 *   2. Non-string entries in `warnings` are filtered out by the
 *      `typeof w === 'string'` type guard.
 *   3. When `warnings` is absent or empty, the description has no
 *      warning suffix and reads identically to the pre-#4386 output.
 *   4. Invalid / non-exec payloads still return a sane suggestion array
 *      (regression guard for the type-guard chain).
 */

function makeController(): PermissionController {
  const context = {} as IControlContext;
  const registry = {} as IPendingRequestRegistry;
  return new PermissionController(context, registry, 'permission');
}

describe('PermissionController.buildPermissionSuggestions — exec warnings', () => {
  it('appends ⚠ segments for each string warning on exec confirmations', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'python3 -c "print($(echo hello))"',
      warnings: [
        'Contains command substitution ($(...), backticks, <(...), or >(...)).',
      ],
    });

    expect(suggestions).not.toBeNull();
    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow).toBeDefined();
    // Command is preserved.
    expect(allow!.description).toContain('python3 -c "print($(echo hello))"');
    // Warning is appended with the ⚠ glyph + space.
    expect(allow!.description).toMatch(/⚠ Contains command substitution/);
    // Deny entry never carries warnings.
    expect(suggestions!.find((s) => s.type === 'deny')?.description).toBe(
      'Block this command execution',
    );
  });

  it('joins multiple warnings with "; "', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'cmd',
      warnings: ['warn-a', 'warn-b'],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toContain('⚠ warn-a; ⚠ warn-b');
  });

  it('filters non-string entries out of warnings', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'cmd',
      warnings: ['keep-me', 42, null, undefined, { x: 1 }, 'also-keep'],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toContain('⚠ keep-me; ⚠ also-keep');
    expect(allow!.description).not.toMatch(/⚠ 42|⚠ null|⚠ undefined|⚠ \[/);
  });

  it('omits the warning suffix when warnings is absent', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
    // No bare "(" suffix means no empty parens leaked.
    expect(allow!.description).not.toContain('(');
  });

  it('omits the warning suffix when warnings is an empty array', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
      warnings: [],
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
  });

  it('omits the warning suffix when warnings is not an array', () => {
    const controller = makeController();
    const suggestions = controller.buildPermissionSuggestions({
      type: 'exec',
      command: 'npm install',
      // Defensive: hosts could send malformed payloads. The
      // `Array.isArray` guard must keep them on the empty-warnings path.
      warnings: 'not-an-array',
    });

    const allow = suggestions!.find((s) => s.type === 'allow');
    expect(allow!.description).toBe('Execute: npm install');
  });

  it('returns null for confirmation-details payloads without a type field', () => {
    const controller = makeController();
    expect(controller.buildPermissionSuggestions(null)).toBeNull();
    expect(controller.buildPermissionSuggestions({})).toBeNull();
    expect(controller.buildPermissionSuggestions({ command: 'x' })).toBeNull();
  });
});
