/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Skills enable/disable dialog (`/skills`).
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
import { t } from '../../../i18n/index.js';
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
  /**
   * Called when the user picks a skill via Enter — the dialog closes and
   * the supplied text (e.g. `/skill-name`) is dropped into the chat input
   * buffer WITHOUT submitting. The user can review/edit and press Enter
   * themselves to send. Pending enable/disable toggles are saved first.
   */
  setInputBuffer: (text: string) => void;
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

// Level labels are looked up at render-time (not module-load) so that
// switching `/language` after startup actually flips the visible label.
function levelLabel(level: SkillLevel): string {
  switch (level) {
    case 'project':
      return t('Project');
    case 'user':
      return t('User');
    case 'extension':
      return t('Extension');
    case 'bundled':
      return t('Bundled');
    default:
      return level;
  }
}

const NAME_COLUMN = 24;

function lower(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeNames(list: readonly string[]): string[] {
  return list
    .filter((n): n is string => typeof n === 'string')
    .map(lower)
    .filter(Boolean);
}

function namesFromScope(
  settings: LoadedSettings,
  scope: SettingScope,
): string[] {
  // settings.json is user-editable: `disabled` could be a non-array
  // (e.g. `"disabled": "all"`) OR contain non-strings. Guard with
  // `Array.isArray` BEFORE returning so downstream `.map(lower)` /
  // `normalizeNames` never see a non-iterable. The element-level
  // string filter still happens in `normalizeNames`. Mirrors the same
  // defense in `buildDisabledSkillNamesProvider` (config.ts).
  const raw = settings.forScope(scope).settings.skills?.disabled;
  return Array.isArray(raw) ? raw : [];
}

function buildHigherDisabled(settings: LoadedSettings): {
  set: ReadonlySet<string>;
  scopeOf: (name: string) => string | null;
} {
  const sysDefaults = normalizeNames(
    namesFromScope(settings, SettingScope.SystemDefaults),
  );
  const user = normalizeNames(namesFromScope(settings, SettingScope.User));
  const system = normalizeNames(namesFromScope(settings, SettingScope.System));
  const set = new Set([...sysDefaults, ...user, ...system]);
  // Highest-precedence scope wins for the locked-row label. System >
  // User > SystemDefaults matches the merge order in `settings.ts`.
  const scopeOf = (name: string): string | null => {
    const l = lower(name);
    if (system.includes(l)) return 'System';
    if (user.includes(l)) return 'User';
    if (sysDefaults.includes(l)) return 'SystemDefaults';
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
  setInputBuffer,
  availableTerminalHeight,
}: SkillsManagerDialogProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillConfig[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Track which row the MultiSelect is currently highlighting so Enter
  // (which the dialog interprets as "invoke the highlighted skill") knows
  // what to launch. Updated via the `onHighlight` callback on every up/down.
  const [activeValue, setActiveValue] = useState<SkillItemValue | null>(null);

  // Capture the workspace and higher-scope disabled lists once at mount.
  // The dialog is short-lived and these are derived from the *current*
  // settings snapshot at open time — using `useMemo` keyed on `settings`
  // would re-derive on every parent re-render and could thrash the
  // `selectedKeys` derivation below.
  const initialWorkspaceDisabled = useMemo(
    () =>
      new Set(normalizeNames(namesFromScope(settings, SettingScope.Workspace))),
    [settings],
  );
  const higher = useMemo(() => buildHigherDisabled(settings), [settings]);

  const skillManager = config?.getSkillManager() ?? null;

  useEffect(() => {
    if (!skillManager) {
      setLoadError(t('SkillManager not available.'));
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

  // `activeValue` is what Enter operates on. MultiSelect's `onHighlight`
  // populates it on arrow-key navigation, but NOT on initial mount or
  // after a search filter that drops the previously highlighted row
  // (`useSelectionList` re-INITIALIZE's with `pendingHighlight: false`).
  // Without this effect, Enter on the first render is a no-op and Enter
  // after a filter would invoke a stale (now-invisible) skill.
  useEffect(() => {
    if (filteredUnlocked.length === 0) {
      if (activeValue !== null) setActiveValue(null);
      return;
    }
    const stillVisible =
      activeValue !== null &&
      filteredUnlocked.some((s) => s.name === activeValue.name);
    if (!stillVisible) {
      const top = filteredUnlocked[0];
      setActiveValue({
        name: top.name,
        description: top.description,
        level: top.level,
      });
    }
  }, [filteredUnlocked, activeValue]);

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
        )}  (${levelLabel(s.level)})`,
      })),
    [filteredUnlocked],
  );

  // Persist any pending toggle changes. Returns:
  //   - 'ok'        — write succeeded (or no-op because nothing changed)
  //   - 'untrusted' — workspace is untrusted; follow-up actions (e.g. pick)
  //                   should be aborted, error already surfaced to the user
  //   - 'error'     — settings.setValue threw; error surfaced to the user.
  //                   Caller should still close the dialog so the user is
  //                   not stuck with a re-throwing Esc handler.
  // The Esc-during-loading race is handled BY THE CALLER (see
  // `handleSaveAndClose`) — `persistChanges` assumes data is loaded.
  const persistChanges = useCallback(async (): Promise<
    'ok' | 'untrusted' | 'error' | 'refresh-failed'
  > => {
    if (!settings.isTrusted) {
      addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Workspace is untrusted; workspace settings are ignored by the merged config. Run /trust first to persist skills changes here, or edit ~/.qwen/settings.json directly to manage skills at user scope.',
          ),
        },
        Date.now(),
      );
      return 'untrusted';
    }

    const selected = new Set(selectedKeys ?? []);
    // workspace disabled = unlocked skills NOT in the selection.
    // Locked names are intentionally excluded so we don't write redundant
    // entries the higher scope is already enforcing.
    const previousWorkspace = namesFromScope(settings, SettingScope.Workspace);
    // Only string entries can be re-emitted with their original casing.
    // A stray non-string survived the namesFromScope `Array.isArray` guard
    // but would crash `lower()` (`.trim is not a function`).
    const previousStrings = previousWorkspace.filter(
      (n): n is string => typeof n === 'string',
    );
    const previousMap = new Map(previousStrings.map((n) => [lower(n), n]));
    const nextDisabled: string[] = [];
    for (const s of unlockedSkills) {
      if (selected.has(s.name)) continue;
      const existing = previousMap.get(lower(s.name));
      nextDisabled.push(existing ?? s.name);
    }

    // Skip the disk write + refresh roundtrip when the on-disk state
    // already matches what we'd write. Comparing normalized lists keeps
    // whitespace/case-only edits in the JSON file from being treated as
    // changes. `previousWorkspace` includes only workspace-scope entries
    // (matching what we're about to write) — locked entries from higher
    // scopes are not in this list, so they don't affect the comparison.
    const prevNormalized = normalizeNames(previousWorkspace).sort();
    const nextNormalized = normalizeNames(nextDisabled).sort();
    const unchanged =
      prevNormalized.length === nextNormalized.length &&
      prevNormalized.every((n, i) => n === nextNormalized[i]);
    if (unchanged) return 'ok';

    try {
      settings.setValue(
        SettingScope.Workspace,
        'skills.disabled',
        nextDisabled.length > 0 ? nextDisabled : undefined,
      );
    } catch (e) {
      addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to save skills configuration: {{error}}', {
            error: e instanceof Error ? e.message : String(e),
          }),
        },
        Date.now(),
      );
      return 'error';
    }

    try {
      // ORDER MATTERS — must NOT be Promise.all. `reloadCommands` rebuilds
      // CommandService AND re-registers the `modelInvocableCommandsProvider`
      // closure over the new instance; `notifyConfigChanged` triggers
      // `SkillTool.refreshSkills`, which calls that provider. Running them
      // in parallel can let the model description pick up the OLD provider,
      // leaking the just-disabled skill back into `<available_skills>` as
      // a command-form entry.
      await reloadCommands();
      if (skillManager) {
        // Tell `slashCommandProcessor`'s change-listener to skip its own
        // `reloadCommands()` — we just awaited one above, the listener's
        // fire-and-forget reload would be a wasted CommandService
        // rebuild. SkillTool's listener still runs normally so the model
        // description picks up the new disabled set. One-shot consumed
        // by the next `notifyChangeListeners` call.
        skillManager.suppressNextSlashReload();
        await skillManager.notifyConfigChanged();
      }
    } catch (e) {
      addItem(
        {
          type: MessageType.WARNING,
          text: t(
            'Skills configuration saved, but refresh failed: {{error}}. Restart to ensure the new state is applied.',
            { error: e instanceof Error ? e.message : String(e) },
          ),
        },
        Date.now(),
      );
      return 'refresh-failed';
    }
    return 'ok';
  }, [
    addItem,
    reloadCommands,
    selectedKeys,
    settings,
    skillManager,
    unlockedSkills,
  ]);

  // Esc handler: auto-save current toggle state and close. Replaces the
  // earlier "save = Enter, Esc = cancel" model with auto-save on exit.
  //
  // Esc-during-loading guard: if the user presses Esc before `skills` and
  // `selectedKeys` finish loading, we have no signal for "what should the
  // disabled set look like" — `selectedKeys ?? []` would compute an empty
  // selection, treat every unlocked skill as just-disabled (in fact the
  // unlocked set is also empty here), and quietly clear any pre-existing
  // workspace `skills.disabled` entry. Just close — there is nothing to
  // save yet.
  const handleSaveAndClose = useCallback(async () => {
    if (skills === null || selectedKeys === null) {
      onClose();
      return;
    }
    const result = await persistChanges();
    if (result === 'ok') {
      addItem(
        {
          type: MessageType.INFO,
          text: t('Skills configuration saved.'),
        },
        Date.now(),
      );
    }
    onClose();
  }, [addItem, onClose, persistChanges, selectedKeys, skills]);

  // Enter handler: save pending toggles, close, and DROP `/<skill-name>`
  // into the input buffer WITHOUT submitting. The user reviews and hits
  // Enter themselves to send. This is "select" semantic — the dialog
  // points at a skill, the user decides whether/when to invoke.
  const handlePick = useCallback(
    async (skill: SkillItemValue) => {
      // Don't pick a skill the user has just toggled off — `/<name>` would
      // resolve to the disabled error path on submit. The same gate applies
      // to skills locked by higher scope (those don't appear in the
      // MultiSelect at all, so we only see them via stale `activeValue`).
      const isEnabled =
        selectedKeys !== null &&
        selectedKeys.includes(skill.name) &&
        !higher.set.has(lower(skill.name));
      if (!isEnabled) {
        // Persist any OTHER pending toggles before bailing — otherwise
        // the user's session-long edits get silently discarded just
        // because their cursor happened to land on a toggled-off (or
        // locked) row when they pressed Enter. Mirrors handleSaveAndClose
        // (Esc) which persists unconditionally once data has loaded.
        if (skills !== null && selectedKeys !== null) {
          await persistChanges();
        }
        onClose();
        return;
      }
      const result = await persistChanges();
      onClose();
      if (result === 'ok') {
        setInputBuffer(`/${skill.name}`);
      }
    },
    [higher.set, onClose, persistChanges, selectedKeys, setInputBuffer, skills],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Esc with active search: just clear the query (refining without
        // exiting is intuitive). Esc on an empty search: auto-save and
        // close — there is no longer a "cancel without saving" path,
        // matching the user-requested keymap (Esc = exit, changes stick).
        if (query) {
          setQuery('');
          return;
        }
        void handleSaveAndClose();
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        setQuery((current) => current.slice(0, -1));
        return;
      }

      // Defer navigation/selection keys to MultiSelect.
      // j/k are only deferred when no search query is active — they are
      // valid filter characters (e.g. "json", "jwt", "kotlin", "jdk").
      // When the user IS searching, MultiSelect receives
      // `isFocused={false}` which disables its vim-style key handlers,
      // so j/k flow through to the printable-character branch below.
      if ((key.name === 'j' || key.name === 'k') && !query) {
        return;
      }
      if (
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
        <Text bold>{t('Manage Skills')}</Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>
            {t('Failed to load skills: {{error}}', { error: loadError ?? '' })}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{t('Press esc to close.')}</Text>
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
        <Text bold>{t('Manage Skills')}</Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{t('Loading skills…')}</Text>
        </Box>
      </Box>
    );
  }

  // Counts shown in the header so users can see filter effect at a glance.
  const totalCount = allSkills.length;
  const matchedCount = filteredUnlocked.length + filteredLocked.length;
  const hasQuery = query.trim().length > 0;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      width="100%"
    >
      <Text bold>{t('Manage Skills')}</Text>
      <Text color={theme.text.secondary}>
        {hasQuery
          ? t('{{matched}} / {{total}} skills · ', {
              matched: String(matchedCount),
              total: String(totalCount),
            })
          : t('{{count}} skills · ', { count: String(totalCount) })}
        {t(
          'Space toggle · Enter pick (fill input) · Esc save & exit · workspace scope',
        )}
      </Text>

      <Box marginTop={1} flexDirection="row">
        <Text color={hasQuery ? theme.text.accent : theme.text.secondary}>
          {t('Search:')}{' '}
        </Text>
        <Text>
          {query || (
            <Text color={theme.text.secondary} dimColor>
              {t('type to filter…')}
            </Text>
          )}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {allSkills.length === 0 ? (
          <Text color={theme.text.secondary}>
            {t('No skills are currently available.')}
          </Text>
        ) : items.length > 0 ? (
          <MultiSelect
            items={items}
            disableVimNav={!!query}
            selectedKeys={selectedKeys ?? []}
            onSelectedKeysChange={setSelectedKeys}
            // Enter == "pick" the highlighted skill: close the dialog and
            // drop `/<name>` into the input buffer (no auto-submit).
            // MultiSelect's `onConfirm` fires on Enter; we read the row
            // tracked via `onHighlight` so we know which one. Saving lives
            // entirely on Esc — see `handleSaveAndClose`.
            onConfirm={() => {
              if (activeValue) {
                void handlePick(activeValue);
              }
              // Empty list (search filtered everything out): no-op; Esc to exit.
            }}
            onHighlight={(v) => setActiveValue(v)}
            showNumbers={false}
            checkedText="[x]"
            showActiveMarker
            maxItemsToShow={maxItemsToShow}
          />
        ) : unlockedSkills.length === 0 ? (
          <Text color={theme.text.secondary}>
            {t(
              'All available skills are locked at a higher scope (see below).',
            )}
          </Text>
        ) : (
          <Text color={theme.text.secondary}>
            {t('No skills match the search.')}
          </Text>
        )}
      </Box>

      {filteredLocked.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {t('Locked by higher-scope settings (cannot toggle here):')}
          </Text>
          {filteredLocked.map((s) => {
            // Scope identifiers (System / User / SystemDefaults) stay as
            // untranslated technical labels — they refer to settings file
            // scopes by name and matching them exactly helps users locate
            // the offending entry.
            const scopeName = higher.scopeOf(s.name) ?? t('higher scope');
            return (
              <Text key={s.name} dimColor wrap="truncate">
                {t('  {{name}} {{description}}  [locked: {{scope}}]', {
                  name: truncate(s.name, NAME_COLUMN).padEnd(NAME_COLUMN),
                  description: truncate(s.description, 60),
                  scope: scopeName,
                })}
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary} dimColor>
          {t('↑/↓ navigate · backspace edits search')}
        </Text>
      </Box>
    </Box>
  );
}
