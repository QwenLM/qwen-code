/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { DaemonTrustPolicySnapshot } from '../config/daemon-trust-policy.js';
import { TrustLevel } from '../config/trustedFolders.js';
import {
  createWorkflowAncestorTrustHandler,
  type PublishedTrustPolicy,
} from './workflow-ancestor-trust.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';

const repo = path.resolve('/srv/repo');
const packages = path.join(repo, 'packages');
const target = path.join(packages, 'a');

const snapshot = (
  revision: string,
  trustedFolders: Record<string, TrustLevel>,
): DaemonTrustPolicySnapshot => ({
  revision,
  folderTrustEnabled: true,
  ideTrust: undefined,
  trustedFolders,
});

const withRoot = snapshot('r1', {
  [target]: TrustLevel.TRUST_FOLDER,
  [repo]: TrustLevel.TRUST_FOLDER,
});
const withoutRoot = snapshot('r2', { [target]: TrustLevel.TRUST_FOLDER });

describe('createWorkflowAncestorTrustHandler', () => {
  it('applies an ancestor-only revoke and restore as soon as it is published', async () => {
    let published: PublishedTrustPolicy = {
      publications: 0,
      snapshot: withRoot,
    };
    const handler = createWorkflowAncestorTrustHandler({
      generationGuard: createWorkspaceGenerationGuard(),
      admissionSnapshot: withRoot,
      getPublished: () => published,
    });
    await expect(handler([packages, repo])).resolves.toEqual([true, true]);
    published = { publications: 1, snapshot: withoutRoot };
    await expect(handler([packages, repo])).resolves.toEqual([false, false]);
    published = { publications: 2, snapshot: withRoot };
    await expect(handler([packages, repo])).resolves.toEqual([true, true]);
  });

  it('keeps a newer admission snapshot over an older published one', async () => {
    // A runtime built from a fresh read, before the monitor published it.
    const handler = createWorkflowAncestorTrustHandler({
      generationGuard: createWorkspaceGenerationGuard(),
      admissionSnapshot: withoutRoot,
      getPublished: () => ({ publications: 3, snapshot: withRoot }),
    });
    await expect(handler([repo])).resolves.toEqual([false]);
  });

  it('refuses once the runtime generation closes', async () => {
    const guard = createWorkspaceGenerationGuard();
    const handler = createWorkflowAncestorTrustHandler({
      generationGuard: guard,
      admissionSnapshot: withRoot,
      getPublished: () => ({ publications: 0, snapshot: withRoot }),
    });
    guard.close();
    await expect(handler([repo])).rejects.toThrow();
  });

  it('judges each runtime by its own snapshot', async () => {
    const other = snapshot('r1', {});
    const published = () => ({ publications: 0, snapshot: withRoot });
    const primary = createWorkflowAncestorTrustHandler({
      generationGuard: createWorkspaceGenerationGuard(),
      admissionSnapshot: withRoot,
      getPublished: published,
    });
    const secondary = createWorkflowAncestorTrustHandler({
      generationGuard: createWorkspaceGenerationGuard(),
      admissionSnapshot: other,
      getPublished: published,
    });
    await expect(primary([repo])).resolves.toEqual([true]);
    await expect(secondary([repo])).resolves.toEqual([false]);
  });
});
