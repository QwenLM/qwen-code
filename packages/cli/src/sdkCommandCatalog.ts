/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type SlashCommand as SDKSlashCommand,
  isAbortError,
  runLogger,
} from '@qwen-code/core';
import {
  createBestEffortNonInteractiveCommandService,
  createNonInteractiveCommandService,
} from './nonInteractiveCliCommands.js';

const COMMAND_CATALOG_STARTUP_WAIT_MS = 5000;

function commandCatalogStartupSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(COMMAND_CATALOG_STARTUP_WAIT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function createCommandServiceForProtocolMetadata(
  config: Config,
  signal?: AbortSignal,
) {
  try {
    return await createNonInteractiveCommandService(
      config,
      commandCatalogStartupSignal(signal),
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (isAbortError(error)) {
      runLogger.warn(
        `[sdk-commands] Command catalog startup wait timed out after ${COMMAND_CATALOG_STARTUP_WAIT_MS}ms; using currently available commands.`,
      );
    } else {
      runLogger.warn(
        '[sdk-commands] Command catalog startup readiness failed; using currently available commands:',
        error,
      );
    }
    return createBestEffortNonInteractiveCommandService(
      config,
      signal ?? new AbortController().signal,
    );
  }
}

export async function buildSdkCommandSnapshot(
  config: Config,
  signal?: AbortSignal,
): Promise<SDKSlashCommand[]> {
  const service = await createCommandServiceForProtocolMetadata(config, signal);
  return service
    .getCommands()
    .filter((command) => command.hidden !== true)
    .map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint ?? '',
    }));
}

export function buildSdkSkillSnapshot(config: Config): SDKSlashCommand[] {
  if (!config.isSkillsSupportEnabled()) return [];
  const manager = config.getSkillManager();
  if (!manager.isAdminEnabled()) return [];

  return manager
    .getDisplayableSkills()
    .filter(
      (skill) =>
        skill.kind !== 'plugin-command' &&
        manager.getSkillVisibilityOverride(skill.name) !== 'off' &&
        manager.isSkillAllowedForMainSession(skill.name),
    )
    .map((skill) => ({
      name: skill.name,
      description: skill.description || `Activate the ${skill.name} skill`,
      argumentHint: skill.argumentHint ?? '',
    }));
}

export function fingerprintSdkCommands(
  commands: readonly SDKSlashCommand[],
): string {
  return JSON.stringify(commands);
}

export class SdkCommandCatalogPublisher {
  private started = false;
  private disposed = false;
  private lastFingerprint: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly load: () => Promise<SDKSlashCommand[]>,
    private readonly publish: (commands: SDKSlashCommand[]) => void,
  ) {}

  start(initialCommands: readonly SDKSlashCommand[]): void {
    this.lastFingerprint = fingerprintSdkCommands(initialCommands);
    this.started = true;
    // Reconcile once after the initialize response has seeded the snapshot.
    // This closes the race where a runtime change lands while initialization
    // is constructing its command catalog, without emitting when unchanged.
    this.notify();
  }

  notify(): void {
    if (!this.started || this.disposed) return;
    this.chain = this.chain
      .then(async () => {
        if (this.disposed) return;
        const commands = await this.load();
        if (this.disposed) return;
        const fingerprint = fingerprintSdkCommands(commands);
        if (fingerprint === this.lastFingerprint) return;
        this.publish(commands);
        this.lastFingerprint = fingerprint;
      })
      .catch((error: unknown) => {
        runLogger.warn(
          '[sdk-commands] command snapshot publication failed:',
          error,
        );
      });
  }

  async drain(): Promise<void> {
    await this.chain;
  }

  dispose(): void {
    this.disposed = true;
  }
}
