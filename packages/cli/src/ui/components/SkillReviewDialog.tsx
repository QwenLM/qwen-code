/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { promises as fs, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { MaxSizedBox } from './shared/MaxSizedBox.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { SettingScope } from '../../config/settings.js';
import {
  sanitizeFilenameForDisplay,
  sanitizeMultilineForDisplay,
} from '../utils/textUtils.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import type { PendingSkillView } from '../contexts/UIStateContext.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

type Choice = 'keep' | 'discard' | 'keepAll' | 'discardAll' | 'turnOff';

const debugLogger = createDebugLogger('SKILL_REVIEW_DIALOG');

/** How many lines of the staged SKILL.md to show before truncating. */
const PREVIEW_MAX_HEIGHT = 12;

/**
 * A single editor save fires several raw watch events (inotify reports
 * MODIFY/CLOSE_WRITE/ATTRIB separately; FSEvents can also fire more than once)
 * and each reload re-reads the file and re-attaches the watcher — coalesce
 * them so one save costs one reload. Same interval as SettingsWatcher.
 */
const WATCH_DEBOUNCE_MS = 300;

/**
 * Cap how much of the (model-generated, possibly huge) SKILL.md is read and
 * processed. Bounds the read + sanitize + split cost regardless of file size;
 * the rendered rows are separately capped to PREVIEW_MAX_HEIGHT. 64 KiB is far
 * more than the preview shows but cheap to scan.
 */
const PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * Read at most PREVIEW_MAX_BYTES from the head of the file so an enormous
 * SKILL.md can't stall the dialog. A trailing partial UTF-8 char or line is
 * harmless because the preview is line-capped anyway. `truncated` reports
 * whether the file extends past the cap (one extra byte is requested so this is
 * reliable even when the visible lines fit) so the caller can flag the omission
 * — a line-hidden marker alone can miss it (e.g. a few short lines then a large
 * trailing blob).
 */
async function readPreviewChunk(
  filePath: string,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(PREVIEW_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, PREVIEW_MAX_BYTES + 1, 0);
    const truncated = bytesRead > PREVIEW_MAX_BYTES;
    const end = Math.min(bytesRead, PREVIEW_MAX_BYTES);
    return { text: buf.toString('utf-8', 0, end), truncated };
  } finally {
    await handle.close();
  }
}

type PreviewState =
  | { status: 'loading' }
  | {
      status: 'ready';
      /** The staged file this preview was read from — a ready preview is only
       * valid for that file; rendering guards on it so skill B never shows
       * skill A's body while B's read is still in flight. */
      path: string;
      lines: string[];
      hiddenLines: number;
      truncated: boolean;
    }
  | { status: 'error' };

export interface SkillReviewDialogProps {
  skills: PendingSkillView[];
  onAccept: (skillName: string) => void;
  onReject: (skillName: string) => void;
  /** Worked through the batch (or nothing to show) — close without deferring. */
  onClose: () => void;
  /** Esc ("decide later") — defer the whole batch so it isn't auto-reopened. */
  onDismiss: () => void;
}

export const SkillReviewDialog = ({
  skills,
  onAccept,
  onReject,
  onClose,
  onDismiss,
}: SkillReviewDialogProps) => {
  // Snapshot the skills on mount. `onAccept`/`onReject` trigger a
  // subscription refresh in the parent that shrinks the live `skills` prop;
  // advancing through a stable snapshot keeps the per-skill flow correct
  // (otherwise resolving the current item shifts indices and skips skills).
  const [snapshot] = useState(() => skills);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped after the editor closes to re-read the (possibly edited) staged file.
  const [reloadCounter, setReloadCounter] = useState(0);

  const launchEditor = useLaunchEditor();
  const settings = useSettings();
  const config = useConfig();
  const { columns } = useTerminalSize();
  // The dialog does not span the full terminal: the layout caps the dialog
  // container at min(terminalWidth − 4, 100) (mainAreaWidth in AppContainer;
  // DiffDialog applies the same clamp). MaxSizedBox wraps the preview at this
  // width, and its height cap counts the WRAPPED rows — so this must never
  // exceed the dialog's actual inner text width (container − border 2 −
  // paddingX 2 = container − 4), or Ink would re-wrap at render time and
  // push rows past the cap. −6 keeps two columns of slack.
  const previewWidth = Math.max(20, Math.min(columns - 4, 100) - 6);

  const current = snapshot[index];
  const stagedPath = current?.stagedManifestPath;

  // Load a preview of the staged SKILL.md whenever the current skill changes.
  // A cancelled flag guards against a stale read landing after the user has
  // advanced (or the file was renamed away by resolving the previous skill).
  useEffect(() => {
    // A stale editor-launch error belongs to the previous skill; clear it when
    // the current skill changes so it doesn't look like the new one failed.
    setActionError(null);
    if (!stagedPath) return;
    let cancelled = false;
    let watcher: FSWatcher | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    // Keep an already-visible preview on screen during a reload — flashing
    // "Loading preview…" on every save would flicker.
    setPreview((prev) =>
      prev.status === 'ready' ? prev : { status: 'loading' },
    );
    readPreviewChunk(stagedPath)
      .then(({ text, truncated }) => {
        if (cancelled) return;
        // SKILL.md is model-generated; sanitize control characters before Ink
        // writes them. Sanitize before the split so a sequence can't hide across
        // a row boundary, then cap the rows we actually render: MaxSizedBox
        // truncates the DISPLAY only, so without this cap every line would still
        // be laid out and a giant file could freeze the dialog.
        // CRLF is an ordinary line ending (Windows-authored or editor-saved
        // files), not smuggled control bytes — normalize it before sanitizing
        // so lines don't end in a visible CR escape. A lone CR
        // (no LF) is still escaped: it can rewrite the current row.
        const allLines = sanitizeMultilineForDisplay(
          text.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
        ).split('\n');
        const lines = allLines.slice(0, PREVIEW_MAX_HEIGHT);
        setPreview({
          status: 'ready',
          path: stagedPath,
          lines,
          hiddenLines: allLines.length - lines.length,
          truncated,
        });
        // GUI editors need not block: the macOS default is `open -t`, which
        // returns as soon as TextEdit is told to open the file, so the
        // editor-resolve reload below fires before the user has saved anything.
        // Watch the staged file and re-read on every change instead. An
        // atomic-save rename can kill this watcher, but the bump re-runs the
        // effect, which re-attaches a fresh one.
        try {
          watcher = watch(stagedPath, () => {
            if (cancelled) return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              if (!cancelled) setReloadCounter((c) => c + 1);
            }, WATCH_DEBOUNCE_MS);
          });
          // Post-attach failures surface as async 'error' events, which are
          // an uncaught exception (fatal via the global handler) unless
          // consumed here. Same best-effort stance as the catch below: drop
          // the watcher and rely on the blocking-editor reload.
          watcher.on('error', () => {
            watcher?.close();
          });
        } catch {
          // Best-effort: without a watcher, the reload after a blocking
          // editor exits (below) still works.
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // ENOENT / EACCES / EIO all render the same "Preview unavailable" —
        // keep the underlying cause reachable via the debug log.
        debugLogger.warn(`skill preview read failed for ${stagedPath}:`, err);
        setPreview({ status: 'error' });
      });
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      watcher?.close();
    };
    // reloadCounter re-runs this after the editor closes or the watcher fires;
    // the cancelled flag still guards against a stale read landing after the
    // skill changed/unmount.
  }, [stagedPath, reloadCounter]);

  const turnOff = () => {
    // Persist for next launch...
    try {
      settings.setValue(
        SettingScope.Workspace,
        'memory.enableAutoSkill',
        false,
      );
    } catch (err) {
      // saveSettings re-throws write failures (read-only workspace, ENOSPC).
      // Surface the error and keep the dialog open with the feature untouched
      // so the choice can be retried — letting the throw escape the keypress
      // handler would take down the render tree.
      setActionError(
        `Failed to save setting: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // ...and stop the scheduler for the rest of THIS session (Config copies the
    // setting at startup, so persisting alone wouldn't take effect until relaunch
    // and another review could still pop this dialog after the user asked to stop).
    config.setAutoSkillEnabled(false);
    // Non-destructive: close WITHOUT marking the batch dismissed (onClose, not
    // onDismiss). The staged skills stay pending; the parent's auto-open is
    // gated on the live auto-skill flag, so the dialog stays away while the
    // feature is off but CAN reopen if the user re-enables it from /memory.
    // Esc's dismissed-set would suppress this batch for the whole session.
    onClose();
  };

  const openInEditor = () => {
    if (!stagedPath) return;
    setActionError(null);
    void launchEditor(stagedPath)
      .then(() => {
        // Re-read after a blocking (terminal) editor exits so the keep/discard
        // decision reflects the saved contents. Non-blocking GUI editors (the
        // macOS default `open -t` returns immediately) are covered by the
        // file watcher in the preview effect instead.
        setReloadCounter((c) => c + 1);
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
  };

  useKeypress(
    (key) => {
      if (key.ctrl || key.meta) return;
      if (key.name === 'escape') {
        onDismiss();
        return;
      }
      // `o` opens the staged skill in the editor WITHOUT advancing, so the user
      // can inspect (or edit) it before deciding keep/discard on return.
      if (key.name === 'o') {
        openInEditor();
        return;
      }
    },
    { isActive: true },
  );

  // Defensive: if mounted with nothing to review, close on the next tick
  // (cannot call a parent callback during render).
  useEffect(() => {
    if (snapshot.length === 0) onClose();
  }, [snapshot.length, onClose]);

  if (index >= snapshot.length || !current) {
    return null;
  }

  // Advance to the next snapshot entry; close once the last one is decided.
  const advance = () => {
    if (index + 1 >= snapshot.length) {
      onClose();
    } else {
      setIndex(index + 1);
    }
  };

  const handleSelect = (choice: Choice) => {
    switch (choice) {
      case 'keep':
        onAccept(current.name);
        advance();
        break;
      case 'discard':
        onReject(current.name);
        advance();
        break;
      case 'keepAll':
        for (let i = index; i < snapshot.length; i++) {
          onAccept(snapshot[i]!.name);
        }
        onClose();
        break;
      case 'discardAll':
        for (let i = index; i < snapshot.length; i++) {
          onReject(snapshot[i]!.name);
        }
        onClose();
        break;
      case 'turnOff':
        turnOff();
        break;
      default:
        break;
    }
  };

  const options: Array<RadioSelectItem<Choice>> = [
    { label: t('Keep this skill'), value: 'keep', key: 'keep' },
    { label: t('Discard this skill'), value: 'discard', key: 'discard' },
  ];
  // With only one skill left, "…all remaining" would mean exactly the same as
  // the per-skill options above — offering both is just misleading (and a
  // single-skill batch is the common case). Only show the bulk options while
  // they actually differ.
  if (snapshot.length - index > 1) {
    options.push(
      { label: t('Keep all remaining'), value: 'keepAll', key: 'keepAll' },
      {
        label: t('Discard all remaining'),
        value: 'discardAll',
        key: 'discardAll',
      },
    );
  }
  // Feature-level policy option, deliberately LAST — the same shape permission
  // prompts use for "don't ask again". A visible option is how an annoyed user
  // actually finds the off switch; a footer hotkey hint is not. The label names
  // the feature ("auto-generated skills"), not this skill, so it can't be
  // misread as a per-skill action.
  options.push({
    label: t('Turn off auto-generated skills'),
    value: 'turnOff',
    key: 'turnOff',
  });

  // The keep-ready-during-reload logic above avoids flicker for SAME-file
  // re-reads, but after advancing to the next skill the state still holds the
  // previous skill's body until the new read lands. Guard by path at render so
  // that window shows "Loading preview…" instead of the wrong skill's content.
  const visiblePreview: PreviewState =
    preview.status === 'ready' && preview.path !== stagedPath
      ? { status: 'loading' }
      : preview;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        {t('Auto-generated skill — keep it?')} ({index + 1}/{snapshot.length})
      </Text>
      <Box marginTop={1} flexDirection="column">
        {/* Name and description are model-generated too — sanitize them just
            like the preview body, or an escape sequence in the frontmatter
            would reach the terminal through the header. */}
        <Text color={theme.text.primary}>
          {sanitizeFilenameForDisplay(current.name)}
        </Text>
        {current.description ? (
          <Text color={theme.text.secondary}>
            {sanitizeMultilineForDisplay(current.description)}
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {visiblePreview.status === 'loading' ? (
          <Text color={theme.text.secondary}>{t('Loading preview…')}</Text>
        ) : visiblePreview.status === 'error' ? (
          <Text color={theme.text.secondary}>{t('Preview unavailable')}</Text>
        ) : (
          <>
            <MaxSizedBox
              maxHeight={PREVIEW_MAX_HEIGHT}
              maxWidth={previewWidth}
              overflowDirection="bottom"
              additionalHiddenLinesCount={visiblePreview.hiddenLines}
            >
              {visiblePreview.lines.map((line, i) => (
                <Box key={i}>
                  {/* wrap MUST be explicit: MaxSizedBox's layout treats a Text
                      with props but no wrap="wrap" as non-wrapping, while Ink
                      wraps it at render — long lines would then render more
                      rows than the height cap accounts for. */}
                  <Text wrap="wrap" color={theme.text.secondary}>
                    {line === '' ? ' ' : line}
                  </Text>
                </Box>
              ))}
            </MaxSizedBox>
            {/* Byte-cap truncation is a distinct omission from the line-hidden
                marker above, and can happen with no lines hidden at all. */}
            {visiblePreview.truncated ? (
              <Text color={theme.text.secondary}>
                {t('… preview truncated (file too large) …')}
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {actionError ? (
        <Box marginTop={1}>
          {/* Error messages can embed the staged path, whose basename derives
              from the model-generated skill name — sanitize like the rest. */}
          <Text color={theme.status.error}>
            {sanitizeMultilineForDisplay(actionError)}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <RadioButtonSelect items={options} onSelect={handleSelect} isFocused />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('o open in editor · Esc decide later')}
        </Text>
      </Box>
    </Box>
  );
};
