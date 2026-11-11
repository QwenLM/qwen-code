/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionManager,
  createPermissionModes,
} from './permission-manager.js';

describe('managed policy readiness at tool entry', () => {
  it.each(['check', 'checkWithChecker'] as const)(
    'preserves immediate local checks without a dynamic policy in %s',
    async (entry) => {
      const readRestriction = vi.fn(() => undefined);
      class Manager extends PermissionManager {
        override initialize() {
          super.initialize();
          this.managedPolicy = {
            getRules: () => ({ allow: {}, deny: {}, ask: {} }),
            getModeRestriction: readRestriction,
            dispose: () => {},
          };
          this.modes = createPermissionModes(this.managedPolicy);
        }
      }
      const manager = new Manager();
      manager.initialize();
      const checker = { check: () => ({ kind: 'allow' as const }) };
      manager.registerChecker('Probe', checker);
      const session = manager.createSessionPermissionManager({
        getSessionId: () => 'static-policy',
        getWorkingDir: () => '/tmp',
        flagSettings: {
          initialMode: 'yolo',
          rules: { allow: {}, deny: {}, ask: {} },
          additionalDirectories: [],
        },
      });
      try {
        const request = { toolName: 'Probe', toolUseId: 'static', input: {} };
        const decision =
          entry === 'check'
            ? session.check(request)
            : session.checkWithChecker(request, checker);
        void decision.catch(() => {});
        expect(readRestriction).toHaveBeenCalled();
        expect(await decision).toMatchObject({ kind: 'allow' });
      } finally {
        await session.dispose();
        manager.dispose();
      }
    },
  );

  it('applies managed command rules from the first read before local allow rules', async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let restricted = false;
    class Manager extends PermissionManager {
      override initialize() {
        super.initialize();
        this.managedPolicy = {
          whenReady: () => ready,
          getRules: () => ({
            allow: {},
            deny: { policySettings: restricted ? ['Read'] : [] },
            ask: {},
          }),
          getModeRestriction: () => undefined,
          dispose: () => {},
        };
        this.modes = createPermissionModes(this.managedPolicy);
      }
    }
    const manager = new Manager();
    manager.initialize();
    const session = manager.createSessionPermissionManager({
      getSessionId: () => 'managed-rule-first-read',
      getWorkingDir: () => '/tmp',
      flagSettings: {
        initialMode: 'yolo',
        rules: { allow: { userSettings: ['Read'] }, deny: {}, ask: {} },
        additionalDirectories: [],
      },
    });
    try {
      const request = {
        toolName: 'Read',
        toolUseId: 'read',
        input: { file_path: '/tmp/readiness.txt' },
      };
      const decision = session.check(request);
      restricted = true;
      finish();
      expect(await decision).toMatchObject({ kind: 'deny' });
      restricted = false;
      expect(await session.check(request)).toMatchObject({ kind: 'allow' });
    } finally {
      finish();
      await session.dispose();
      manager.dispose();
    }
  });

  it.each(['auto', 'yolo'] as const)(
    'waits for the first policy before checking tools in %s',
    async (mode) => {
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let disabled = false;
      const policy = {
        whenReady: vi.fn(() => ready),
        getRules: () => ({ allow: {}, deny: {}, ask: {} }),
        getModeRestriction: () =>
          disabled ? { message: 'Host policy restriction' } : undefined,
        dispose: () => {},
      };
      class Manager extends PermissionManager {
        override initialize() {
          super.initialize();
          this.managedPolicy = policy;
          this.modes = createPermissionModes(policy);
        }
      }
      const manager = new Manager();
      manager.initialize();
      const check = vi.fn(() => ({ kind: 'allow' as const }));
      manager.registerChecker('Probe', { check });
      const session = manager.createSessionPermissionManager({
        getSessionId: () => 'policy-readiness',
        getWorkingDir: () => '/tmp',
        flagSettings: {
          initialMode: mode,
          rules: { allow: {}, deny: {}, ask: {} },
          additionalDirectories: [],
        },
      });
      const request = { toolName: 'Probe', toolUseId: 'probe', input: {} };
      try {
        const ordinary = session.check(request);
        const custom = session.checkWithChecker(request, { check });
        expect(policy.whenReady).toHaveBeenCalledTimes(2);
        expect(check).not.toHaveBeenCalled();
        disabled = true;
        finish();
        expect(await ordinary).toMatchObject({
          kind: 'deny',
          reason: { message: 'Host policy restriction' },
        });
        expect(await custom).toMatchObject({
          kind: 'deny',
          reason: { message: 'Host policy restriction' },
        });
        expect(check).not.toHaveBeenCalled();
        disabled = false;
        expect(await session.check(request)).toMatchObject({ kind: 'allow' });
        expect(check).toHaveBeenCalledOnce();
      } finally {
        finish();
        await session.dispose();
        manager.dispose();
      }
    },
  );
});
