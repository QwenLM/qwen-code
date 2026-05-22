/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import * as Public from '../../src/index.js';
// Type-only imports also exercise the public entry: any name missing
// from `src/index.ts` is a tsc compile error and the suite refuses to
// build, which is the regression fence for the kind of "exists in
// `src/daemon/index.ts` but not re-exported by the published entry"
// gap that two-layer SDK re-exports are easy to drift on.
import type {
  DaemonClientEvictedData,
  DaemonClientEvictedEvent,
  DaemonControlEvent,
  DaemonEvent,
  DaemonEventEnvelope,
  DaemonKnownEventType,
  DaemonModelSwitchedData,
  DaemonModelSwitchedEvent,
  DaemonModelSwitchFailedData,
  DaemonModelSwitchFailedEvent,
  DaemonPermissionOption,
  DaemonPermissionRequestData,
  DaemonPermissionRequestEvent,
  DaemonPermissionResolvedData,
  DaemonPermissionResolvedEvent,
  DaemonSessionDiedData,
  DaemonSessionDiedEvent,
  DaemonSessionEvent,
  DaemonSessionUpdateData,
  DaemonSessionUpdateEvent,
  DaemonSessionViewState,
  DaemonStreamErrorData,
  DaemonStreamErrorEvent,
  DaemonStreamLifecycleEvent,
  KnownDaemonEvent,
} from '../../src/index.js';

describe('public SDK entry — typed daemon event surface (#4217)', () => {
  it('exports the runtime narrow + reducer surface', () => {
    expect(typeof Public.asKnownDaemonEvent).toBe('function');
    expect(typeof Public.isKnownDaemonEvent).toBe('function');
    expect(typeof Public.isDaemonEventType).toBe('function');
    expect(typeof Public.reduceDaemonSessionEvent).toBe('function');
    expect(typeof Public.reduceDaemonSessionEvents).toBe('function');
    expect(typeof Public.createDaemonSessionViewState).toBe('function');
    // F2 (#4175 commit 6 review fix — claude-opus-4-7 W121): pin
    // `isWorkspaceScopedBudgetEvent` to the SDK public surface. PR
    // description + event JSDoc tell consumers to use this helper to
    // branch on `scope === 'workspace'`; without this pinning the
    // export could silently drop on a future barrel reshuffle (same
    // failure mode caught for PR-21 auth surface).
    expect(typeof Public.isWorkspaceScopedBudgetEvent).toBe('function');
  });

  it('round-trips a raw DaemonEvent through the public narrow helper', () => {
    // Pin the user-facing contract: `import { asKnownDaemonEvent }
    // from '@qwen-code/sdk'` must work end-to-end via the published
    // entry, not just exist as a re-export inside src/daemon/index.ts.
    const evt: DaemonEvent = {
      id: 1,
      v: 1,
      type: 'model_switched',
      data: { sessionId: 'sess-1', modelId: 'qwen-plus' },
    };
    const narrowed = Public.asKnownDaemonEvent(evt);
    if (narrowed?.type === 'model_switched') {
      expect(narrowed.data.modelId).toBe('qwen-plus');
    } else {
      expect.fail('expected typed model_switched');
    }
  });

  it('exposes the typed event schema types at the public entry (compile-time)', () => {
    // The type-only imports at the top of this file would fail to
    // compile if any of these names were absent from src/index.ts.
    // The runtime expectations below document the surface set the
    // SDK promises to ship and give tooling that ignores type-only
    // imports a runtime assertion trail.
    expectTypeOf<KnownDaemonEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionEvent>().not.toBeNever();
    expectTypeOf<DaemonControlEvent>().not.toBeNever();
    expectTypeOf<DaemonStreamLifecycleEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionViewState>().not.toBeNever();
    expectTypeOf<DaemonKnownEventType>().not.toBeNever();
    expectTypeOf<DaemonEventEnvelope<'foo', { x: 1 }>>().not.toBeNever();

    expectTypeOf<DaemonSessionUpdateEvent>().not.toBeNever();
    expectTypeOf<DaemonPermissionRequestEvent>().not.toBeNever();
    expectTypeOf<DaemonPermissionResolvedEvent>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchedEvent>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchFailedEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionDiedEvent>().not.toBeNever();
    expectTypeOf<DaemonClientEvictedEvent>().not.toBeNever();
    expectTypeOf<DaemonStreamErrorEvent>().not.toBeNever();

    expectTypeOf<DaemonSessionUpdateData>().not.toBeNever();
    expectTypeOf<DaemonPermissionRequestData>().not.toBeNever();
    expectTypeOf<DaemonPermissionResolvedData>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchedData>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchFailedData>().not.toBeNever();
    expectTypeOf<DaemonSessionDiedData>().not.toBeNever();
    expectTypeOf<DaemonClientEvictedData>().not.toBeNever();
    expectTypeOf<DaemonStreamErrorData>().not.toBeNever();
    expectTypeOf<DaemonPermissionOption>().not.toBeNever();
  });

  it('exposes the PR 21 auth device-flow surface at the public entry', () => {
    // PR #4255 fold-in 9 review thread #11: the auth surface had
    // been re-exported from `src/daemon/index.ts` but never from
    // the published `src/index.ts`, so SDK consumers got
    // `undefined` for everything except `client.auth.start()`
    // (which traveled through the already-exported `DaemonClient`).
    expect(typeof Public.DaemonAuthFlow).toBe('function');
    expect(typeof Public.reduceDaemonAuthEvent).toBe('function');
    expect(typeof Public.reduceDaemonAuthEvents).toBe('function');
    expect(typeof Public.createDaemonAuthState).toBe('function');
    expect(typeof Public.DEVICE_FLOW_EXPIRY_GRACE_MS).toBe('number');
  });
});
