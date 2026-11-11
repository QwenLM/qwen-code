/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import {
  createBestEffortNonInteractiveCommandService,
  createNonInteractiveCommandService,
} from './nonInteractiveCliCommands.js';
import {
  buildSdkCommandSnapshot,
  buildSdkSkillSnapshot,
  SdkCommandCatalogPublisher,
} from './sdkCommandCatalog.js';

vi.mock('@qwen-code/core', () => ({
  isAbortError: () => false,
  runLogger: { warn: vi.fn() },
}));

vi.mock('./nonInteractiveCliCommands.js', () => ({
  createBestEffortNonInteractiveCommandService: vi.fn(),
  createNonInteractiveCommandService: vi.fn(),
}));

describe('buildSdkCommandSnapshot', () => {
  it('projects visible commands and filters hidden commands', async () => {
    vi.mocked(createNonInteractiveCommandService).mockResolvedValue({
      getCommands: () => [
        { name: 'help', description: 'Show help', argumentHint: '' },
        {
          name: 'secret',
          description: 'Hidden command',
          argumentHint: '',
          hidden: true,
        },
      ],
    } as never);

    await expect(
      buildSdkCommandSnapshot({} as Config),
    ).resolves.toEqual([
      { name: 'help', description: 'Show help', argumentHint: '' },
    ]);
  });
});

describe('buildSdkSkillSnapshot', () => {
  it('projects only displayable skills allowed for the main session', () => {
    const config = {
      isSkillsSupportEnabled: () => true,
      getSkillManager: () => ({
        isAdminEnabled: () => true,
        getDisplayableSkills: () => [
          {
            name: 'review',
            description: 'Review code',
            argumentHint: '[path]',
            kind: 'skill',
          },
          {
            name: 'plugin-command',
            description: 'Plugin command',
            kind: 'plugin-command',
          },
          {
            name: 'hidden-by-setting',
            description: 'Hidden skill',
            kind: 'skill',
          },
          {
            name: 'hidden-by-allowlist',
            description: 'Skill outside the session allowlist',
            kind: 'skill',
          },
        ],
        getSkillVisibilityOverride: (name: string) =>
          name === 'hidden-by-setting' ? 'off' : undefined,
        isSkillAllowedForMainSession: (name: string) =>
          name !== 'hidden-by-allowlist',
      }),
    } as unknown as Config;

    expect(buildSdkSkillSnapshot(config)).toEqual([
      { name: 'review', description: 'Review code', argumentHint: '[path]' },
    ]);
  });
});

describe('SdkCommandCatalogPublisher', () => {
  it('reconciles a command change that races with initialization', async () => {
    const publish = vi.fn();
    const changed = [
      { name: 'review', description: 'Review code', argumentHint: '' },
    ];
    const publisher = new SdkCommandCatalogPublisher(
      vi.fn().mockResolvedValue(changed),
      publish,
    );

    publisher.start([
      { name: 'help', description: 'Show help', argumentHint: '' },
    ]);
    await publisher.drain();

    expect(publish).toHaveBeenCalledWith(changed);
  });

  it('serializes refreshes and suppresses identical command snapshots', async () => {
    const publish = vi.fn();
    const changed = [
      { name: 'review', description: 'Review code', argumentHint: '' },
    ];
    const load = vi.fn().mockResolvedValue(changed);
    const publisher = new SdkCommandCatalogPublisher(load, publish);

    publisher.start([
      { name: 'help', description: 'Show help', argumentHint: '' },
    ]);
    publisher.notify();
    publisher.notify();
    await publisher.drain();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(changed);
  });

  it('does not publish a snapshot that finishes loading after disposal', async () => {
    const publish = vi.fn();
    let resolveLoad!: (
      commands: { name: string; description: string; argumentHint: string }[],
    ) => void;
    const load = vi.fn(
      () =>
        new Promise<
          { name: string; description: string; argumentHint: string }[]
        >((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const publisher = new SdkCommandCatalogPublisher(load, publish);

    publisher.start([
      { name: 'help', description: 'Show help', argumentHint: '' },
    ]);
    await Promise.resolve();
    publisher.dispose();
    resolveLoad([
      { name: 'review', description: 'Review code', argumentHint: '' },
    ]);
    await publisher.drain();

    expect(publish).not.toHaveBeenCalled();
  });
});

void createBestEffortNonInteractiveCommandService;
