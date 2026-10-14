/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type {
  ImportEntry,
  ImportPreview,
} from '../../commands/memory/codex-import.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { RenderModeProvider } from '../contexts/RenderModeContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  sanitizeFilenameForDisplay,
  sanitizeMultilineForDisplay,
} from '../utils/textUtils.js';
import { theme } from '../semantic-colors.js';

export interface MemoryImportResult {
  action: 'import' | 'preview';
  selectedIds: string[];
}

export interface MemoryImportPreviewProps {
  preview: ImportPreview;
  initialSelectedIds?: string[];
  canImport?: boolean;
  onFinish: (result: MemoryImportResult | undefined) => void;
  onOpen: (text: string) => Promise<void>;
}

interface PreviewRow {
  key: string;
  label: string;
  text: string;
  entry?: ImportEntry;
}
interface PreviewGroup {
  key: string;
  label: string;
  rows: PreviewRow[];
}

function safe(text: string, multiline = false): string {
  const sanitized = multiline
    ? sanitizeMultilineForDisplay(text.replace(/\r\n/g, '\n'))
    : sanitizeFilenameForDisplay(text);
  return sanitized.replace(
    /[\p{Cf}\u2028\u2029]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

function selectable(entry: ImportEntry): boolean {
  return entry.status === 'ready' || entry.status === 'duplicate';
}

function groupPreview(preview: ImportPreview): PreviewGroup[] {
  const groups = new Map<string, PreviewGroup>();
  for (const entry of preview.entries) {
    const user = entry.scope === 'user';
    const scope = user
      ? entry.scopeReason
        ? 'User memory (global fallback)'
        : 'User memory'
      : 'Project memory';
    const project =
      entry.resolvedProject ?? entry.sourceProject ?? 'unresolved project';
    const key = `${scope}:${entry.targetRoot ?? project}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: user ? scope : `${scope}: ${safe(project)}`,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push({
      key: entry.id,
      label: `${entry.scopeReason ? '[global fallback] ' : ''}${safe(entry.name)}`,
      entry,
      text: [
        `# ${safe(entry.name)}`,
        `ID: ${safe(entry.id)}`,
        `Status: ${entry.status} | Type: ${safe(entry.type)}`,
        `Scope: ${scope}${user ? '' : ` (${safe(project)})`}`,
        ...(entry.sourceProject
          ? [`Source project: ${safe(entry.sourceProject)}`]
          : []),
        ...(entry.resolvedProject
          ? [`Resolved project: ${safe(entry.resolvedProject)}`]
          : []),
        `Destination: ${safe(entry.targetRoot ?? 'unresolved')}`,
        `Source: ${safe(entry.sourceFile)}:${entry.sourceLine}`,
        `Source date: ${safe(entry.updatedAt ?? 'unknown')}`,
        ...(entry.scopeReason
          ? [`Global fallback: ${safe(entry.scopeReason)}`]
          : []),
        ...(entry.reason ? [`Reason: ${safe(entry.reason)}`] : []),
        '',
        safe(entry.content, true),
      ].join('\n'),
    });
  }
  if (preview.reviewNotes.length || preview.warnings.length) {
    groups.set('review', {
      key: 'review',
      label: 'Source notes & warnings',
      rows: [
        ...preview.reviewNotes.map((note, index) => ({
          key: `note-${index}`,
          label: `Source note: ${safe(note.path)}`,
          text: `# Source amendment\nSource: ${safe(note.path)}\n\n${safe(note.content, true)}`,
        })),
        ...preview.warnings.map((warning, index) => ({
          key: `warning-${index}`,
          label: `Warning ${index + 1}: ${safe(warning)}`,
          text: `# Warning ${index + 1}\n\n${safe(warning, true)}`,
        })),
      ],
    });
  }
  return [...groups.values()];
}

const rawRenderMode = { renderMode: 'raw' as const, setRenderMode: () => {} };

export function MemoryImportPreview({
  preview,
  initialSelectedIds,
  canImport = false,
  onFinish,
  onOpen,
}: MemoryImportPreviewProps) {
  const groups = useMemo(() => groupPreview(preview), [preview]);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        preview.entries
          .filter(
            (entry) =>
              selectable(entry) &&
              (initialSelectedIds === undefined ||
                initialSelectedIds.includes(entry.id)),
          )
          .map((entry) => entry.id),
      ),
  );
  const [groupIndex, setGroupIndex] = useState(0);
  const [insideGroup, setInsideGroup] = useState(false);
  const [rowIndices, setRowIndices] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const finished = useRef(false);
  const [error, setError] = useState<string>();
  const { columns, rows } = useTerminalSize();
  const tooSmall = columns < 32 || rows < 12;
  const width = Math.max(1, columns - 2);
  const contentHeight = Math.max(3, rows - 10);
  const group = groups[groupIndex];
  const rowIndex = group ? (rowIndices[group.key] ?? 0) : 0;
  const row = insideGroup ? group?.rows[rowIndex] : undefined;
  const counts = preview.entries.reduce<Record<string, number>>(
    (result, entry) => {
      result[entry.status] = (result[entry.status] ?? 0) + 1;
      return result;
    },
    {},
  );
  const selectedEntries = preview.entries.filter((entry) =>
    selected.has(entry.id),
  );
  const selectedIds = selectedEntries.map((entry) => entry.id);
  const finish = (result: MemoryImportResult | undefined) => {
    if (finished.current || busyRef.current) return;
    finished.current = true;
    onFinish(result);
  };
  const confirmImport = () => {
    if (!canImport) {
      setError('Dry run: remove --dry-run to import.');
    } else if (!selected.size) {
      setError('Select at least one candidate to import.');
    } else {
      setError(undefined);
      setConfirming(true);
    }
  };
  const open = async () => {
    if (!row || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onOpen(
        `${row.text}\n\nSource digest: ${safe(preview.sourceDigest)}\n`,
      );
    } catch (cause) {
      setError(safe(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useKeypress(
    (key) => {
      if (busyRef.current || finished.current || key.paste) return;
      if (key.ctrl && key.name === 'c') {
        finish(undefined);
      } else if (key.name === 'escape') {
        setError(undefined);
        if (confirming) setConfirming(false);
        else if (detail) setDetail(false);
        else if (insideGroup) setInsideGroup(false);
        else finish(undefined);
      } else if (key.ctrl || key.meta) {
        return;
      } else if (tooSmall || confirming) {
        return;
      } else if (key.name === 'i' || (key.name === 'd' && canImport)) {
        confirmImport();
      } else if (key.name === 'd') {
        finish({ action: 'preview', selectedIds });
      } else if (key.name === 'a' || key.name === 'n') {
        setSelected(
          new Set(
            key.name === 'a'
              ? preview.entries.filter(selectable).map((entry) => entry.id)
              : [],
          ),
        );
        setError(undefined);
      } else if (key.name === 'o') {
        void open();
      } else if (key.name === 'space' || key.sequence === ' ') {
        if (row?.entry && !selectable(row.entry)) {
          setError(
            `Cannot select ${row.entry.status}; inspect the reason with Enter or o.`,
          );
          return;
        }
        const ids = row?.entry
          ? [row.entry.id]
          : !insideGroup
            ? (group?.rows.flatMap((item) =>
                item.entry && selectable(item.entry) ? [item.entry.id] : [],
              ) ?? [])
            : [];
        setSelected((previous) => {
          const next = new Set(previous);
          const remove = ids.every((id) => next.has(id));
          for (const id of ids) {
            if (remove) next.delete(id);
            else next.add(id);
          }
          return next;
        });
        setError(undefined);
      }
    },
    { isActive: !busy },
  );

  if (tooSmall) {
    return (
      <Box width={width} flexDirection="column">
        <Text wrap="truncate">Resize terminal to at least 32 × 12.</Text>
        <Text wrap="truncate">No memory writes. Ctrl+C cancels.</Text>
      </Box>
    );
  }

  if (confirming) {
    return (
      <Box width={width} flexDirection="column">
        <Text bold>Import {selected.size} selected candidates?</Text>
        <Text wrap="truncate">
          Project:{' '}
          {selectedEntries.filter((entry) => entry.scope === 'project').length}
          {' · '}User:{' '}
          {selectedEntries.filter((entry) => entry.scope === 'user').length}
        </Text>
        <Text wrap="truncate">
          Global fallbacks:{' '}
          {selectedEntries.filter((entry) => entry.scopeReason).length} (all
          projects)
        </Text>
        <Text wrap="truncate">
          {new Set(selectedEntries.map((entry) => entry.targetRoot)).size}{' '}
          memory destinations
        </Text>
        {preview.reviewNotes.length > 0 && (
          <Text>
            Review {preview.reviewNotes.length} source notes before confirming;
            they may amend or delete advice.
          </Text>
        )}
        <RadioButtonSelect
          items={[
            {
              key: 'import',
              value: 'import',
              label: preview.reviewNotes.length
                ? `Notes reviewed: import ${selected.size}`
                : `Import ${selected.size} selected candidates`,
            },
            { key: 'back', value: 'back', label: 'Back to review' },
          ]}
          initialIndex={1}
          onSelect={(action) => {
            if (action === 'import' && canImport && selectedIds.length) {
              finish({ action: 'import', selectedIds });
            } else setConfirming(false);
          }}
          showNumbers={false}
        />
        <Text>↑/↓ choose · Enter confirm · Esc back</Text>
      </Box>
    );
  }

  return (
    <RenderModeProvider value={rawRenderMode}>
      <Box width={width} flexDirection="column">
        <Text bold wrap="truncate">
          {canImport
            ? 'Codex memory import — review selection'
            : 'Codex memory import — dry run (no writes)'}
        </Text>
        <Text wrap="truncate">
          {preview.entries.length} candidates · {selected.size} selected ·{' '}
          {preview.reviewNotes.length} notes · {preview.warnings.length}{' '}
          warnings
        </Text>
        <Text wrap="truncate">
          ready {counts['ready'] ?? 0} · duplicate {counts['duplicate'] ?? 0} ·
          conflict {counts['conflict'] ?? 0}
        </Text>
        <Text wrap="truncate">
          blocked {counts['blocked'] ?? 0} · global fallback{' '}
          {preview.entries.filter((entry) => entry.scopeReason).length} ·
          previously imported {counts['previously-imported'] ?? 0}
        </Text>
        <Text bold wrap="truncate">
          {insideGroup ? group?.label : 'Choose a memory group'}
        </Text>
        {detail && row ? (
          <Box
            flexDirection="column"
            maxHeight={contentHeight}
            overflow="hidden"
          >
            <MarkdownDisplay
              text={row.text}
              isPending={false}
              contentWidth={width}
              availableTerminalHeight={contentHeight}
              enforceHeightBudget
            />
          </Box>
        ) : groups.length === 0 ? (
          <Text>No import candidates found.</Text>
        ) : (
          <RadioButtonSelect
            key={insideGroup ? group?.key : 'groups'}
            items={
              insideGroup && group
                ? group.rows.map((item, index) => ({
                    key: item.key,
                    value: index,
                    label: item.entry
                      ? `${selectable(item.entry) ? (selected.has(item.entry.id) ? '[x]' : '[ ]') : '[-]'} ${item.entry.status}: ${item.label}`
                      : item.label,
                  }))
                : groups.map((item, index) => {
                    const eligible = item.rows.filter(
                      (row) => row.entry && selectable(row.entry),
                    );
                    return {
                      key: item.key,
                      value: index,
                      label: `${eligible.length ? `[${eligible.filter((row) => selected.has(row.entry!.id)).length}/${eligible.length} selected] ` : ''}${item.label} (${item.rows.length})`,
                    };
                  })
            }
            initialIndex={insideGroup ? rowIndex : groupIndex}
            onHighlight={(index) => {
              if (busyRef.current) return;
              setError(undefined);
              if (insideGroup && group)
                setRowIndices((previous) => ({
                  ...previous,
                  [group.key]: index,
                }));
              else setGroupIndex(index);
            }}
            onSelect={(index) => {
              if (busyRef.current) return;
              setError(undefined);
              if (insideGroup && group) {
                setRowIndices((previous) => ({
                  ...previous,
                  [group.key]: index,
                }));
                setDetail(true);
              } else {
                setGroupIndex(index);
                setInsideGroup(true);
              }
            }}
            isFocused={!busy}
            maxItemsToShow={Math.max(1, contentHeight - 2)}
            showScrollArrows
            showNumbers={false}
          />
        )}
        <Text
          color={error ? theme.status.error : theme.text.secondary}
          wrap="truncate"
        >
          {busy
            ? 'Opening full text…'
            : (error ??
              (row?.entry && !selectable(row.entry)
                ? `${row.entry.status}: ${safe(row.entry.reason ?? 'This entry cannot be selected.')}`
                : canImport
                  ? 'a select all · n clear all · Space toggle item/group'
                  : 'Dry run: remove --dry-run to import.'))}
        </Text>
        <Text wrap="truncate">
          {detail
            ? 'Space select · o open full text · Esc back'
            : insideGroup
              ? '↑/↓ move · Enter detail · Space select · o full text · Esc groups'
              : '↑/↓ move · Enter open group · Esc cancel'}
        </Text>
        <Text bold color={theme.text.accent} wrap="truncate">
          {canImport
            ? `i Start import (${selected.size} selected) · Ctrl+C cancel`
            : 'd close preview · a all · n none · Ctrl+C cancel'}
        </Text>
      </Box>
    </RenderModeProvider>
  );
}
