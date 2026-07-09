import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  useOptionalWorkspace,
  type DaemonWorkspaceMcpServerStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import type { SkillInfo } from '../../completions/slashCompletion';
import { AtMentionPanel } from '../AtMentionPanel';
import {
  clearInlineTagsEffect,
  getInlineComposerTags,
  useComposerCore,
} from '../../hooks/useComposerCore';
import type {
  WebShellAtProvider,
  WebShellComposerTag,
} from '../../customization';
import { getComposerTagIconUrl } from '../composerTagIcons';
import { cssUrlVar } from '../../utils/cssUrlVar';
import { useI18n } from '../../i18n';
import styles from './ScheduledTasksDialog.module.css';

const PROMPT_EDITOR_THEME = {
  '&': {
    fontSize: '13px',
    background: 'transparent',
    border: 'none',
    borderRadius: '0',
    minHeight: '96px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    minHeight: '96px',
    maxHeight: '240px',
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  '.cm-content': {
    padding: '8px 10px',
    fontFamily: 'inherit',
    color: 'var(--foreground)',
    caretColor: 'var(--primary)',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'var(--muted-foreground)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--primary)',
    borderLeftWidth: '2px',
  },
} satisfies Parameters<typeof EditorView.theme>[0];

interface ScheduledTaskPromptEditorProps {
  prompt: string;
  mentions: WebShellComposerTag[];
  skills: SkillInfo[];
  onChange: (next: { prompt: string; mentions: WebShellComposerTag[] }) => void;
}

type PickerCategory = 'skill' | 'extension' | 'mcp';

function toSkillProvider(skills: SkillInfo[]): WebShellAtProvider {
  return {
    id: 'skills',
    label: 'Skills',
    description: 'Run an available skill',
    order: 1,
    async search({ query }) {
      const lower = query.toLowerCase();
      return skills
        .filter((skill) => {
          return (
            skill.name.toLowerCase().includes(lower) ||
            skill.description.toLowerCase().includes(lower)
          );
        })
        .map((skill) => ({
          id: `skill:${skill.name}`,
          label: skill.name,
          description: skill.description,
          insertText: `/${skill.name} `,
          composerTag: {
            id: `skill:${skill.name}`,
            kind: 'skill',
            label: skill.name,
            serialized: `/${skill.name}`,
          },
        }));
    },
  };
}

function mergeTags(
  current: readonly WebShellComposerTag[],
  incoming: readonly WebShellComposerTag[],
): WebShellComposerTag[] {
  const next = [...current];
  for (const tag of incoming) {
    const existingIndex = next.findIndex((item) => item.id === tag.id);
    if (existingIndex >= 0) {
      next[existingIndex] = tag;
    } else {
      next.push(tag);
    }
  }
  return next;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripInlineTagText(
  text: string,
  tags: readonly WebShellComposerTag[],
): string {
  let next = text;
  for (const tag of tags) {
    const serialized = tag.serialized?.trim();
    if (!serialized) continue;
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(serialized)}(?=\\s|$)`);
    next = next.replace(pattern, (_match, leadingWs: string) => leadingWs);
  }
  return next
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderTagContent(tag: WebShellComposerTag) {
  const iconUrl = getComposerTagIconUrl(tag.kind);
  const label = tag.label?.trim() ?? '';
  const value = tag.value?.trim() ?? '';
  return (
    <>
      {iconUrl && (
        <span
          className={styles.promptTagIcon}
          style={cssUrlVar('--composer-tag-icon-url', iconUrl)}
          aria-hidden="true"
        />
      )}
      <span className={styles.promptTagLabel}>{value || label || tag.id}</span>
    </>
  );
}

export function ScheduledTaskPromptEditor({
  prompt,
  mentions,
  skills,
  onChange,
}: ScheduledTaskPromptEditorProps) {
  const { t } = useI18n();
  const workspace = useOptionalWorkspace();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const atPanelRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerCategory, setPickerCategory] = useState<PickerCategory | null>(
    null,
  );
  const pickerOpen = pickerCategory !== null;
  const [extensions, setExtensions] = useState<
    Array<{ name: string; displayName?: string }>
  >([]);
  const [mcpServers, setMcpServers] = useState<
    DaemonWorkspaceMcpServerStatus[]
  >([]);
  const skillProvider = useMemo(() => toSkillProvider(skills), [skills]);
  const core = useComposerCore({
    onSubmit: () => false,
    disabled: false,
    placeholderText: t('scheduledTasks.promptPlaceholder'),
    commands: [],
    skills: [],
    currentMode: 'default',
    dialogOpen: true,
    atProviders: skills.length > 0 ? [skillProvider] : [],
    editorTheme: PROMPT_EDITOR_THEME,
    composerInput: {
      text: prompt,
      tags: mentions,
      tagPlacement: 'top',
    },
    composerInputVersion: 1,
  });

  const syncPromptOnly = (
    nextPrompt: string,
    nextMentions = core.composerTags,
  ) => {
    onChange({ prompt: nextPrompt, mentions: nextMentions });
  };

  const normalizeInlineMentions = () => {
    const view = core.viewRef.current;
    const inlineTags = view ? getInlineComposerTags(view) : [];
    const nextPrompt = stripInlineTagText(core.getText(), inlineTags);
    if (inlineTags.length > 0 && view) {
      view.dispatch({ effects: clearInlineTagsEffect.of() });
      core.replaceEditorText(nextPrompt);
      core.addTags(inlineTags);
      const merged = mergeTags(core.composerTags, inlineTags);
      onChange({ prompt: nextPrompt, mentions: merged });
      return;
    }
    syncPromptOnly(nextPrompt);
  };

  const handleAcceptMention = (index?: number) => {
    const accepted = core.acceptAtCompletion(index);
    if (accepted) {
      queueMicrotask(() => {
        normalizeInlineMentions();
        core.focus();
      });
    }
    return accepted;
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && pickerRef.current?.contains(target)) {
        return;
      }
      setPickerCategory(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (!workspace?.actions || !pickerOpen) return;
    void workspace.actions.loadExtensionsStatus().then((status) => {
      setExtensions(
        status.extensions
          .filter((extension) => extension.isActive)
          .map((extension) => ({
            name: extension.name,
            displayName: extension.displayName,
          })),
      );
    });
    void workspace.actions.loadMcpStatus().then((status) => {
      setMcpServers(status.servers.filter((server) => !server.disabled));
    });
  }, [pickerOpen, workspace]);

  const insertTag = (tag: WebShellComposerTag) => {
    core.addTags([tag]);
    const nextMentions = mergeTags(core.composerTags, [tag]);
    const nextPrompt = stripInlineTagText(core.getText(), []);
    onChange({ prompt: nextPrompt, mentions: nextMentions });
    setPickerCategory(null);
    queueMicrotask(() => core.focus());
  };

  const removeTag = (id: string) => {
    const nextMentions = core.composerTags.filter(
      (tag) => tag.id !== id || tag.removable === false,
    );
    core.removeTopTag(id);
    onChange({
      prompt: stripInlineTagText(core.getText(), []),
      mentions: nextMentions,
    });
    queueMicrotask(() => core.focus());
  };

  return (
    <div className={styles.promptEditorWrap}>
      <div
        ref={anchorRef}
        className={styles.promptEditor}
        style={{
          ['--web-shell-popover-z-index' as string]: '3050',
        }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('button')) return;
          queueMicrotask(() => core.focus());
        }}
      >
        <div className={styles.promptEditorContent}>
          {core.composerTags.map((tag) => (
            <span key={tag.id} className={styles.promptTag}>
              {renderTagContent(tag)}
              {tag.removable !== false && (
                <button
                  type="button"
                  className={styles.promptTagRemove}
                  aria-label={`Remove ${tag.label ?? tag.value ?? tag.id}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => removeTag(tag.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}

          <div
            ref={core.containerRef}
            className={styles.promptEditorInput}
            onBlur={() => queueMicrotask(normalizeInlineMentions)}
            onKeyUp={() => queueMicrotask(normalizeInlineMentions)}
            onMouseUp={() => queueMicrotask(normalizeInlineMentions)}
          />
        </div>

        <div className={styles.promptEditorToolbar}>
          <button
            type="button"
            className={`${styles.promptEditorAction} ${
              pickerCategory === 'extension'
                ? styles.promptEditorActionActive
                : ''
            }`}
            onClick={() =>
              setPickerCategory((current) =>
                current === 'extension' ? null : 'extension',
              )
            }
            aria-label="Insert extension mention"
          >
            <span
              className={styles.promptEditorActionIcon}
              style={cssUrlVar(
                '--composer-tag-icon-url',
                getComposerTagIconUrl('extension') ?? '',
              )}
              aria-hidden="true"
            />
            <span className={styles.promptEditorActionLabel}>扩展</span>
          </button>
          <button
            type="button"
            className={`${styles.promptEditorAction} ${
              pickerCategory === 'skill' ? styles.promptEditorActionActive : ''
            }`}
            onClick={() =>
              setPickerCategory((current) =>
                current === 'skill' ? null : 'skill',
              )
            }
            aria-label="Insert skill mention"
          >
            <span
              className={styles.promptEditorActionIcon}
              style={cssUrlVar(
                '--composer-tag-icon-url',
                getComposerTagIconUrl('skill') ?? '',
              )}
              aria-hidden="true"
            />
            <span className={styles.promptEditorActionLabel}>技能</span>
          </button>
          <button
            type="button"
            className={`${styles.promptEditorAction} ${
              pickerCategory === 'mcp' ? styles.promptEditorActionActive : ''
            }`}
            onClick={() =>
              setPickerCategory((current) => (current === 'mcp' ? null : 'mcp'))
            }
            aria-label="Insert MCP mention"
          >
            <span
              className={styles.promptEditorActionIcon}
              style={cssUrlVar(
                '--composer-tag-icon-url',
                getComposerTagIconUrl('mcp') ?? '',
              )}
              aria-hidden="true"
            />
            <span className={styles.promptEditorActionLabel}>MCP</span>
          </button>
        </div>

        {pickerOpen && (
          <div ref={pickerRef} className={styles.promptPicker}>
            <div className={styles.promptPickerCols}>
              <div className={styles.promptPickerCol}>
                <button
                  type="button"
                  className={styles.promptPickerItem}
                  onMouseEnter={() => setPickerCategory('skill')}
                  onClick={() => setPickerCategory('skill')}
                >
                  <span className={styles.promptPickerLabel}>技能</span>
                </button>
                <button
                  type="button"
                  className={styles.promptPickerItem}
                  onMouseEnter={() => setPickerCategory('extension')}
                  onClick={() => setPickerCategory('extension')}
                >
                  <span className={styles.promptPickerLabel}>扩展</span>
                </button>
                <button
                  type="button"
                  className={styles.promptPickerItem}
                  onMouseEnter={() => setPickerCategory('mcp')}
                  onClick={() => setPickerCategory('mcp')}
                >
                  <span className={styles.promptPickerLabel}>连接器</span>
                </button>
              </div>
              <div className={styles.promptPickerCol}>
                {pickerCategory === 'skill' &&
                  skills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      className={styles.promptPickerItem}
                      onClick={() =>
                        insertTag({
                          id: `skill:${skill.name}`,
                          kind: 'skill',
                          label: skill.name,
                          serialized: `/${skill.name}`,
                        })
                      }
                    >
                      <span className={styles.promptPickerLabel}>
                        {skill.name}
                      </span>
                    </button>
                  ))}
                {pickerCategory === 'extension' &&
                  extensions.map((extension) => (
                    <button
                      key={extension.name}
                      type="button"
                      className={styles.promptPickerItem}
                      onClick={() =>
                        insertTag({
                          id: `extension:@ext:${extension.name}`,
                          kind: 'extension',
                          value: extension.name,
                          label: extension.displayName,
                          serialized: `@ext:${extension.name}`,
                        })
                      }
                    >
                      <span className={styles.promptPickerLabel}>
                        {extension.name}
                      </span>
                    </button>
                  ))}
                {pickerCategory === 'mcp' &&
                  mcpServers.map((server) => (
                    <button
                      key={server.name}
                      type="button"
                      className={styles.promptPickerItem}
                      onClick={() =>
                        insertTag({
                          id: `mcp:@mcp:${server.name}`,
                          kind: 'mcp',
                          value: server.name,
                          serialized: `@mcp:${server.name}`,
                        })
                      }
                    >
                      <span className={styles.promptPickerLabel}>
                        {server.name}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {core.atMenu && (
        <AtMentionPanel
          menu={core.atMenu}
          anchorRef={anchorRef}
          panelRef={atPanelRef}
          onSelect={core.selectAtCompletion}
          onAccept={handleAcceptMention}
          onBack={() => Boolean(core.backAtCategories())}
          onSearch={core.updateAtSearch}
          placement="below"
          portal={false}
        />
      )}
    </div>
  );
}
