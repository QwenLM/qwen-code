/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI slash-command registry against the ORIGINAL sources:
 *  - every dialog kind an original command can return is routed (the full
 *    `OpenDialogActionReturn['dialog']` union), matching the ink actions
 *  - the built-in route table covers exactly the commands registered by
 *    services/BuiltinCommandLoader.ts — names, aliases, and gates checked
 *    against the real loader output and command objects.
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { OpenDialogActionReturn } from '../commands/types.js';
import {
  commandRouteFor,
  OPEN_TUI_COMMAND_ROUTES,
  routeDialogToOpenTui,
  type InkDialogKind,
} from './commands-registry.js';
import { loadInteractiveCommands } from './slash-dispatch.js';

/**
 * Config stub with every BuiltinCommandLoader gate ON plus the checkpointing
 * flag the /restore factory needs — loading through it registers every
 * built-in command, so the route table can be checked by set equality
 * against the real loader output instead of a hand-maintained gate list.
 */
function createAllGatesOnConfig(): Config {
  return {
    initialize: async () => {},
    getDisabledSlashCommands: () => [],
    setModelInvocableCommandsProvider: () => {},
    setModelInvocableCommandsExecutor: () => {},
    getBareMode: () => true,
    isWorkflowsEnabled: () => true,
    isManagedMemoryAvailable: () => true,
    getFolderTrust: () => true,
    getFolderTrustFeature: () => true,
    getFileCheckpointingEnabled: () => true,
    isLspEnabled: () => true,
    isCronEnabled: () => false,
    getMcpServers: () => ({}),
    getSkillManager: () => undefined,
    getDisabledSkillNames: () => new Set<string>(),
    getPermissionManager: () => undefined,
    getModel: () => undefined,
    getCliVersion: () => undefined,
    getProjectRoot: () => '/nonexistent-opentui-test-root',
  } as unknown as Config;
}

/** Every dialog kind from ui/commands/types.ts (checked exhaustively). */
const ALL_DIALOG_KINDS: readonly InkDialogKind[] = [
  'help',
  'arena_start',
  'arena_select',
  'arena_stop',
  'arena_status',
  'auth',
  'theme',
  'editor',
  'settings',
  'statusline',
  'memory',
  'model',
  'fast-model',
  'voice-model',
  'vision-model',
  'compaction-model',
  'image-model',
  'subagent_create',
  'subagent_list',
  'skills_manage',
  'trust',
  'permissions',
  'approval-mode',
  'effort',
  'resume',
  'delete',
  'branch',
  'extensions_manage',
  'hooks',
  'mcp',
  'rewind',
  'diff',
  'stats',
];

describe('routeDialogToOpenTui (ink dialog-switch parity)', () => {
  it('routes every dialog kind; none falls through to the error case', () => {
    // 'branch' is the one exception: a host action both renderers intercept
    // before routing (asserted separately below).
    const routable = ALL_DIALOG_KINDS.filter((d) => d !== 'branch');
    expect(routable).toHaveLength(ALL_DIALOG_KINDS.length - 1);
    for (const dialog of routable) {
      const request = routeDialogToOpenTui({
        type: 'dialog',
        dialog,
      } as OpenDialogActionReturn);
      expect(request).toBeTruthy();
      expect(request.dialog).toBeTruthy();
    }
  });

  it("throws on 'branch' — a host action that must never route to a dialog", () => {
    // If commands-dispatch ever drops its handleBranch interception, this
    // loud failure replaces a silently unrenderable dialog request.
    expect(() =>
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'branch',
        name: 'wip',
      } as OpenDialogActionReturn),
    ).toThrow(/host action/);
  });

  it('maps each dialog kind onto its exact OpenTUI target', () => {
    // Pins the mapping itself, not just its existence: mis-routing one
    // dialog onto another (e.g. theme → settings) must fail here.
    const targets: Array<[InkDialogKind, string]> = [
      ['help', 'help'],
      ['theme', 'theme'],
      ['editor', 'editor'],
      ['settings', 'settings'],
      ['statusline', 'statusline'],
      ['memory', 'memory'],
      ['auth', 'auth'],
      ['trust', 'trust'],
      ['permissions', 'permissions'],
      ['approval-mode', 'approval-mode'],
      ['effort', 'effort'],
      ['delete', 'delete'],
      ['resume', 'resume'],
      ['extensions_manage', 'extensions_manage'],
      ['hooks', 'hooks'],
      ['mcp', 'mcp'],
      ['rewind', 'rewind'],
      ['diff', 'diff'],
      ['stats', 'stats'],
    ];
    for (const [dialog, target] of targets) {
      expect(
        routeDialogToOpenTui({
          type: 'dialog',
          dialog,
        } as OpenDialogActionReturn),
      ).toEqual({ dialog: target });
    }
  });

  it('maps the model family onto the model dialog with the ink mode', () => {
    const cases: Array<[InkDialogKind, string]> = [
      ['model', 'primary'],
      ['fast-model', 'fast'],
      ['voice-model', 'voice'],
      ['vision-model', 'vision'],
      ['compaction-model', 'compaction'],
      ['image-model', 'image'],
    ];
    for (const [dialog, mode] of cases) {
      const request = routeDialogToOpenTui({
        type: 'dialog',
        dialog,
      } as OpenDialogActionReturn);
      expect(request).toEqual({ dialog: 'model', mode });
    }
  });

  it('carries persistScope for the model dialogs like openModelDialog', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'model',
        persistScope: 'workspace',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'model', mode: 'primary', persistScope: 'workspace' });
  });

  it('maps the arena dialogs onto the arena dialog modes', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_start',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'start' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_select',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'select' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_stop',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'stop' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_status',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'status' });
  });

  it('keeps resume matchedSessions payloads', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'resume',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'resume' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'resume',
        matchedSessions: [],
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'resume', matchedSessions: [] });
  });
});

describe('OPEN_TUI_COMMAND_ROUTES (built-in registry parity)', () => {
  it('has unique canonical names with no duplicate routes', () => {
    const names = OPEN_TUI_COMMAND_ROUTES.map((route) => route.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers exactly the commands the original loader registers', async () => {
    // Load with every gate ON plus the checkpointing flag the /restore
    // factory needs: every built-in registers, so route table and loader
    // output must be equal as sets — no hand-maintained gate list, no
    // escape hatches.
    const loaded = await loadInteractiveCommands(createAllGatesOnConfig());
    const builtins = loaded.filter((cmd) => cmd.source === 'builtin-command');
    expect(builtins.length).toBeGreaterThan(0);

    const loadedNames = new Set(builtins.map((cmd) => cmd.name));
    const routeNames = new Set(OPEN_TUI_COMMAND_ROUTES.map((r) => r.name));

    for (const name of loadedNames) {
      expect(routeNames.has(name), `missing route for /${name}`).toBe(true);
    }
    for (const name of routeNames) {
      expect(
        loadedNames.has(name),
        `route /${name} is not a registered built-in`,
      ).toBe(true);
    }
    expect(routeNames.has('restore')).toBe(true);
  }, 30000);

  it('gated routes are genuinely gated — absent from a gates-off load', async () => {
    // A route claiming gatedBy must NOT register when the gates are off;
    // a bogus gate on an always-registered command fails here because that
    // command IS present in the null-config load.
    const off = await loadInteractiveCommands(null);
    const offNames = new Set(
      off.filter((cmd) => cmd.source === 'builtin-command').map((c) => c.name),
    );
    const gatedRoutes = OPEN_TUI_COMMAND_ROUTES.filter((r) => r.gatedBy);
    expect(gatedRoutes.length).toBeGreaterThan(0);
    for (const route of gatedRoutes) {
      expect(
        offNames.has(route.name),
        `/${route.name} declares gatedBy but registers with gates off`,
      ).toBe(false);
    }
  }, 30000);

  it('matches the config-built /restore factory command', async () => {
    const { restoreCommand } = await import('../commands/restoreCommand.js');
    const config = {
      getFileCheckpointingEnabled: () => true,
    } as never;
    const restored = restoreCommand(config);
    expect(restored).not.toBeNull();
    const route = commandRouteFor(restored?.name ?? '');
    expect(restored?.name).toBe('restore');
    expect(route, 'no route for /restore').toBeTruthy();
    expect([...(route?.altNames ?? [])].sort()).toEqual(
      [...(restored?.altNames ?? [])].sort(),
    );
  });

  it('matches the real commands’ aliases', async () => {
    const loaded = await loadInteractiveCommands(createAllGatesOnConfig());
    const builtins = loaded.filter((cmd) => cmd.source === 'builtin-command');
    for (const cmd of builtins) {
      const route = commandRouteFor(cmd.name);
      expect(route, `no route for /${cmd.name}`).toBeTruthy();
      expect([...(route?.altNames ?? [])].sort()).toEqual(
        [...(cmd.altNames ?? [])].sort(),
      );
    }
  }, 30000);

  it('only lists dialog kinds that exist in the original union', () => {
    const known = new Set<string>(ALL_DIALOG_KINDS);
    for (const route of OPEN_TUI_COMMAND_ROUTES) {
      for (const dialog of route.dialogs ?? []) {
        expect(known.has(dialog)).toBe(true);
      }
    }
  });

  it('every command that opens a dialog declares the dialog result kind', () => {
    const dialogRoutes = OPEN_TUI_COMMAND_ROUTES.filter(
      (route) => (route.dialogs?.length ?? 0) > 0,
    );
    expect(dialogRoutes.length).toBeGreaterThan(0);
    for (const route of dialogRoutes) {
      expect(route.results).toContain('dialog');
    }
  });

  it('spot-checks the headline commands from the parity list', () => {
    const expectations: Array<[string, readonly string[]]> = [
      ['help', ['dialog']],
      ['clear', ['message']],
      ['quit', ['quit', 'agent_view_detach']],
      ['config', ['message']],
      ['theme', ['dialog', 'message']],
      ['model', ['dialog', 'message', 'submit_prompt']],
      ['auth', ['dialog', 'message']],
      ['permissions', ['dialog']],
      ['compress', ['message', 'stream_messages']],
      ['context', ['message']],
      ['memory', ['dialog']],
      ['resume', ['dialog', 'message']],
      ['rewind', ['dialog']],
      ['fork', ['message']],
      ['diff', ['dialog', 'message']],
      ['export', ['message']],
      ['copy', ['message']],
      ['stats', ['dialog', 'message']],
      ['doctor', ['message']],
      ['skills', ['dialog', 'message']],
      ['extensions', ['dialog', 'message']],
      ['mcp', ['dialog', 'message']],
      ['plan', ['message', 'submit_prompt']],
      ['effort', ['dialog', 'message']],
      ['language', ['message']],
      ['vim', ['message']],
      ['settings', ['dialog']],
      ['history', ['message']],
      ['restore', ['message', 'tool']],
      ['setup-github', ['tool']],
      ['goal', ['goal_control', 'message', 'submit_prompt']],
      ['cd', ['confirm_action', 'message']],
      ['init', ['confirm_action', 'message', 'submit_prompt']],
    ];
    for (const [name, results] of expectations) {
      const route = commandRouteFor(name);
      expect(route, `no route for /${name}`).toBeTruthy();
      expect([...(route?.results ?? [])].sort()).toEqual([...results].sort());
    }
  });
});
