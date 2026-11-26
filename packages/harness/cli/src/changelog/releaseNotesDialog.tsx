/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import {
  BaseTabDialog,
  type TabItem,
} from '../ui/components/shared/BaseTabDialog.js';
import { MarkdownDisplay } from '../ui/utils/MarkdownDisplay.js';
import { stringWidth } from '../ink/stringWidth.js';
import { theme } from '../ui/semantic-colors.js';
import { useI18nService } from '../ui/i18n/I18nServiceContext.js';
import type { getChangelogUrl, VersionEntry } from './changelogFetch.js';
import { useChangelog } from './useChangelog.js';

interface ReleaseNotesDialogProps {
  /** Parsed version entries (newest first) */
  entries: readonly VersionEntry[];
  /** Called when the user presses Esc to close the dialog */
  onClose?: () => void;
}

const SEP = '·';

/**
 * Given all entries and the terminal width, compute which entries to show as
 * tabs. The last entry (e.g. "...") is always pinned; front entries fill the
 * remaining space.
 */
function computeVisibleEntries(
  entries: readonly VersionEntry[],
  terminalWidth: number,
  title: string,
): readonly VersionEntry[] {
  if (entries.length <= 1) return entries;

  // Fixed: "Release Notes · " — title(13) + gap(1) + sep(1) + gap(1) = 16
  const fixedWidth = stringWidth(title) + 1 + stringWidth(SEP) + 1;
  const itemW = (label: string) => stringWidth(label) + 2;

  // Check if everything fits as-is
  const totalW =
    entries.reduce((s, e) => s + itemW(e.version), 0) + (entries.length - 1);
  if (fixedWidth + totalW <= terminalWidth) return entries;

  // Always keep the last entry; fill front entries greedily.
  // Budget: fixedWidth + frontW + 1(gap) + itemW(last) <= terminalWidth
  const lastEntry = entries[entries.length - 1];
  const budget = terminalWidth - fixedWidth - 1 - itemW(lastEntry.version);

  const front: VersionEntry[] = [];
  let used = 0;
  for (const e of entries.slice(0, -1)) {
    const w = itemW(e.version);
    const gap = front.length > 0 ? 1 : 0;
    if (used + gap + w <= budget) {
      front.push(e);
      used += gap + w;
    } else {
      break;
    }
  }

  return [...front, lastEntry];
}

/**
 * A tabbed dialog that shows release notes per CLI version.
 *
 * Each tab corresponds to a CLI version. The tab content is
 * rendered as markdown via `MarkdownDisplay`.
 *
 * Keyboard:
 * - Left / Right (or Tab / Shift+Tab) to switch version tabs
 * - Esc to close
 *
 */
export const ReleaseNotesDialog: React.FC<ReleaseNotesDialogProps> = ({
  entries,
  onClose,
}) => {
  const i18n = useI18nService();
  const title = i18n.get('home.releaseNotes.title');
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  // Compute visible entries based on terminal width (last entry always pinned)
  const visibleEntries = useMemo(
    () => computeVisibleEntries(entries, terminalWidth, title),
    [entries, terminalWidth, title],
  );

  // Build tab items from visible entries
  const tabs: TabItem[] = useMemo(
    () => visibleEntries.map((e) => ({ key: e.version, label: e.version })),
    [visibleEntries],
  );

  // Default to first (newest) version
  const [activeKey, setActiveKey] = useState<string>(tabs[0]?.key ?? '');

  useEffect(() => {
    setActiveKey((current) =>
      tabs.some((tab) => tab.key === current) ? current : (tabs[0]?.key ?? ''),
    );
  }, [tabs]);

  const handleTabChange = useCallback((key: string) => {
    setActiveKey(key);
  }, []);

  // Build tabPanels map — only for visible entries
  const tabPanels: Record<string, React.ReactNode> = useMemo(() => {
    const panels: Record<string, React.ReactNode> = {};
    for (const entry of visibleEntries) {
      panels[entry.version] = (
        <Box flexDirection="column" paddingTop={1}>
          <MarkdownDisplay
            text={entry.content}
            isPending={false}
            terminalWidth={terminalWidth - 2} // account for paddingLeft/Right in BaseTabDialog
          />
        </Box>
      );
    }
    return panels;
  }, [visibleEntries, terminalWidth]);

  // Empty state — no cached changelog yet
  if (entries.length === 0) {
    return (
      <BaseTabDialog
        title={title}
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        onClose={onClose}
        defaultHintLabels={{ goBack: i18n.get('shortcut.back') }}
      >
        <Box paddingTop={1}>
          <Text color={theme.text.secondary}>
            {i18n.get('home.releaseNotes.empty')}
          </Text>
        </Box>
      </BaseTabDialog>
    );
  }

  return (
    <BaseTabDialog
      title={title}
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={handleTabChange}
      onClose={onClose}
      equalizeTabHeight={false}
      tabPanels={tabPanels}
      defaultHintLabels={{
        goBack: i18n.get('shortcut.back'),
        tabSwitch: i18n.get('shortcut.tabSwitch'),
      }}
    >
      {tabPanels[activeKey]}
    </BaseTabDialog>
  );
};

/** Store-connected dialog used by the slash command. */
export const ConnectedReleaseNotesDialog: React.FC<{
  onClose?: () => void;
  getUrl?: typeof getChangelogUrl;
}> = ({ onClose, getUrl }) => {
  const { entries } = useChangelog(undefined, getUrl);
  return <ReleaseNotesDialog entries={entries} onClose={onClose} />;
};
