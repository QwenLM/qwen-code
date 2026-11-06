import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MessageList } from '../MessageList';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  ToolDetailsContext,
  type ToolDetailsLoader,
} from '../messages/tools/ToolDetailsContext';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { createManagedMessageProjector } from './managed-session-messages';
import { useManagedSession } from './use-managed-session';
import { isManagedSessionRunning } from './managed-agent-provider';
import { ManagedDiagnosticsPanel } from './ManagedDiagnosticsPanel';
import { useManagedDiagnosticsText } from './managed-diagnostics-messages';

export function ManagedChildSessionView({
  provider,
  clientId,
  sessionId,
  onClose,
  restoreFocus,
}: {
  provider: ManagedAgentProvider;
  clientId: string;
  sessionId: string;
  onClose(): void;
  restoreFocus(): void;
}) {
  const { t } = useI18n();
  const diagnosticsText = useManagedDiagnosticsText();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => setDiagnosticsOpen(false), [provider, clientId, sessionId]);
  const diagnosticsTrigger = useRef<HTMLButtonElement>(null);
  const detail = useManagedSession(provider, clientId, sessionId);
  useEffect(() => {
    if (detail.signals?.session) setDiagnosticsOpen(false);
  }, [detail.signals?.session]);
  const projector = useMemo(() => createManagedMessageProjector(), []);
  const messages = useMemo(
    () => projector(detail.events, t('managed.truncated')),
    [projector, detail.events, t],
  );
  const loadDetails = useMemo<ToolDetailsLoader | undefined>(() => {
    const reader = provider.toolDetails;
    if (!reader) return undefined;
    return async (callId, signal) => {
      const itemId = callId.slice(callId.lastIndexOf(':') + 1);
      const value = await reader.get(sessionId, itemId, { clientId, signal });
      return {
        args: value.input ?? undefined,
        rawOutput:
          value.shellResult ??
          (value.output == null
            ? undefined
            : value.output +
              (value.truncated ? `\n${t('managed.truncated')}` : '')),
      };
    };
  }, [provider, clientId, sessionId, t]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col sm:max-w-5xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('managed.tasks.childSession')}</DialogTitle>
          <DialogDescription>
            {detail.summary?.title ?? sessionId}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('managed.tasks.backToParent')}
          </Button>
          {detail.summary?.approvalMode && (
            <Badge variant="secondary">
              {t('managed.tasks.approvalMode')}: {detail.summary.approvalMode}
            </Badge>
          )}
          {provider.diagnostics &&
            !detail.signals?.session &&
            detail.summary?.capabilities.diagnostics && (
              <Button
                ref={diagnosticsTrigger}
                variant="outline"
                size="sm"
                onClick={() => setDiagnosticsOpen(true)}
              >
                {diagnosticsText('title')}
              </Button>
            )}
        </div>
        {(detail.error || detail.stoppedReason) && (
          <p role="alert">{detail.error ?? detail.stoppedReason}</p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ToolDetailsContext.Provider value={loadDetails}>
            <MessageList
              messages={messages}
              pendingApproval={null}
              sessionKey={`managed-child:${sessionId}`}
              loadingTranscript={detail.loading}
              isResponding={detail.summary?.phase === 'agent_running'}
              hasOlderHistory={Boolean(detail.olderCursor)}
              loadingOlderHistory={detail.loadingOlder}
              onLoadOlderHistory={detail.loadOlder}
              hideSessionTimeline
            />
          </ToolDetailsContext.Provider>
        </div>
        {diagnosticsOpen &&
          provider.diagnostics &&
          !detail.signals?.session &&
          detail.summary?.capabilities.diagnostics && (
            <ManagedDiagnosticsPanel
              provider={provider.diagnostics}
              clientId={clientId}
              sessionId={sessionId}
              running={isManagedSessionRunning(detail.summary.phase)}
              revision={`${detail.summary.compactionRevision}:${detail.summary.modelSelection?.revision}:${detail.summary.phase}`}
              onClose={() => setDiagnosticsOpen(false)}
              restoreFocus={() => diagnosticsTrigger.current?.focus()}
            />
          )}
      </DialogContent>
    </Dialog>
  );
}
