import { isShellResultDisplay } from '@qwen-code/sdk/daemon';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  CopyIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import type { ACPToolCall } from '../../../adapters/types';
import { useSharedNow } from '../../../hooks/useSharedNow';
import { parseShellLiveOutput } from './shellLiveOutput';
import { formatElapsed } from './toolDisplay';
import { useCopiedFlash } from '../../../hooks/useCopiedFlash';
import { useI18n } from '../../../i18n';
import { useTranscriptRenderMode } from '../../../transcriptRenderMode';
import { hasAnsi, parseAnsi } from '../../../utils/ansi';
import { writeClipboardText } from '../../../utils/clipboard';
import { Button } from '../../ui/button';
import {
  extractText,
  getToolDescription,
  isActiveToolStatus,
  localizeToolDisplayName,
} from '../toolFormatting';
import styles from './ToolChrome.module.css';

export function ShellToolOutput({ tool }: { tool: ACPToolCall }) {
  const { t } = useI18n();
  const documentMode = useTranscriptRenderMode() === 'document';
  const [copied, flashCopied] = useCopiedFlash();
  const [outputCopied, flashOutputCopied] = useCopiedFlash();
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = (value: string, flash: () => void) => {
    setCopyFailed(false);
    void writeClipboardText(value)
      .then(flash)
      .catch(() => setCopyFailed(true));
  };
  const raw = tool.rawOutput;
  const text =
    raw &&
    typeof raw === 'object' &&
    'type' in raw &&
    raw.type === 'shell_result' &&
    !isShellResultDisplay(raw)
      ? 'text' in raw && typeof raw.text === 'string'
        ? raw.text
        : JSON.stringify(raw, null, 2)
      : extractText(tool) || '';
  const active = isActiveToolStatus(tool.status);
  const result =
    !active && isShellResultDisplay(tool.rawOutput) ? tool.rawOutput : null;
  const now = useSharedNow(active && !documentMode);
  const live = useMemo(
    () => (active && !text ? parseShellLiveOutput(tool.rawOutput) : null),
    [active, text, tool.rawOutput],
  );
  const segments = useMemo(() => {
    if (live) return live.segments;
    const output =
      result?.output ??
      (text ||
        (active && tool.rawOutput !== null && typeof tool.rawOutput === 'object'
          ? JSON.stringify(tool.rawOutput, null, 2)
          : ''));
    return hasAnsi(output)
      ? parseAnsi(output).map((seg) => ({
          text: seg.text,
          style: {
            color: seg.color,
            fontWeight: seg.bold ? 'bold' : undefined,
            opacity: seg.dim ? 0.6 : undefined,
          },
        }))
      : [{ text: output }];
  }, [live, result, text, active, tool.rawOutput]);
  const output = segments?.map((seg) => seg.text).join('') ?? '';
  const outputRef = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (active && !documentMode && following.current && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, documentMode, active]);
  const elapsed = active ? formatElapsed(tool.startTime, now) : '';
  const command =
    typeof tool.args?.command === 'string' ? tool.args.command : '';
  const showTimeout =
    !!command &&
    !tool.args?.is_background &&
    !tool.args?.run_in_background &&
    tool.executionMode !== 'background';
  const timeout =
    typeof tool.args?.timeout === 'number' && Number.isFinite(tool.args.timeout)
      ? tool.args.timeout
      : live?.timeoutMs;
  const failed =
    tool.status === 'failed' ||
    result?.outcome === 'failed' ||
    result?.outcome === 'timed_out' ||
    !!result?.error ||
    !!result?.signal;
  const cancelled = tool.wasCancelled || result?.outcome === 'cancelled';
  const StatusIcon =
    active && !cancelled
      ? LoaderCircleIcon
      : !cancelled
        ? failed
          ? CircleXIcon
          : result?.exitCode === 0
            ? CircleCheckIcon
            : null
        : null;
  const status = cancelled
    ? t('shell.result.cancelled')
    : result?.outcome === 'timed_out'
      ? t('shell.result.timedOut')
      : isActiveToolStatus(tool.status)
        ? t(
            tool.status === 'pending'
              ? 'shell.result.pending'
              : 'shell.result.running',
          )
        : failed && result?.exitCode != null && result.exitCode !== 0
          ? t('shell.result.exited', { code: result.exitCode })
          : failed
            ? t('tool.status.failed')
            : t(
                result?.exitCode === 0
                  ? 'shell.result.success'
                  : 'shell.result.completed',
              );

  if (documentMode && !result) {
    return (
      <div className={styles.expandedCard}>
        <div className={styles.expandedCardHeader}>
          <span className={styles.expandedCardTitle}>
            {localizeToolDisplayName(tool.toolName, t)}
          </span>
        </div>
        <div className={styles.expandedCardBody}>
          {command && <pre className={styles.expandedOutput}>{command}</pre>}
          <pre className={styles.expandedOutput}>{output}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.expandedCard} data-shell-command-card>
      <div className={styles.expandedCardHeader}>
        <div className={styles.shellHeading}>
          <span className={styles.expandedCardTitle}>
            {localizeToolDisplayName(tool.toolName, t)}
          </span>
          <span
            className={`${styles.shellStatus} ${failed ? styles.shellFailure : ''}`}
          >
            {StatusIcon && (
              <StatusIcon
                className={
                  active ? 'animate-spin motion-reduce:animate-none' : undefined
                }
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            )}
            {status}
            {elapsed && <span>{elapsed}</span>}
          </span>
        </div>
      </div>
      <div className={`${styles.expandedCardBody} ${styles.shellBody}`}>
        {!command && getToolDescription(tool) && (
          <div className={styles.expandedCardDetail}>
            {getToolDescription(tool)}
          </div>
        )}
        {command && (
          <div className={styles.shellSection}>
            <details open>
              <summary>{t('shell.result.command')}</summary>
              <pre className={`${styles.expandedOutput} ${styles.shellOutput}`}>
                {command}
              </pre>
            </details>
            {!documentMode && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('shell.result.copy')}
                title={t('shell.result.copy')}
                onClick={() => copy(command, flashCopied)}
              >
                {copied ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <CopyIcon aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        )}
        {copyFailed && (
          <div role="status" className={styles.shellFailure}>
            {t('copy.failedFallback')}
          </div>
        )}
        <div className={styles.shellSection}>
          <details className={styles.shellDetails} open>
            <summary>{t('shell.result.output')}</summary>
            <pre
              ref={outputRef}
              onScroll={(event) => {
                const el = event.currentTarget;
                following.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              className={`${styles.expandedOutput} ${styles.shellOutput}`}
            >
              {output
                ? segments?.map((seg, i) => (
                    <span key={i} style={seg.style}>
                      {seg.text}
                    </span>
                  ))
                : t(active ? 'shell.result.waiting' : 'shell.result.empty')}
            </pre>
          </details>
          {!documentMode && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title={t('quickActions.copy')}
              aria-label={t('quickActions.copy')}
              disabled={!output}
              onClick={() =>
                copy(
                  segments ? segments.map((seg) => seg.text).join('') : output,
                  flashOutputCopied,
                )
              }
            >
              {outputCopied ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
            </Button>
          )}
        </div>
        {result && result.notices.length > 0 && (
          <details className={styles.shellDetails} open>
            <summary>{t('shell.result.notices')}</summary>
            <pre className={`${styles.expandedOutput} ${styles.shellOutput}`}>
              {result.notices.join('\n\n')}
            </pre>
          </details>
        )}
        {result?.truncated && (
          <div className={styles.expandedCardDetail}>
            {t('shell.result.truncated')}
          </div>
        )}
        {result?.error && (
          <pre className={styles.shellFailure}>{result.error}</pre>
        )}
        {!!result?.signal && (
          <div className={styles.shellFailure}>
            {t('shell.result.signal')}: {result.signal}
          </div>
        )}
        {(result || showTimeout || live || elapsed) && (
          <details className={styles.shellDetails} open={documentMode}>
            <summary>{t('shell.result.details')}</summary>
            <dl>
              {live?.totalLines !== undefined && (
                <>
                  <dt>{t('shell.result.lines')}</dt>
                  <dd>{live.totalLines}</dd>
                </>
              )}
              {live?.totalBytes !== undefined && (
                <>
                  <dt>{t('shell.result.bytes')}</dt>
                  <dd>{live.totalBytes}</dd>
                </>
              )}

              {showTimeout && (
                <>
                  <dt>{t('shell.result.timeout')}</dt>
                  <dd>
                    {timeout !== undefined
                      ? t('shell.result.timeoutMs', { milliseconds: timeout })
                      : t('shell.result.defaultTimeout')}
                  </dd>
                </>
              )}
              {result && (
                <>
                  <dt>{t('shell.result.directory')}</dt>
                  <dd>{result.directory}</dd>
                </>
              )}
              {result?.exitCode != null &&
                !cancelled &&
                result.outcome !== 'timed_out' &&
                !result.signal && (
                  <>
                    <dt>{t('shell.result.exitCode')}</dt>
                    <dd>{result.exitCode}</dd>
                  </>
                )}
              {result && result.outputFiles.length > 0 && (
                <>
                  <dt>{t('shell.result.outputFiles')}</dt>
                  <dd>{result.outputFiles.join('\n')}</dd>
                </>
              )}
              {result?.pid && (
                <>
                  <dt>PGID</dt>
                  <dd>{result.pid}</dd>
                </>
              )}
            </dl>
          </details>
        )}
      </div>
    </div>
  );
}
