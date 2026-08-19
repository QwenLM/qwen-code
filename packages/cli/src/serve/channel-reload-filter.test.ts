/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { ChannelStateStore } from '../commands/channel/channel-state-store.js';
import { daemonChannelRuntimeStatePath } from '../commands/channel/runtime.js';
import { createDaemonReloadSelectionFilter } from './channel-reload-filter.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

// Direct pins on the PRODUCTION reload-selection filter (R14-5): the
// manager suite named `filterReloadSelection (R14)` injects synthetic
// filters and pins only the manager's plumbing — nothing seeded a daemon
// state file and drove the real filtering logic. Mutations here (dropping
// canonicalizeWorkspace, swapping in the standalone state path, inverting
// `!stoppedIn(...)`, flipping the no-owner default) all lived in the
// serve wiring and shipped green through the entire suite, while the
// escaped behavior is a names-mode recovery reconcile force-starting an
// explicitly stopped sibling — the resurrection the filter exists to
// prevent. These tests run the real ChannelStateStore against a temp
// QWEN_HOME so the path derivation under test is the production one.
// The filter takes its state access as injected deps (the serve fast-path
// bundle boundary forbids static imports of the channel command graph in
// channel-reload-filter); makeFilter below mirrors the run-qwen-serve
// wiring so the derivation under test stays the production one.
describe('createDaemonReloadSelectionFilter (R14-5)', () => {
  const workspace = '/workspace/filter';
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env['QWEN_HOME'];
    home = mkdtempSync(path.join(os.tmpdir(), 'qwen-reload-filter-home-'));
    process.env['QWEN_HOME'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const group = (
    workspaceCwd: string,
    names: string[],
  ): ChannelWorkspaceGroup => ({
    workspaceCwd,
    selection: { mode: 'names', names },
  });

  // Same wiring run-qwen-serve uses: canonicalization + daemon state read
  // from the real channel command graph modules.
  const makeFilter = () =>
    createDaemonReloadSelectionFilter({
      canonicalizeWorkspace,
      readRuntimeStates: (canonicalWorkspaceCwd) =>
        new ChannelStateStore(
          daemonChannelRuntimeStatePath(canonicalWorkspaceCwd),
        ).readAll(),
    });

  it('drops a name with a persisted stopped record and keeps its cleared sibling', () => {
    // The core contract: seed the daemon state file exactly the way a
    // stop records it (recordChannelsStopped -> the same
    // daemonChannelRuntimeStatePath), then drive the filter. The stopped
    // name must be dropped; a sibling without a record survives.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'telegram',
      'stopped',
    );
    const filter = makeFilter();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram', 'feishu'],
    };

    expect(
      filter(selection, [group(workspace, ['telegram', 'feishu'])]),
    ).toEqual({ mode: 'names', names: ['feishu'] });
  });

  it('keeps a name whose record was cleared (explicit start path)', () => {
    // clearStoppedRecord flips the record to `active` before the recovery
    // reload; the filter must not treat a cleared (non-`stopped`) record
    // as stopped, or an explicit by-name start could never relaunch.
    const store = new ChannelStateStore(
      daemonChannelRuntimeStatePath(workspace),
    );
    store.set('telegram', 'stopped');
    store.set('telegram', 'active');
    const filter = makeFilter();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    expect(filter(selection, [group(workspace, ['telegram'])])).toEqual({
      mode: 'names',
      names: ['telegram'],
    });
  });

  it('returns the same selection object when nothing is filtered', () => {
    // Identity, not just equality: the manager and its callers use the
    // returned object directly; a fresh clone on a no-op filter would be
    // a silent behavior change this suite should notice.
    const filter = makeFilter();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    expect(filter(selection, [group(workspace, ['telegram'])])).toBe(selection);
  });

  it('keeps an ownerless name even if a record exists under the group workspace', () => {
    // The no-owner default is KEEP: a name no group claims has no owning
    // workspace whose record could stop it, and dropping it would turn a
    // transient grouping gap into a silent channel loss. Flipping the
    // default to drop must fail here.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'orphan',
      'stopped',
    );
    const filter = makeFilter();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['orphan', 'telegram'],
    };

    expect(filter(selection, [group(workspace, ['telegram'])])).toBe(selection);
  });

  it('passes mode-all selections through untouched', () => {
    // The mode-`all` worker's OWN restore filter protects all-mode
    // selections; this filter must not second-guess it.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'telegram',
      'stopped',
    );
    const filter = makeFilter();
    const selection: ServeChannelSelection = { mode: 'all' };

    expect(filter(selection, [group(workspace, ['telegram'])])).toBe(selection);
  });

  it('finds the record under a divergent spelling of the same workspace', () => {
    // Canonical derivation: the record is seeded under one spelling and
    // the filter queries under another (dot-segment variant) — both must
    // hit the SAME daemon state file, matching the derivation
    // recordChannelsStopped / clearStoppedRecord use. A split derivation
    // (raw cwd, or the standalone channelRuntimeStatePath) reads a
    // different file and lets the explicitly stopped name through.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'telegram',
      'stopped',
    );
    const filter = makeFilter();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    // Build the divergent spelling WITHOUT normalization: path.join and
    // path.resolve both collapse the dot segment back to the canonical
    // string, which would let a mutation dropping canonicalizeWorkspace
    // read the seeded file and ship green (R15-6).
    expect(filter(selection, [group(`${workspace}/.`, ['telegram'])])).toEqual({
      mode: 'names',
      names: [],
    });
  });

  it('re-reads each owning workspace once per resolve (per-invocation cache, R15-1)', () => {
    // run-qwen-serve creates exactly ONE filter instance for the whole
    // daemon lifetime (memoized ensureChannelWorkerManager), so a
    // factory-scoped cache reads each workspace's state file at most
    // once and makes stopped records written after that first read
    // invisible to every later reload-op — resurrecting an explicitly
    // stopped channel. The cache is per-invocation: same-workspace names
    // coalesce to ONE read within a resolve, and every later resolve
    // re-reads.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'telegram',
      'stopped',
    );
    let reads = 0;
    const filter = createDaemonReloadSelectionFilter({
      canonicalizeWorkspace,
      readRuntimeStates: (canonicalWorkspaceCwd) => {
        reads += 1;
        return new ChannelStateStore(
          daemonChannelRuntimeStatePath(canonicalWorkspaceCwd),
        ).readAll();
      },
    });
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram', 'feishu'],
    };
    const groups = [group(workspace, ['telegram', 'feishu'])];

    expect(filter(selection, groups)).toEqual({
      mode: 'names',
      names: ['feishu'],
    });
    expect(reads).toBe(1);

    // A stopped record written AFTER the first resolve is visible to the
    // NEXT resolve of the SAME instance — the R15-1 contract the
    // factory-scoped cache broke.
    new ChannelStateStore(daemonChannelRuntimeStatePath(workspace)).set(
      'feishu',
      'stopped',
    );
    expect(filter(selection, groups)).toEqual({ mode: 'names', names: [] });
    expect(reads).toBe(2);
  });
});
