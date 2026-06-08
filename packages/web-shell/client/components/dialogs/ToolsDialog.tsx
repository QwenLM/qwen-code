import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useTools,
  type DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

interface ToolsDialogProps {
  onClose: () => void;
}

function toolLabel(tool: DaemonWorkspaceToolStatus): string {
  return tool.displayName || tool.name;
}

export function ToolsDialog({ onClose }: ToolsDialogProps) {
  const { t } = useI18n();
  const { status, tools, loading, error, reload, setEnabled } = useTools({
    autoLoad: true,
  });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const listRef = useRef<HTMLDivElement>(null);

  const selected = tools[selectedIdx];
  const selectedExpanded = selected ? expandedTools.has(selected.name) : false;

  useEffect(() => {
    if (error) setMessage(error.message);
    else if (status?.errors?.[0]?.error) setMessage(status.errors[0].error);
    else if (status) setMessage(null);
  }, [status, error]);

  const handleToggle = useCallback(
    (tool: DaemonWorkspaceToolStatus) => {
      setMessage(null);
      setBusyTool(tool.name);
      setEnabled(tool.name, !tool.enabled)
        .then(() => reload())
        .catch((err: unknown) => {
          setMessage(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusyTool(null));
    },
    [reload, setEnabled],
  );

  const toggleDetails = useCallback((tool: DaemonWorkspaceToolStatus) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(tool.name)) {
        next.delete(tool.name);
      } else {
        next.add(tool.name);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedIdx >= tools.length && tools.length > 0) {
      setSelectedIdx(tools.length - 1);
    }
  }, [selectedIdx, tools.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(tools.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        reload();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && selected?.description) {
        e.preventDefault();
        toggleDetails(selected);
        return;
      }
      if (e.key === 't' && selected) {
        e.preventDefault();
        handleToggle(selected);
      }
    },
    [handleToggle, onClose, reload, selected, toggleDetails, tools.length],
  );

  const summary = useMemo(() => {
    if (!status) return '';
    const enabled = tools.filter((tool) => tool.enabled).length;
    return t('tools.summary', { enabled, total: tools.length });
  }, [status, tools, t]);

  // resume-picker-keyboard-only: disable mouse hover highlight to prevent
  // hover from fighting keyboard selection for focus
  return (
    <div className={dp('resume-picker', 'resume-picker-keyboard-only')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('tools.title')}</span>
        <span className={dp('resume-picker-count')}>{summary}</span>
        <button
          className={dp('resume-picker-close')}
          onClick={onClose}
          title={t('common.close')}
        >
          ESC
        </button>
      </div>

      {message && (
        <div className={dp('resume-picker-search')}>
          <span className={dp('resume-picker-search-hint')}>{message}</span>
        </div>
      )}

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {!loading && tools.length === 0 && (
          <div className={dp('resume-picker-empty')}>{t('tools.empty')}</div>
        )}
        {tools.map((tool, i) => {
          const expanded = expandedTools.has(tool.name);
          const desc = tool.description ?? '';
          const internalName =
            tool.displayName && tool.displayName !== tool.name ? tool.name : '';
          const metaText = expanded
            ? ''
            : internalName ||
              (desc.length > 80 ? `${desc.slice(0, 80)}...` : desc);

          return (
            <div
              key={tool.name}
              className={dp(
                'resume-picker-item',
                'resume-picker-session-item',
                i === selectedIdx ? 'selected' : undefined,
              )}
              onClick={() => {
                setSelectedIdx(i);
                if (tool.description) toggleDetails(tool);
              }}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('resume-picker-item-prefix')}>
                  {i === selectedIdx ? '›' : ' '}
                </span>
                <span className={dp('resume-picker-item-title')}>
                  {toolLabel(tool)}
                </span>
              </div>
              <div className={dp('resume-picker-item-meta')}>
                <span>
                  {busyTool === tool.name
                    ? '...'
                    : tool.enabled
                      ? t('tools.status.enabled')
                      : t('tools.status.disabled')}
                </span>
                {!expanded && metaText && (
                  <span className={dp('resume-picker-item-detail')}>
                    {metaText}
                  </span>
                )}
              </div>
              {expanded && desc && (
                <div className={dp('tools-desc-expanded')}>
                  <div className={dp('tools-desc-body')}>{desc}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {selected
          ? t('tools.footer', {
              name: toolLabel(selected),
              details: selected?.description
                ? selectedExpanded
                  ? t('tools.details.hide')
                  : t('tools.details.show')
                : '',
            })
          : t('tools.footer')}
      </div>
    </div>
  );
}
