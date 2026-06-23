import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import {
  useTools,
  type DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';

function toolLabel(tool: DaemonWorkspaceToolStatus): string {
  return tool.displayName || tool.name;
}

export function ToolsDialog() {
  const { t } = useI18n();
  const { status, tools, loading, error } = useTools({
    autoLoad: true,
  });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) setMessage(error.message);
    else if (status?.errors?.[0]?.error) setMessage(status.errors[0].error);
    else if (status) setMessage(null);
  }, [status, error]);

  const toggleDetails = useCallback((tool: DaemonWorkspaceToolStatus) => {
    setExpandedTools((current) => {
      return current.has(tool.name) ? new Set() : new Set([tool.name]);
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

  const summary = useMemo(() => {
    if (!status) return '';
    const enabled = tools.filter((tool) => tool.enabled).length;
    return t('tools.summary', { enabled, total: tools.length });
  }, [status, tools, t]);

  return (
    <div className={dp('resume-picker', 'resume-picker-in-shell')}>
      {summary && (
        <div className={dp('resume-picker-search')}>
          <span className={dp('resume-picker-search-hint')}>{summary}</span>
        </div>
      )}
      {(message || loading) && (
        <div className={dp('resume-picker-search')}>
          <span className={dp('resume-picker-search-hint')}>
            {message || t('tools.loading')}
          </span>
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
          return (
            <div
              key={tool.name}
              className={dp(
                'resume-picker-item',
                'resume-picker-session-item',
                'tools-picker-item',
                expanded ? 'selected' : undefined,
                expanded ? 'tools-picker-item-expanded' : undefined,
              )}
              onClick={() => {
                setSelectedIdx(i);
                if (tool.description) toggleDetails(tool);
              }}
            >
              <div className={dp('resume-picker-item-row')}>
                <span className={dp('tools-item-icon')} aria-hidden="true" />
                <span className={dp('resume-picker-item-title')}>
                  {toolLabel(tool)}
                </span>
                <span
                  className={dp(
                    'tools-status-badge',
                    tool.enabled
                      ? 'tools-status-badge-enabled'
                      : 'tools-status-badge-disabled',
                  )}
                >
                  {tool.enabled
                    ? t('tools.status.enabled')
                    : t('tools.status.disabled')}
                </span>
                {desc ? (
                  <svg
                    className={dp(
                      'tools-item-chevron',
                      expanded ? 'tools-item-chevron-expanded' : undefined,
                    )}
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 4.5 9.5 8 6 11.5"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
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
    </div>
  );
}
