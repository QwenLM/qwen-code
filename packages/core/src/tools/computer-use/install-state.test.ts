import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadInstallState,
  saveInstallState,
  isPackageSpecApproved,
  installStatePathFor,
} from './install-state.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

describe('install-state', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(pathJoin(tmpdir(), 'qwen-cu-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns undefined when no state file exists', async () => {
    expect(await loadInstallState(tmpHome)).toBeUndefined();
  });

  it('round-trips state', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    const loaded = await loadInstallState(tmpHome);
    expect(loaded).toEqual({
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
  });

  it('isPackageSpecApproved returns false when no state', async () => {
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.3.0'),
    ).toBe(false);
  });

  it('isPackageSpecApproved returns true on exact match', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.3.0'),
    ).toBe(true);
  });

  it('isPackageSpecApproved returns false when version differs', async () => {
    await saveInstallState(tmpHome, {
      approvedPackageSpec: 'open-computer-use@^0.3.0',
      approvedAtIso: '2026-05-28T10:00:00Z',
    });
    expect(
      await isPackageSpecApproved(tmpHome, 'open-computer-use@^0.4.0'),
    ).toBe(false);
  });

  it('installStatePathFor returns correct path', () => {
    const path = installStatePathFor(tmpHome);
    expect(path).toBe(
      pathJoin(tmpHome, '.qwen', 'computer-use', 'installed.json'),
    );
  });
});
