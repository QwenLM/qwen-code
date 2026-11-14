/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  sanitizeFilenameForDisplay,
  sanitizeMultilineForDisplay,
  sanitizeTerminalText,
  truncateToWidth,
} from '../utils/textUtils.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import type { NativeSkillReviewBatch } from './use-skill-review.js';
import { useNativeFileEditor } from './use-native-file-editor.js';
import {
  DialogFrame,
  DialogSelect,
  dialogContentWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { scrollDialogLayout, wrappedRows } from './dialogs-core.js';
import { C } from './theme.js';

type Choice = 'keep' | 'discard' | 'keepAll' | 'discardAll' | 'turnOff';
interface Props {
  batch: NativeSkillReviewBatch;
  settings: LoadedSettings;
  host: Pick<OpenTuiAppHost, 'config' | 'settings'>;
  onClose: () => void;
  onDismiss: () => void;
  availableTerminalHeight?: number;
}

export function OpenTuiSkillReviewDialog(props: Props) {
  const generation = useRef({
    task: props.batch.task,
    owner: props.batch.generation,
    config: props.batch.config,
    settings: props.settings,
    host: props.host,
    id: 0,
  });
  if (
    generation.current.task !== props.batch.task ||
    generation.current.owner !== props.batch.generation ||
    generation.current.config !== props.batch.config ||
    generation.current.settings !== props.settings ||
    generation.current.host !== props.host
  )
    generation.current = {
      task: props.batch.task,
      owner: props.batch.generation,
      config: props.batch.config,
      settings: props.settings,
      host: props.host,
      id: generation.current.id + 1,
    };
  return <SkillReviewBody key={generation.current.id} {...props} />;
}

function SkillReviewBody(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { batch, settings, host } = props;
  const identity = useRef({
    batch,
    settings,
    host,
    target: settings.workspace.path,
    trusted: settings.isTrusted,
    revoked: false,
    closed: false,
  });
  const owner = identity.current;
  const [snapshot] = useState(() =>
    batch.skills.map((skill) => ({ ...skill })),
  );
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [, invalidate] = useState(0);
  const active = () => {
    if (
      !mounted.current ||
      identity.current !== owner ||
      owner.revoked ||
      owner.closed
    )
      return false;
    const now = latest.current;
    if (
      !owner.batch.isCurrent() ||
      now.batch.task !== owner.batch.task ||
      now.batch.config !== owner.batch.config ||
      now.settings !== owner.settings ||
      now.settings.workspace.path !== owner.target ||
      now.settings.isTrusted !== owner.trusted ||
      now.host !== owner.host ||
      host.config !== batch.config ||
      host.settings !== settings
    ) {
      owner.revoked = true;
      return false;
    }
    return true;
  };
  const assertOwner = () => {
    if (!active())
      throw new Error(
        t('The session changed. Close this dialog and try again.'),
      );
  };
  const current = snapshot[index];
  const assertSkill = (skill: NonNullable<typeof current>) => {
    assertOwner();
    const live = batch.manager.getTask(batch.task.id)?.metadata?.[
      'pendingSkills'
    ] as typeof snapshot | undefined;
    if (
      !live?.some(
        (item) =>
          item.name === skill.name &&
          item.stagedManifestPath === skill.stagedManifestPath,
      )
    )
      throw new Error(
        'This skill is no longer pending. Close this dialog and try again.',
      );
  };
  const close = (dismiss: boolean) => {
    if (!active()) return;
    owner.closed = true;
    if (dismiss) latest.current.onDismiss();
    else latest.current.onClose();
  };
  const launchEditor = useNativeFileEditor(settings, assertOwner);
  const [reload, setReload] = useState(0);
  const stagedPath = current?.stagedManifestPath;
  const [preview, setPreview] = useState<{
    path: string;
    text: string;
    truncated: boolean;
  } | null>(null);
  useEffect(() => {
    if (!current || !stagedPath) {
      if (!current) close(false);
      return;
    }
    let cancelled = false;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      assertSkill(current);
      const handle = await fs.open(stagedPath, 'r');
      let text: string;
      let truncated: boolean;
      try {
        assertSkill(current);
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer
          .subarray(0, Math.min(bytesRead, 64 * 1024))
          .toString('utf8');
        truncated = bytesRead > 64 * 1024;
      } finally {
        await handle.close();
      }
      if (cancelled || !active()) return;
      assertSkill(current);
      setPreview({ path: stagedPath, text, truncated });
      try {
        watcher = watch(stagedPath, { persistent: false }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!cancelled && active()) setReload((value) => value + 1);
          }, 300);
        });
        watcher.on('error', () => watcher?.close());
      } catch {
        /* A blocking editor still reloads when watching is unavailable. */
      }
    })().catch(() => {
      if (!cancelled && active())
        setPreview({
          path: stagedPath,
          text: t('Preview unavailable'),
          truncated: false,
        });
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      watcher?.close();
    };
    // Each task-keyed dialog owns its immutable batch; only its selected file reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedPath, reload]);
  const choose = async (choice: Choice) => {
    if (pending.current || !active() || !current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (choice === 'turnOff') {
        settings.setValue(
          SettingScope.Workspace,
          'memory.enableAutoSkill',
          false,
          assertOwner,
          { throwOnWriteFailure: true },
        );
        assertOwner();
        batch.config.setAutoSkillEnabled(false);
        close(false);
        return;
      }
      const all = choice === 'keepAll' || choice === 'discardAll';
      const stop = all ? snapshot.length : indexRef.current + 1;
      while (indexRef.current < stop) {
        const skill = snapshot[indexRef.current]!;
        assertSkill(skill);
        if (choice === 'keep' || choice === 'keepAll')
          await batch.manager.acceptPendingSkillFromTask(
            batch.task.id,
            skill.name,
          );
        else
          await batch.manager.rejectPendingSkillFromTask(
            batch.task.id,
            skill.name,
          );
        if (!active()) return;
        indexRef.current++;
        setIndex(indexRef.current);
      }
      if (indexRef.current >= snapshot.length) close(false);
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (active()) setBusy(false);
    }
  };
  const dimensions = useTerminalDimensions();
  const width = dialogContentWidth(dimensions.width);
  const layout = scrollDialogLayout(
    props.availableTerminalHeight ?? dimensions.height,
    6,
    28,
  );
  const bodyRows = Math.max(0, layout.bodyRows);
  const options = [
    { key: 'keep', label: t('Keep this skill'), value: 'keep' as Choice },
    {
      key: 'discard',
      label: t('Discard this skill'),
      value: 'discard' as Choice,
    },
    ...(snapshot.length - index > 1
      ? [
          {
            key: 'keepAll',
            label: t('Keep all remaining'),
            value: 'keepAll' as Choice,
          },
          {
            key: 'discardAll',
            label: t('Discard all remaining'),
            value: 'discardAll' as Choice,
          },
        ]
      : []),
    {
      key: 'turnOff',
      label: t('Turn off auto-generated skills'),
      value: 'turnOff' as Choice,
    },
  ];
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const reveal = useRef<string | null>('skill-review-option-keep');
  const selection = useDialogSelect({
    items: options,
    resyncKey: index,
    maxItemsToShow: options.length,
    focused: !busy && bodyRows > 0 && width >= 7 && !owner.revoked,
    onSelect: (choice) => {
      void choose(choice);
    },
    onHighlight: (choice) => {
      reveal.current = `skill-review-option-${choice}`;
    },
  });
  const activeChoice = options[selection.activeIndex]?.value ?? 'keep';
  useLayoutEffect(() => {
    reveal.current = `skill-review-option-${activeChoice}`;
    scroll.current?.requestRender();
  }, [activeChoice, bodyRows, width, index, preview, error]);
  useKeyboard((key) => {
    if (key.eventType === 'release' || key.ctrl || key.meta) return;
    if (!active()) {
      if (
        mounted.current &&
        identity.current === owner &&
        !owner.closed &&
        key.name === 'escape'
      ) {
        owner.closed = true;
        latest.current.onClose();
      }
      return;
    }
    if (pending.current) return;
    if (key.name === 'escape') {
      close(true);
      return;
    }
    if (key.name === 'o' && current && bodyRows > 0 && width >= 7) {
      try {
        assertSkill(current);
        launchEditor(current.stagedManifestPath);
        if (active()) {
          setError('');
          setReload((value) => value + 1);
        }
      } catch (failure) {
        if (active())
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      }
      invalidate((value) => value + 1);
    }
  });
  const loaded = preview?.path === stagedPath ? preview : null;
  const lines = loaded
    ? sanitizeMultilineForDisplay(loaded.text.replace(/\r\n/g, '\n'))
        .replace(/\n+$/, '')
        .split('\n')
    : [t('Loading preview…')];
  const visible: string[] = [];
  let rows = 0;
  for (const line of lines.slice(0, 12)) {
    const next = wrappedRows(line, Math.max(1, width - 1));
    if (rows + next > Math.min(12, bodyRows)) break;
    visible.push(line);
    rows += next;
  }
  return (
    <DialogFrame bodyLayout={layout}>
      {!layout.compact && (
        <text fg={C.accent} height={1}>
          {truncateToWidth(
            `${t('Auto-generated skill — keep it?')} (${Math.min(index + 1, snapshot.length)}/${snapshot.length})`,
            width,
          )}
        </text>
      )}
      <scrollbox
        ref={(node) => {
          scroll.current = node;
        }}
        height={bodyRows}
        width="100%"
        contentOptions={{ width: '100%', paddingRight: 1 }}
        onSizeChange={() => {
          reveal.current = `skill-review-option-${options[selection.activeIndexRef.current]?.value ?? 'keep'}`;
          scroll.current?.requestRender();
        }}
        renderAfter={() => {
          if (reveal.current) {
            const target = reveal.current;
            reveal.current = null;
            scroll.current?.scrollChildIntoView(target);
          }
        }}
      >
        <text fg={C.text} wrapMode="word" width="100%">
          {sanitizeTerminalText(
            sanitizeFilenameForDisplay(current?.name ?? ''),
          )}
        </text>
        {current?.description && (
          <text fg={C.dim} wrapMode="word" width="100%">
            {sanitizeTerminalText(
              sanitizeMultilineForDisplay(current.description),
            )}
          </text>
        )}
        <text fg={C.text} wrapMode="word" width="100%">
          {sanitizeTerminalText(visible.join('\n'))}
        </text>
        {visible.length < lines.length && (
          <text fg={C.dim}>… {lines.length - visible.length} more lines …</text>
        )}
        {loaded?.truncated && (
          <text fg={C.dim}>{t('… preview truncated (file too large) …')}</text>
        )}
        {error && (
          <text fg={C.red} wrapMode="word" width="100%">
            {sanitizeTerminalText(error)}
          </text>
        )}
        {owner.revoked ? (
          <text fg={C.dim}>
            {t('The session changed. Close this dialog and try again.')}
          </text>
        ) : (
          <box id="skill-review-options" flexDirection="column">
            <DialogSelect
              {...selection}
              maxItemsToShow={options.length}
              onSelectIndex={selection.selectIndex}
              onHover={selection.highlightIndex}
              renderLabel={(item, { titleColor }) => (
                <text
                  fg={titleColor}
                  id={`skill-review-option-${item.value}`}
                  wrapMode="word"
                  width="100%"
                >
                  {item.label}
                </text>
              )}
            />
          </box>
        )}
      </scrollbox>
      {!layout.compact && (
        <text fg={C.dim} height={1}>
          {truncateToWidth(t('o open in editor · Esc decide later'), width)}
        </text>
      )}
    </DialogFrame>
  );
}
