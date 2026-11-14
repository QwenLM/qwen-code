/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getAllMemoryFilenames } from '@qwen-code/qwen-code-core/utils/memory-constants.js';
import {
  getEditorExecutable,
  type EditorType,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import {
  getAutoMemoryRoot,
  getAutoMemoryProjectStateDir,
  getUserAutoMemoryRoot,
  AUTO_MEMORY_INDEX_FILENAME,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { sanitizeTerminalText, truncateToWidth } from '../utils/textUtils.js';
import {
  releaseProgramStatus,
  restoreProgramStatus,
} from '../../utils/program-status.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import { DialogFrame, dialogContentWidth } from './dialogs-shared.js';
import { scrollDialogLayout, wrappedRows } from './dialogs-core.js';
import { toOriginalKey, Command } from './key-map.js';
import { keyMatchers } from '../keyMatchers.js';
import { C } from './theme.js';

const keys = [
  'enableManagedAutoMemory',
  'enableManagedAutoDream',
  'enableAutoSkill',
  'autoSkillConfirm',
] as const;
const labels = [
  'Auto-memory: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run',
  'Auto-skill: {{status}}',
  'Confirm auto-skills before saving: {{status}}',
];
type Values = Record<(typeof keys)[number], boolean>;
interface Props {
  config?: Config;
  settings: LoadedSettings;
  host?: Pick<OpenTuiAppHost, 'config' | 'settings'>;
  onClose: () => void;
  availableTerminalHeight?: number;
}

export function readMemoryToggle(
  value: unknown,
  modes: { bareMode: boolean; safeMode: boolean },
): boolean {
  return !modes.bareMode && !modes.safeMode && Boolean(value ?? true);
}

export function resolvePreferredMemoryFile(dir: string): string {
  const names = getAllMemoryFilenames();
  return (
    names
      .map((name) => path.join(dir, name))
      .find((file) => existsSync(file)) ?? path.join(dir, names[0] ?? 'QWEN.md')
  );
}

function readOwner({ config, settings, host }: Props) {
  if (!config || !host || host.config !== config || host.settings !== settings)
    return null;
  return {
    config,
    settings,
    host,
    session: config.getSessionId(),
    cwd: config.getWorkingDir(),
    project: config.getProjectRoot(),
    target: settings.workspace.path,
    trusted: settings.isTrusted,
    bare: config.getBareMode(),
    safe: config.isSafeMode(),
    managed: config.isManagedMemoryAvailable(),
    names: getAllMemoryFilenames().join('\0'),
    user: Storage.getGlobalQwenDir(),
    managedUser: getUserAutoMemoryRoot(),
    managedProject: getAutoMemoryRoot(config.getProjectRoot()),
  };
}
type Owner = NonNullable<ReturnType<typeof readOwner>>;
function sameOwner(
  a: ReturnType<typeof readOwner>,
  b: ReturnType<typeof readOwner>,
) {
  return (
    a !== null &&
    b !== null &&
    Object.keys(a).every(
      (key) => a[key as keyof Owner] === b[key as keyof Owner],
    )
  );
}

export function OpenTuiMemoryDialog(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = readOwner(props);
  const token = useRef({ owner, revoked: false, closed: false, id: 0 });
  const previous = token.current.owner;
  if (
    previous?.config !== owner?.config ||
    previous?.settings !== owner?.settings ||
    previous?.host !== owner?.host
  )
    token.current = {
      owner,
      revoked: false,
      closed: false,
      id: token.current.id + 1,
    };
  else if (!sameOwner(previous, owner)) token.current.revoked = true;
  const captured = token.current;
  const [, invalidate] = useState(0);
  const dimensions = useTerminalDimensions();
  const active = useCallback(() => {
    if (!mounted.current || token.current !== captured || captured.revoked)
      return false;
    if (!sameOwner(captured.owner, readOwner(latest.current))) {
      captured.revoked = true;
      invalidate((value) => value + 1);
      return false;
    }
    return true;
  }, [captured]);
  useKeyboard((key) => {
    if (
      mounted.current &&
      token.current === captured &&
      !captured.closed &&
      key.eventType !== 'release' &&
      (!owner || captured.revoked) &&
      toOriginalKey(key).name === 'escape'
    ) {
      captured.closed = true;
      latest.current.onClose();
    }
  });
  if (!owner || captured.revoked) {
    const layout = scrollDialogLayout(
      props.availableTerminalHeight ?? dimensions.height,
      4,
      2,
    );
    const width = layout.border
      ? dialogContentWidth(dimensions.width)
      : Math.max(0, dimensions.width - 4);
    return (
      <DialogFrame bodyLayout={layout}>
        <box
          flexDirection="column"
          height={Math.max(0, layout.bodyRows)}
          overflow="hidden"
        >
          {[
            t('Memory'),
            t('Memory owner changed. Close and reopen this dialog.'),
          ]
            .slice(0, Math.max(0, layout.bodyRows))
            .map((line) => (
              <text key={line} fg={C.dim} height={1}>
                {truncateToWidth(sanitizeTerminalText(line), width)}
              </text>
            ))}
        </box>
      </DialogFrame>
    );
  }
  return (
    <MemoryView
      key={`${captured.id}`}
      owner={captured.owner!}
      active={active}
      onClose={() => {
        if (active()) {
          captured.revoked = true;
          captured.closed = true;
          latest.current.onClose();
        }
      }}
      availableTerminalHeight={props.availableTerminalHeight}
    />
  );
}

function MemoryView({
  owner,
  active,
  onClose,
  availableTerminalHeight,
}: {
  owner: Owner;
  active: () => boolean;
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const { config, settings } = owner;
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [values, setValues] = useState<Values>(
    () =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          readMemoryToggle(settings.merged.memory?.[key], {
            bareMode: config.getBareMode(),
            safeMode: config.isSafeMode(),
          }),
        ]),
      ) as Values,
  );
  const valuesRef = useRef(values);
  const [focus, setFocus] = useState(4);
  const focusRef = useRef(focus);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [lastDream, setLastDream] = useState<number | null>(null);
  const managed = owner.managed;
  const user = managed
    ? owner.managedUser
    : resolvePreferredMemoryFile(owner.user);
  const project = managed
    ? owner.managedProject
    : resolvePreferredMemoryFile(owner.cwd);
  useEffect(() => {
    let cancelled = false;
    void fs
      .readFile(
        path.join(getAutoMemoryProjectStateDir(owner.project), 'meta.json'),
        'utf8',
      )
      .then((content) => {
        if (cancelled || !active()) return;
        const parsed = JSON.parse(content) as { lastDreamAt?: string };
        const timestamp = parsed.lastDreamAt
          ? new Date(parsed.lastDreamAt).getTime()
          : NaN;
        if (Number.isFinite(timestamp)) setLastDream(timestamp);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner.project, active]);
  const assertOwner = () => {
    if (!active())
      throw new Error('Memory owner changed. Close and reopen this dialog.');
  };
  const display = (file: string) =>
    file.startsWith(os.homedir() + path.sep)
      ? '~' + file.slice(os.homedir().length)
      : file;
  const status = (value: boolean) => (value ? t('on') : t('off'));
  const rows = [
    ...keys.map(
      (key, index) =>
        `${focus === index ? '› ' : '  '}${t(labels[index], { status: status(values[key]), lastDream: lastDream === null ? t('never') : formatRelativeTime(lastDream) })}`,
    ),
    `${focus === 4 ? '› ' : '  '}1. ${t('User memory')}`,
    '  ' + t('Saved in {{path}}', { path: display(user) }),
    `${focus === 5 ? '› ' : '  '}2. ${t('Project memory')}`,
    '  ' +
      t('Saved in {{path}}', {
        path: managed
          ? display(project)
          : path.relative(owner.cwd, project) || path.basename(project),
      }),
  ];
  const regionHeight = availableTerminalHeight ?? height;
  const contentWidth =
    regionHeight >= 3 ? dialogContentWidth(width) : Math.max(0, width - 4);
  const bodyCap = [...(error ? [error] : []), ...rows].reduce(
    (total, row) =>
      total +
      wrappedRows(sanitizeTerminalText(row), Math.max(1, contentWidth - 1)),
    0,
  );
  const layout = scrollDialogLayout(regionHeight, 6, bodyCap);
  const bodyRows = Math.max(0, layout.bodyRows);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const reveal = useRef<string | null>(`memory-focus-${focus}`);
  useLayoutEffect(() => {
    reveal.current = `memory-focus-${focus}`;
    scroll.current?.requestRender();
  }, [focus, bodyRows, width]);
  useLayoutEffect(() => {
    if (error) {
      reveal.current = 'memory-error';
      scroll.current?.requestRender();
    }
  }, [error]);
  const canAct = bodyRows > 0 && contentWidth >= 4;

  const launchEditor = (file: string) => {
    const preferred = settings.merged.general?.preferredEditor as
      | EditorType
      | undefined;
    const editor = preferred
      ? getEditorExecutable(preferred)
      : process.platform === 'darwin'
        ? 'open -t'
        : process.platform === 'win32'
          ? 'notepad'
          : process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
    if (!editor)
      throw new Error(
        `No available editor found for ${preferred}. Please install a supported editor or set a different preferredEditor in settings.`,
      );
    assertOwner();
    let suspended = false;
    try {
      suspended = true;
      renderer.suspend();
      releaseProgramStatus();
      const command = editor === 'open -t' ? 'open' : editor;
      const args = editor === 'open -t' ? ['-t', file] : [file];
      const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: process.platform === 'win32' && /\.(cmd|bat)$/.test(command),
      });
      if (result.error) throw result.error;
      if (result.signal)
        throw new Error(`Editor was killed by signal ${result.signal}`);
      if (typeof result.status === 'number' && result.status !== 0)
        throw new Error(`Editor exited with status ${result.status}`);
    } finally {
      try {
        restoreProgramStatus();
      } finally {
        if (suspended) renderer.resume();
      }
    }
  };
  const ensureFile = async (file: string) => {
    assertOwner();
    await fs.mkdir(path.dirname(file), { recursive: true });
    assertOwner();
    try {
      await fs.access(file);
    } catch {
      assertOwner();
      await fs.writeFile(file, '', 'utf8');
    }
    assertOwner();
  };
  const select = async (index: number) => {
    if (pending.current || !canAct || !active()) return;
    pending.current = true;
    setError(null);
    try {
      const file = index === 4 ? user : project;
      if (managed) {
        assertOwner();
        await fs.mkdir(file, { recursive: true });
        assertOwner();
        if (
          process.platform === 'darwin' ||
          process.platform === 'win32' ||
          ['DISPLAY', 'WAYLAND_DISPLAY', 'MIR_SOCKET'].some((key) =>
            Boolean(process.env[key]),
          )
        ) {
          const command =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'explorer'
                : 'xdg-open';
          const child = spawn(command, [file], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('spawn', () => resolve());
          });
        } else {
          const target = path.join(file, AUTO_MEMORY_INDEX_FILENAME);
          await ensureFile(target);
          launchEditor(target);
        }
      } else {
        await ensureFile(file);
        launchEditor(file);
      }
      if (active()) onClose();
    } catch (failure) {
      if (active())
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
    }
  };
  useKeyboard((event) => {
    if (event.eventType === 'release' || !active() || pending.current) return;
    const key = toOriginalKey(event);
    if (key.name === 'escape') {
      onClose();
      return;
    }
    if (!canAct) return;
    let next = focusRef.current;
    if (keyMatchers[Command.SELECTION_UP](key)) next = Math.max(0, next - 1);
    else if (keyMatchers[Command.SELECTION_DOWN](key))
      next = next === 5 ? 4 : next + 1;
    else if (key.name === 'return') {
      if (next >= 4) {
        void select(next);
        return;
      }
      const field = keys[next];
      const value = !valuesRef.current[field];
      try {
        assertOwner();
        settings.setValue(
          SettingScope.Workspace,
          `memory.${field}`,
          value,
          assertOwner,
          { throwOnWriteFailure: true },
        );
        assertOwner();
        if (field === 'enableAutoSkill') config.setAutoSkillEnabled(value);
        const updated = { ...valuesRef.current, [field]: value };
        valuesRef.current = updated;
        setValues(updated);
        setError(null);
      } catch (failure) {
        if (active())
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      }
      return;
    } else if (next >= 4 && (key.sequence === '1' || key.sequence === '2')) {
      void select(Number(key.sequence) + 3);
      return;
    } else return;
    focusRef.current = next;
    setFocus(next);
  });
  return (
    <DialogFrame bodyLayout={layout}>
      {!layout.compact && (
        <text fg={C.accent} attributes={1}>
          {t('Memory')}
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
          reveal.current = error
            ? 'memory-error'
            : `memory-focus-${focusRef.current}`;
        }}
        renderAfter={() => {
          const target = reveal.current;
          if (!target) return;
          reveal.current = null;
          scroll.current?.scrollChildIntoView(target);
        }}
      >
        {error && (
          <text id="memory-error" fg={C.red} width="100%" wrapMode="word">
            {sanitizeTerminalText(error)}
          </text>
        )}
        {rows.map((row, index) => (
          <text
            id={
              index < 5
                ? `memory-focus-${index}`
                : index === 6
                  ? 'memory-focus-5'
                  : undefined
            }
            key={index}
            fg={C.text}
            width="100%"
            wrapMode="word"
          >
            {sanitizeTerminalText(row)}
          </text>
        ))}
      </scrollbox>
      {!layout.compact && (
        <text fg={C.dim}>{t('Enter to confirm · Esc to cancel')}</text>
      )}
    </DialogFrame>
  );
}
