/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Skills enable/disable dialog (`/skills manage`).
 *
 * Two key invariants worth knowing before editing:
 *
 *   1. The MultiSelect at the top of the dialog renders ONLY unlocked
 *      skills (skills that the workspace can actually toggle). Skills
 *      disabled at a higher scope (systemDefaults / user / system) are
 *      rendered as a separate "locked" section because the existing
 *      MultiSelect renders `[x]` for any item with `disabled: true`,
 *      which would visually flip the meaning under our checked = enabled
 *      semantic.
 *
 *   2. On confirm, locked names are NEVER re-emitted into the workspace
 *      `skills.disabled` write (Option A in the plan). The workspace
 *      entry would be redundant — the higher scope already disables it —
 *      and keeping a clean settings file matches what the user sees in
 *      the dialog (locked rows can't be toggled here at all).
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  Config,
  SkillConfig,
  SkillLevel,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../../config/settings.js';
import { SettingScope } from '../../../config/settings.js';
import type { UseHistoryManagerReturn } from '../../hooks/useHistoryManager.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { theme } from '../../semantic-colors.js';
import { MessageType } from '../../types.js';
import { MultiSelect, type MultiSelectItem } from '../shared/MultiSelect.js';

interface SkillsManagerDialogProps {
  settings: LoadedSettings;
  config: Config | null;
  addItem: UseHistoryManagerReturn['addItem'];
  onClose: () => void;
  reloadCommands: () => void | Promise<void>;
  availableTerminalHeight?: number;
}

interface SkillItemValue {
  name: string;
  description: string;
  level: SkillLevel;
}

const LEVEL_ORDER: Record<SkillLevel, number> = {
  project: 0,
  user: 1,
  extension: 2,
  bundled: 3,
};

const LEVEL_LABEL: Record<SkillLevel, string> = {
  project: 'Project',
  user: 'User',
  extension: 'Extension',
  bundled: 'Bundled',
};

const NAME_COLUMN = 24;

function lower(name: string): string {
  return name.toLowerCase();
}

function namesFromScope(
  settings: LoadedSettings,
  scope: SettingScope,
): string[] {
  return settings.forScope(scope).settings.skills?.disabled ?? [];
}

function buildHigherDisabled(settings: LoadedSettings): {
  set: ReadonlySet<string>;
  scopeOf: (name: string) => string | null;
} {
  const sysDefaults = namesFromScope(settings, SettingScope.SystemDefaults);
  const user = namesFromScope(settings, SettingScope.User);
  const system = namesFromScope(settings, SettingScope.System);
  const set = new Set([...sysDefaults, ...user, ...system].map(lower));
  // Highest-precedence scope wins for the locked-row label. System >
  // User > SystemDefaults matches the merge order in `settings.ts`.
  const scopeOf = (name: string): string | null => {
    const l = lower(name);
    if (system.some((n) => lower(n) === l)) return 'System';
    if (user.some((n) => lower(n) === l)) return 'User';
    if (sysDefaults.some((n) => lower(n) === l)) return 'SystemDefaults';
    return null;
  };
  return { set, scopeOf };
}

function sortSkills(skills: SkillConfig[]): SkillConfig[] {
  return [...skills].sort(
    (a, b) =>
      LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
      a.name.localeCompare(b.name),
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function SkillsManagerDialog({
  settings,
  config,
  addItem,
  onClose,
  reloadCommands,
  availableTerminalHeight,
}: SkillsManagerDialogProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillConfig[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Capture the workspace and higher-scope disabled lists once at mount.
  // The dialog is short-lived and these are derived from the *current*
  // settings snapshot at open time — using `useMemo` keyed on `settings`
  // would re-derive on every parent re-render and could thrash the
  // `selectedKeys` derivation below.
  const initialWorkspaceDisabled = useMemo(
    () => new Set(namesFromScope(settings, SettingScope.Workspace).map(lower)),
    [settings],
  );
  const higher = useMemo(() => buildHigherDisabled(settings), [settings]);

  const skillManager = config?.getSkillManager() ?? null;

  useEffect(() => {
    if (!skillManager) {
      setLoadError('SkillManager not available.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await skillManager.listSkills();
        if (!cancelled) setSkills(sortSkills(list));
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skillManager]);

  // Memoize so the `?? []` fallback doesn't produce a fresh array on every
  // render — that would invalidate every downstream useMemo dependency.
  const allSkills = useMemo(() => skills ?? [], [skills]);
  const lockedSkills = useMemo(
    () => allSkills.filter((s) => higher.set.has(lower(s.name))),
    [allSkills, higher.set],
  );
  const unlockedSkills = useMemo(
    () => allSkills.filter((s) => !higher.set.has(lower(s.name))),
    [allSkills, higher.set],
  );

  // Initial selection: every unlocked skill that the workspace has NOT
  // disabled. Checked = enabled.
  const [selectedKeys, setSelectedKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (selectedKeys !== null || unlockedSkills.length === 0) return;
    const initial = unlockedSkills
      .filter((s) => !initialWorkspaceDisabled.has(lower(s.name)))
      .map((s) => s.name);
    setSelectedKeys(initial);
  }, [unlockedSkills, initialWorkspaceDisabled, selectedKeys]);

  const filteredUnlocked = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return unlockedSkills;
    return unlockedSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(normalizedQuery) ||
        s.description.toLowerCase().includes(normalizedQuery),
    );
  }, [unlockedSkills, query]);

  const filteredLocked = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return lockedSkills;
    return lockedSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(normalizedQuery) ||
        s.description.toLowerCase().includes(normalizedQuery),
    );
  }, [lockedSkills, query]);

  const items = useMemo<Array<MultiSelectItem<SkillItemValue>>>(
    () =>
      filteredUnlocked.map((s) => ({
        key: s.name,
        value: { name: s.name, description: s.description, level: s.level },
        label: `${truncate(s.name, NAME_COLUMN).padEnd(NAME_COLUMN)} ${truncate(
          s.description,
          80,
        )}  (${LEVEL_LABEL[s.level]})`,
      })),
    [filteredUnlocked],
  );

  const handleConfirm = useCallback(async () => {
    if (!settings.isTrusted) {
      addItem(
        {
          type: MessageType.ERROR,
          text:
            'Workspace is untrusted; workspace settings are ignored by the ' +
            'merged config. Run /trust first to persist skills changes here, ' +
            'or edit ~/.qwen/settings.json directly to manage skills at user ' +
            'scope.',
        },
        Date.now(),
      );
      onClose();
      return;
    }

    const selected = new Set(selectedKeys ?? []);
    // workspace disabled = unlocked skills NOT in the selection.
    // Locked names are intentionally excluded so we don't write redundant
    // entries the higher scope is already enforcing.
    const previousWorkspace = namesFromScope(settings, SettingScope.Workspace);
    const previousMap = new Map(previousWorkspace.map((n) => [lower(n), n]));
    const nextDisabled: string[] = [];
    for (const s of unlockedSkills) {
      if (selected.has(s.name)) continue;
      // Preserve original casing if the entry already existed; otherwise
      // store the canonical skill name (loader-supplied).
      const existing = previousMap.get(lower(s.name));
      nextDisabled.push(existing ?? s.name);
    }

    settings.setValue(
      SettingScope.Workspace,
      'skills.disabled',
      nextDisabled.length > 0 ? nextDisabled : undefined,
    );

    try {
      // ORDER MATTERS — must NOT be Promise.all. See `refreshAfterChange`
      // in `skillsCommand.ts` for the full rationale: `reloadCommands`
      // rebuilds CommandService AND re-registers the
      // `modelInvocableCommandsProvider` closure over the new instance;
      // `notifyConfigChanged` triggers `SkillTool.refreshSkills` which
      // calls that provider. Running them in parallel can let the model
      // description pick up the OLD provider, leaking the just-disabled
      // skill back into `<available_skills>` as a command-form entry.
      await reloadCommands();
      if (skillManager) {
        await skillManager.notifyConfigChanged();
      }
    } catch (e) {
      addItem(
        {
          type: MessageType.WARNING,
          text: `Skills configuration saved, but refresh failed: ${
            e instanceof Error ? e.message : String(e)
          }. Restart to ensure the new state is applied.`,
        },
        Date.now(),
      );
      onClose();
      return;
    }

    addItem(
      {
        type: MessageType.INFO,
        text:
          nextDisabled.length === 0
            ? 'All skills are enabled at workspace scope.'
            : `Disabled at workspace scope: ${nextDisabled.join(', ')}`,
      },
      Date.now(),
    );
    onClose();
  }, [
    addItem,
    onClose,
    reloadCommands,
    selectedKeys,
    settings,
    skillManager,
    unlockedSkills,
  ]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (query) {
          setQuery('');
          return;
        }
        onClose();
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        setQuery((current) => current.slice(0, -1));
        return;
      }

      // Defer navigation/selection keys to MultiSelect.
      if (
        key.name === 'j' ||
        key.name === 'k' ||
        key.name === 'up' ||
        key.name === 'down' ||
        key.name === 'space' ||
        key.name === 'return'
      ) {
        return;
      }

      if (
        !key.ctrl &&
        !key.meta &&
        key.sequence.length === 1 &&
        key.sequence >= '!' &&
        key.sequence <= '~'
      ) {
        setQuery((current) => `${current}${key.sequence}`);
      }
    },
    { isActive: true },
  );

  const maxItemsToShow = Math.max(
    5,
    Math.min(15, (availableTerminalHeight ?? 24) - 10),
  );

  // -- Render --
  if (loadError) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        width="100%"
      >
        <Text bold>Manage Skills</Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>
            Failed to load skills: {loadError}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Press esc to close.</Text>
        </Box>
      </Box>
    );
  }

  if (skills === null) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        width="100%"
      >
        <Text bold>Manage Skills</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Loading skills…</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      width="100%"
    >
      <Text bold>Manage Skills</Text>
      <Text color={theme.text.secondary}>
        Toggle skills on or off. Saves to .qwen/settings.json (workspace).
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>Type to search</Text>
        <Text>{query ? `> ${query}` : '>'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {allSkills.length === 0 ? (
          <Text color={theme.text.secondary}>
            No skills are currently available.
          </Text>
        ) : items.length > 0 ? (
          <MultiSelect
            items={items}
            selectedKeys={selectedKeys ?? []}
            onSelectedKeysChange={setSelectedKeys}
            onConfirm={handleConfirm}
            showNumbers={false}
            checkedText="[x]"
            showActiveMarker
            maxItemsToShow={maxItemsToShow}
          />
        ) : unlockedSkills.length === 0 ? (
          <Text color={theme.text.secondary}>
            All available skills are locked at a higher scope (see below).
          </Text>
        ) : (
          <Text color={theme.text.secondary}>No skills match the search.</Text>
        )}
      </Box>

      {filteredLocked.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            Locked by higher-scope settings (cannot toggle here):
          </Text>
          {filteredLocked.map((s) => {
            const scopeName = higher.scopeOf(s.name) ?? 'higher scope';
            return (
              <Text key={s.name} dimColor wrap="truncate">
                {`  ${truncate(s.name, NAME_COLUMN).padEnd(NAME_COLUMN)} ${truncate(
                  s.description,
                  60,
                )}  [locked: ${scopeName}]`}
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Use up/down to navigate, space to toggle, enter to save, esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
