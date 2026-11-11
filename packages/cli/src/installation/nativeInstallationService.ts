/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, realpathSync } from 'node:fs';
import {
  copyFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createNativeVersionStore,
  type NativePaths,
} from './nativeVersionStore.js';
import { downloadFile, verifySHA256 } from './update/manifest.js';
import type { ManifestFile } from './update/updateTypes.js';

export type NativeOperation = 'install' | 'update' | 'rollback';
export type NativeStage =
  | 'manifest'
  | 'prepare'
  | 'download'
  | 'checksum'
  | 'extract'
  | 'install'
  | 'marker'
  | 'link'
  | 'cleanup'
  | 'stale'
  | 'temp';
export type NativeBinarySource = 'installed' | 'bootstrap' | 'download';

export interface NativeReleaseSelection {
  readonly version: string;
  getArtifact(): Promise<ManifestFile>;
  readonly reuseLocal: boolean;
  readonly privateUrl?: boolean;
  readonly guard?: {
    assertIdentity(): void;
    assertAuthorized(): void;
    renewBeforeInstall(): Promise<void>;
  };
  readonly record?: { beforeActivate(binaryPath: string): Promise<void> };
}

/** Product selection may return a lazy artifact so rollback can remain offline. */
export interface ReleasePolicy {
  resolve(
    operation: NativeOperation,
    previousUpdate?: PreviousUpdate,
  ): Promise<NativeReleaseSelection>;
  allows(version: string, operation: NativeOperation): boolean;
}

interface PreviousUpdate {
  readonly fromVersion: string;
  readonly toVersion: string;
}

export interface NativeEvent {
  readonly stage: NativeStage;
  readonly phase: 'start' | 'success' | 'failure';
  readonly source?: NativeBinarySource;
  readonly binaryPath?: string;
  readonly artifact?: ManifestFile;
  readonly archiveType?: string;
  readonly method?: 'symlink' | 'copy';
  readonly durationMs?: number;
  readonly bytes?: number;
  readonly error?: unknown;
  readonly versionsRemoved?: number;
  readonly versionsKept?: number;
}

export interface NativeInstallationResult {
  readonly version: string;
  readonly binaryPath: string;
  readonly reused: boolean;
}

export interface NativeInstallOptions {
  readonly sourceMarker: string;
  /** Installer-verified bootstrap; evaluated only when installed-version reuse did not apply. */
  readonly bootstrap?: () => Promise<
    { version: string; binaryPath: string } | undefined
  >;
}

export interface NativeInstallationDependencies {
  readonly paths: NativePaths;
  readonly keepVersions: number;
  readonly policy: ReleasePolicy;
  readonly events?: (event: NativeEvent) => void;
}

export interface NativeInstallationService {
  install(options: NativeInstallOptions): Promise<NativeInstallationResult>;
  update(): Promise<NativeInstallationResult>;
  rollback(options?: { previous?: boolean }): Promise<NativeInstallationResult>;
  /** Installation calls this after product PATH/entry maintenance; cached installs skip it. */
  cleanup(version: string): Promise<void>;
}

/** Explicit instance, finite paths, no dispatcher or product runtime dependency. */
export function createNativeInstallation(
  deps: NativeInstallationDependencies,
): NativeInstallationService {
  const store = createNativeVersionStore(deps.paths);
  const historyPath = join(deps.paths.binDir, 'previous-update.json');
  const emit = (
    stage: NativeStage,
    phase: NativeEvent['phase'],
    facts: Omit<NativeEvent, 'stage' | 'phase'> = {},
  ) => deps.events?.({ stage, phase, ...facts });
  const targetPath = (version: string) =>
    join(
      deps.paths.binDir,
      `${deps.paths.binaryName}-${version}${process.platform === 'win32' ? '.exe' : ''}`,
    );

  function assertAllowed(
    selection: NativeReleaseSelection,
    operation: NativeOperation,
  ) {
    if (!deps.policy.allows(selection.version, operation))
      throw new Error(
        'Installation target is outside the product version line',
      );
    selection.guard?.assertAuthorized();
  }
  async function select(
    operation: NativeOperation,
    previousUpdate?: PreviousUpdate,
  ) {
    emit('manifest', 'start');
    const selection = previousUpdate
      ? await deps.policy.resolve(operation, previousUpdate)
      : await deps.policy.resolve(operation);
    assertAllowed(selection, operation);
    return selection;
  }

  async function clearPreviousUpdate(): Promise<void> {
    await rm(historyPath, { force: true }).catch(() => {});
  }

  async function readPreviousUpdate(
    activeVersion?: string,
  ): Promise<PreviousUpdate | undefined> {
    try {
      const { fromVersion, toVersion } = JSON.parse(
        await readFile(historyPath, 'utf8'),
      ) as Partial<PreviousUpdate>;
      if (
        typeof fromVersion === 'string' &&
        typeof toVersion === 'string' &&
        fromVersion !== toVersion &&
        toVersion === (activeVersion ?? (await store.getActiveVersion()))
      )
        return { fromVersion, toVersion };
    } catch {
      // Missing or invalid history is expected on existing installations.
    }
    return undefined;
  }

  async function activateUpdate(
    selection: NativeReleaseSelection,
    binaryPath: string,
  ): Promise<string | undefined> {
    const previous = await store.getActiveVersion();
    assertAllowed(selection, 'update');
    await store.updateLink(binaryPath, deps.paths.linkPath);
    if (previous === selection.version)
      return (await readPreviousUpdate(previous))?.fromVersion;

    await clearPreviousUpdate();
    if (!previous || !(await store.findLocalVersion(previous)))
      return undefined;

    const temporary = `${historyPath}.tmp.${randomUUID()}`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ fromVersion: previous, toVersion: selection.version }),
        { mode: 0o600 },
      );
      await rename(temporary, historyPath);
      return previous;
    } catch {
      // Rollback history is best effort after the entry has already switched.
      return undefined;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  async function stage<T>(
    name: NativeStage,
    run: () => Promise<T>,
    facts: Omit<NativeEvent, 'stage' | 'phase'> = {},
    resultFacts?: (
      result: T,
    ) =>
      | Omit<NativeEvent, 'stage' | 'phase'>
      | Promise<Omit<NativeEvent, 'stage' | 'phase'>>,
  ): Promise<T> {
    emit(name, 'start', facts);
    const started = Date.now();
    try {
      const result = await run();
      emit(name, 'success', {
        ...facts,
        ...(await resultFacts?.(result)),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      emit(name, 'failure', {
        ...facts,
        durationMs: Date.now() - started,
        bytes: 0,
        error,
      });
      throw error;
    }
  }
  async function size(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  /** Own temporary resources even when checksum, extraction or activation fails. */
  async function withArtifact<T>(
    selection: NativeReleaseSelection,
    operation: NativeOperation,
    consume: (binary: string) => Promise<T>,
  ): Promise<T> {
    const file = await selection.getArtifact();
    const temporary = join(
      tmpdir(),
      `${deps.paths.binaryName}-${operation}-${randomUUID()}`,
    );
    const archivePath = temporary + store.getArchiveExtension(file.url);
    const extractDir = `${temporary}-extract`;
    const facts = { artifact: file };
    assertAllowed(selection, operation);
    let completed = false;
    try {
      await stage(
        'download',
        () =>
          selection.privateUrl
            ? downloadFile(file.url, archivePath, {
                privateUrl: true,
                assertAllowed: () => selection.guard?.assertIdentity(),
              })
            : operation === 'update'
              ? downloadFile(file.url, archivePath, undefined)
              : downloadFile(file.url, archivePath),
        facts,
        async () => ({ bytes: operation === 'update' ? (await stat(archivePath)).size : await size(archivePath) }),
      );
      await stage('checksum', () => verifySHA256(archivePath, file.sha256));
      const binary = await stage(
        'extract',
        async () => {
          await mkdir(extractDir, { recursive: true });
          return store.extractArchive(archivePath, extractDir, file);
        },
        { archiveType: store.getArchiveExtension(file.url).replace(/^\./, '') },
        async (binary) => ({ bytes: await size(binary) }),
      );
      const result = await consume(binary);
      completed = true;
      return result;
    } finally {
      if (operation === 'install' && completed)
        await stage('temp', () => store.cleanupTemp(archivePath, extractDir));
      else await store.cleanupTemp(archivePath, extractDir);
    }
  }

  async function install(
    options: NativeInstallOptions,
  ): Promise<NativeInstallationResult> {
    const selection = await select('install');
    const binaryPath = targetPath(selection.version);
    if (selection.reuseLocal && existsSync(binaryPath)) {
      emit('prepare', 'success', { source: 'installed', binaryPath });
      await selection.record?.beforeActivate(binaryPath);
      assertAllowed(selection, 'install');
      await store.updateLink(binaryPath, deps.paths.linkPath);
      const marker = join(
        deps.paths.binDir,
        `.${deps.paths.binaryName}-install-resource`,
      );
      if (!existsSync(marker))
        await writeFile(marker, `${options.sourceMarker}\n`, { mode: 0o644 });
      await store.writeLocalVersion(selection.version);
      return { version: selection.version, binaryPath, reused: true };
    }
    const bootstrap = await options.bootstrap?.();
    const source =
      bootstrap?.version === selection.version ? 'bootstrap' : 'download';
    emit('prepare', 'success', { source, binaryPath });
    await store.ensureDirectories();
    const place = async (binary: string) => {
      await stage(
        'install',
        async () => {
          await selection.guard?.renewBeforeInstall();
          if (
            !existsSync(binaryPath) ||
            realpathSync(binary) !== realpathSync(binaryPath)
          )
            await store.installVersionBinary(binary, binaryPath);
        },
        { binaryPath },
        async () => ({ bytes: await size(binaryPath) }),
      );
      await stage('marker', () =>
        writeFile(
          join(deps.paths.binDir, `.${deps.paths.binaryName}-install-resource`),
          `${options.sourceMarker}\n`,
          { mode: 0o644 },
        ),
      );
      await store.writeLocalVersion(selection.version);
      await selection.record?.beforeActivate(binaryPath);
      let method: 'symlink' | 'copy' = 'symlink';
      await stage(
        'link',
        async () => {
          assertAllowed(selection, 'install');
          try {
            await store.updateLink(binaryPath, deps.paths.linkPath);
          } catch {
            method = 'copy';
            await copyFile(binaryPath, deps.paths.linkPath);
            await chmod(deps.paths.linkPath, 0o755);
          }
          await clearPreviousUpdate();
        },
        {},
        () => ({ method }),
      );
      return { version: selection.version, binaryPath, reused: false };
    };
    return source === 'bootstrap'
      ? place(bootstrap!.binaryPath)
      : withArtifact(selection, 'install', place);
  }

  async function update(): Promise<NativeInstallationResult> {
    await store.ensureDirectories();
    const selection = await select('update');
    const binaryPath = targetPath(selection.version);
    if (selection.reuseLocal && existsSync(binaryPath)) {
      emit('link', 'start');
      await selection.record?.beforeActivate(binaryPath);
      await activateUpdate(selection, binaryPath);
      await store.writeLocalVersion(selection.version);
      return { version: selection.version, binaryPath, reused: true };
    }
    return withArtifact(selection, 'update', async (binary) => {
      emit('install', 'start');
      await selection.guard?.renewBeforeInstall();
      await store.installVersionBinary(binary, binaryPath);
      await selection.record?.beforeActivate(binaryPath);
      emit('link', 'start');
      const previousVersion = await activateUpdate(selection, binaryPath);
      await store.writeLocalVersion(selection.version);
      try {
        const current = dirname(realpathSync(process.execPath));
        if (current !== deps.paths.binDir)
          await store.copyInstallMarker(current, deps.paths.binDir);
      } catch {
        /* best-effort marker propagation */
      }
      emit('cleanup', 'start');
      await store.cleanupOldVersions(
        deps.paths.binDir,
        deps.keepVersions,
        selection.version,
        previousVersion,
      );
      return { version: selection.version, binaryPath, reused: false };
    });
  }

  async function rollback(options?: {
    previous?: boolean;
  }): Promise<NativeInstallationResult> {
    const previous = options?.previous ? await readPreviousUpdate() : undefined;
    const noPrevious =
      'No previous local version is available. Specify a version with --to.';
    if (
      options?.previous &&
      (!previous || !deps.policy.allows(previous.fromVersion, 'rollback'))
    )
      throw new Error(noPrevious);
    const selection = await select('rollback', previous);
    if (previous && selection.version !== previous.fromVersion)
      throw new Error(noPrevious);
    const local = selection.reuseLocal
      ? await store.findLocalVersion(selection.version)
      : null;
    if (previous && !local) throw new Error(noPrevious);
    const binaryPath = local ?? targetPath(selection.version);
    if (local) {
      emit('prepare', 'success', { source: 'installed', binaryPath });
      await selection.record?.beforeActivate(binaryPath);
      assertAllowed(selection, 'rollback');
      await store.updateLink(binaryPath, deps.paths.linkPath);
      await clearPreviousUpdate();
      return { version: selection.version, binaryPath, reused: true };
    }
    await store.ensureDirectories();
    return withArtifact(selection, 'rollback', async (binary) => {
      await selection.guard?.renewBeforeInstall();
      await store.installVersionBinary(binary, binaryPath);
      await selection.record?.beforeActivate(binaryPath);
      assertAllowed(selection, 'rollback');
      await store.updateLink(binaryPath, deps.paths.linkPath);
      await clearPreviousUpdate();
      return { version: selection.version, binaryPath, reused: false };
    });
  }

  async function cleanup(version: string): Promise<void> {
    if (!deps.policy.allows(version, 'install'))
      throw new Error(
        'Installation target is outside the product version line',
      );
    const entries = async () => {
      try {
        return await readdir(deps.paths.binDir);
      } catch {
        return [];
      }
    };
    const count = (files: string[]) =>
      files.filter(
        (f) =>
          f.startsWith(`${deps.paths.binaryName}-`) && !f.includes('.tmp.'),
      ).length;
    const before = count(await entries());
    const remaining = await stage(
      'cleanup',
      async () => {
        await store.cleanupOldVersions(
          deps.paths.binDir,
          deps.keepVersions,
          version,
        );
        return entries();
      },
      {},
      (files) => ({
        versionsRemoved: before - count(files),
        versionsKept: count(files),
      }),
    );
    await stage('stale', async () => {
      for (const entry of remaining) {
        if (entry.includes('.tmp.') || entry.startsWith('.old.'))
          await rm(join(deps.paths.binDir, entry), { force: true }).catch(
            () => {},
          );
      }
    });
  }

  return {
    install,
    update,
    rollback,
    cleanup,
  };
}
