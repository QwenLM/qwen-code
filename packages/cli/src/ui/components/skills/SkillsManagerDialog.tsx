/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Skills enable/disable dialog (`/skills`).
 *
 * Two key invariants worth knowing before editing:
 *
 *   1. MultiSelect renders only workspace-toggleable skills. Higher-scope
 *      disabled skills render in a read-only section when unconstrained and
 *      as a count when height-constrained, avoiding MultiSelect's misleading
 *      `[x]` rendering for disabled items.
 *
 *   2. When saving, locked names are NEVER re-emitted into the workspace
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
import {
  computeWorkspaceSkillListUpdates,
  skillSettingStrings,
} from '../../../config/skill-settings.js';
import { t } from '../../../i18n/index.js';
import { levelLabel } from '../../utils/skill-level-label.js';
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

const LEVEL_ORDER: Record<SkillLevel, number> = {
  project: 0,
  user: 1,
  extension: 2,
  bundled: 3,
};

const NAME_COLUMN = 24;
// Fixed non-list rows: border(2) + paddingY(2) + title(1) + subtitle(1)
// + search row(2) + list marginTop(1) + footer(2). The optional locked-skills
// block adds 2 + N rows when present; not counted here.
const SKILLS_DIALOG_FIXED_ROWS = 11;

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

// Collapse line breaks from YAML block scalars so one label stays on one row.
function oneLine(text: string): string {
  return text.replace(/[\n\r\v\f\u0085\u2028\u2029]+/g, ' ').trim();
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
  // Capture the higher-scope disabled lists once at mount.
  // The dialog is short-lived and these are derived from the *current*
  // settings snapshot at open time — using `useMemo` keyed on `settings`
  // would re-derive on every parent re-render and could thrash the
  // `selectedKeys` derivation below.
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
        const userInvocableList = list.filter(
          (skill) => skill.userInvocable !== false,
        );
        if (!cancelled) setSkills(sortSkills(userInvocableList));
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

  const initialSelectedKeys = useMemo(
    () =>
      new Set(
        unlockedSkills
          .filter((skill) => config?.isSkillEnabled(skill) ?? true)
          .map((skill) => skill.name),
      ),
    [config, unlockedSkills],
  );

  // Initial selection: every effectively enabled, unlocked skill.
  // Checked = enabled.
  const [selectedKeys, setSelectedKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (selectedKeys !== null || unlockedSkills.length === 0) return;
    setSelectedKeys([...initialSelectedKeys]);
  }, [unlockedSkills, initialSelectedKeys, selectedKeys]);

  // Height-budget tiers. `compact` sheds border, paddingY, and footer
  // (6 rows) — mirroring the /statusline compact path. `bare` sheds the
  // remaining 5-row compact frame (title/subtitle/search/margin) too, so
  // budgets ≤ 5 render only the list; otherwise the frame floors at 6 rows
  // and the interactive list is the row that clips.
  const compact =
    availableTerminalHeight !== undefined &&
    availableTerminalHeight <= SKILLS_DIALOG_FIXED_ROWS;
  const bare =
    availableTerminalHeight !== undefined &&
    availableTerminalHeight <= SKILLS_DIALOG_FIXED_ROWS - 6;
  const frameRows = bare
    ? 0
    : compact
      ? SKILLS_DIALOG_FIXED_ROWS - 6
      : SKILLS_DIALOG_FIXED_ROWS;
  const constrained = availableTerminalHeight !== undefined;

  // The search row is hidden in bare mode, so a retained query must not
  // filter the list invisibly (mirrors the /statusline `hasFullLayout`
  // gate).
  const filteredUnlocked = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery || bare) return unlockedSkills;
    return unlockedSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(normalizedQuery) ||
        s.description.toLowerCase().includes(normalizedQuery),
    );
  }, [unlockedSkills, query, bare]);

  const filteredLocked = useMemo(() => {
    if (constrained) return [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return lockedSkills;
    return lockedSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(normalizedQuery) ||
        s.description.toLowerCase().includes(normalizedQuery),
    );
  }, [lockedSkills, query, constrained]);

  const items = useMemo<Array<MultiSelectItem<string>>>(
    () =>
      filteredUnlocked.map((s) => ({
        key: s.name,
        value: s.name,
        label: `${truncate(s.name, NAME_COLUMN).padEnd(NAME_COLUMN)} ${truncate(
          oneLine(s.description),
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
    const workspaceDisabled = namesFromScope(
      settings,
      SettingScope.Workspace,
    ).filter((name): name is string => typeof name === 'string');
    const { disabled, enabled, disabledChanged, enabledChanged } =
      computeWorkspaceSkillListUpdates(
        workspaceDisabled,
        skillSettingStrings(settings, SettingScope.Workspace, 'enabled'),
        unlockedSkills.map((skill) => ({
          name: skill.name,
          wasEnabled: initialSelectedKeys.has(skill.name),
          isEnabled: selected.has(skill.name),
        })),
      );
    if (!disabledChanged && !enabledChanged) return 'ok';

    try {
      settings.setValues([
        ...(disabledChanged
          ? [
              {
                scope: SettingScope.Workspace,
                key: 'skills.disabled',
                value: disabled.length > 0 ? disabled : undefined,
              },
            ]
          : []),
        ...(enabledChanged
          ? [
              {
                scope: SettingScope.Workspace,
                key: 'skills.enabled',
                value: enabled.length > 0 ? enabled : undefined,
              },
            ]
          : []),
      ]);
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
    initialSelectedKeys,
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
    async (skillName: string) => {
      // Don't pick a skill the user has just toggled off.
      const isEnabled = selectedKeys?.includes(skillName) ?? false;
      if (!isEnabled) {
        // Persist any OTHER pending toggles before bailing — otherwise
        // the user's session-long edits get silently discarded just
        // because their cursor happened to land on a toggled-off row when
        // they pressed Enter. Mirrors handleSaveAndClose
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
        setInputBuffer(`/${skillName}`);
      }
    },
    [onClose, persistChanges, selectedKeys, setInputBuffer, skills],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Esc with active search: just clear the query (refining without
        // exiting is intuitive). Esc on an empty search: auto-save and
        // close — there is no longer a "cancel without saving" path,
        // matching the user-requested keymap (Esc = exit, changes stick).
        if (!bare && query) {
          setQuery('');
          return;
        }
        void handleSaveAndClose();
        return;
      }

      // Search-row inputs are also suppressed in bare mode (the query is
      // hidden there and bypassed in filtering) — same rationale as above.
      if (!bare && (key.name === 'backspace' || key.name === 'delete')) {
        setQuery((current) => current.slice(0, -1));
        return;
      }

      // Defer navigation/selection keys to MultiSelect.
      // j/k are only deferred when no search query is active — they are
      // valid filter characters (e.g. "json", "jwt", "kotlin", "jdk").
      // When the user IS searching, MultiSelect receives
      // `disableVimNav={true}` which disables its vim-style key handlers,
      // so j/k flow through to the printable-character branch below.
      if ((key.name === 'j' || key.name === 'k') && (bare || !query)) {
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
        !bare &&
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

  const hasQuery = !bare && query.trim().length > 0;
  const residual =
    availableTerminalHeight === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, availableTerminalHeight - frameRows);
  const maxItemsToShow = Math.min(15, Math.max(1, residual));

  if (loadError || skills === null) {
    return (
      <Box
        borderStyle={compact ? undefined : 'round'}
        borderColor={theme.border.default}
        flexDirection="column"
        paddingX={1}
        paddingY={compact ? 0 : 1}
        width="100%"
      >
        {!bare && (
          <Text bold wrap="truncate">
            {t('Manage Skills')}
          </Text>
        )}
        <Box marginTop={bare ? 0 : 1}>
          <Text
            color={loadError ? theme.status.error : theme.text.secondary}
            wrap="truncate"
          >
            {loadError
              ? t('Failed to load skills: {{error}}', { error: loadError })
              : t('Loading skills…')}
          </Text>
        </Box>
        {loadError && !compact && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary} wrap="truncate">
              {t('Press esc to close.')}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Counts shown in the header so users can see filter effect at a glance.
  const totalCount = allSkills.length;
  const matchedCount = filteredUnlocked.length + filteredLocked.length;
  const lockedCount = t('(+{{count}} locked)', {
    count: String(lockedSkills.length),
  });

  return (
    <Box
      borderStyle={compact ? undefined : 'round'}
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={compact ? 0 : 1}
      width="100%"
    >
      {!bare && (
        <>
          <Text bold wrap="truncate">
            {t('Manage Skills')}
          </Text>
          <Text color={theme.text.secondary} wrap="truncate">
            {hasQuery
              ? t('{{matched}} / {{total}} skills · ', {
                  matched: String(matchedCount),
                  total: String(totalCount),
                })
              : t('{{count}} skills · ', { count: String(totalCount) })}
            {constrained && lockedSkills.length > 0 ? `${lockedCount} ` : ''}
            {t(
              'Space toggle · Enter pick (fill input) · Esc save & exit · workspace scope',
            )}
          </Text>
        </>
      )}

      {!bare && (
        <Box marginTop={1} flexDirection="column">
          <Text wrap="truncate">
            <Text color={hasQuery ? theme.text.accent : theme.text.secondary}>
              {t('Search:')}{' '}
            </Text>
            {query || (
              <Text color={theme.text.secondary} dimColor>
                {t('type to filter…')}
              </Text>
            )}
          </Text>
        </Box>
      )}

      <Box marginTop={bare ? 0 : 1} flexDirection="column">
        {allSkills.length === 0 ? (
          <Text color={theme.text.secondary} wrap="truncate">
            {t('No skills are currently available.')}
          </Text>
        ) : items.length > 0 ? (
          <MultiSelect
            items={items}
            disableVimNav={!bare && !!query}
            selectedKeys={selectedKeys ?? []}
            onSelectedKeysChange={setSelectedKeys}
            // Enter saves and fills the input with the highlighted skill.
            onConfirm={(_selected, activeSkillName) => {
              void handlePick(activeSkillName);
            }}
            showNumbers={false}
            checkedText="[x]"
            showActiveMarker
            truncateLabels
            maxItemsToShow={maxItemsToShow}
          />
        ) : constrained && unlockedSkills.length === 0 ? (
          <Text color={theme.text.secondary} dimColor wrap="truncate">
            {lockedCount}
          </Text>
        ) : filteredLocked.length > 0 ? null : (
          <Text color={theme.text.secondary} wrap="truncate">
            {t('No skills match the search.')}
          </Text>
        )}
      </Box>

      {filteredLocked.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary} wrap="truncate">
            {t('Locked by higher-scope settings (cannot toggle here):')}
          </Text>
          {/* Scope names match settings-file identifiers and stay untranslated. */}
          {filteredLocked.map((skill) => (
            <Text key={skill.name} dimColor wrap="truncate">
              {t('  {{name}} {{description}}  [locked: {{scope}}]', {
                name: truncate(skill.name, NAME_COLUMN).padEnd(NAME_COLUMN),
                description: truncate(oneLine(skill.description), 60),
                scope: higher.scopeOf(skill.name) ?? t('higher scope'),
              })}
            </Text>
          ))}
        </Box>
      )}

      {!compact && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor wrap="truncate">
            {t('↑/↓ navigate · backspace edits search')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
