import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ContextCompressionControls,
  ContextUsageControls,
} from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';
import { useWebShellPortalRoot } from '../portalRoot';

export type CompressionPhase =
  | 'pending'
  | NonNullable<ContextCompressionControls['result']>['kind'];

export interface CompressionAnnouncement {
  operation: object;
  sessionId: string;
  workspaceCwd?: string;
  phase: CompressionPhase;
}

export const ContextCompressionAnnouncementContext = createContext<
  ((announcement: CompressionAnnouncement) => void) | undefined
>(undefined);

export function compressionMessageKey(phase: CompressionPhase) {
  return {
    pending: 'contextUsage.compressing',
    completed: 'contextUsage.compressed',
    compressed: 'contextUsage.compressedUnknown',
    noop: 'contextCompression.noop',
    cancelled: 'contextUsage.compressCancelled',
    interrupted: 'contextUsage.compressInterrupted',
    refreshFailed: 'contextUsage.compressRefreshFailed',
    failed: 'contextUsage.compressFailed',
  }[phase];
}

export function compressionPhaseTone(
  phase: CompressionPhase,
): 'error' | 'info' {
  return phase === 'failed' || phase === 'refreshFailed' ? 'error' : 'info';
}

function scopeKey(scope: { sessionId: string; workspaceCwd?: string }) {
  return JSON.stringify([scope.workspaceCwd, scope.sessionId]);
}

export function useContextCompressionAnnouncements() {
  const [announcements, setAnnouncements] = useState<
    Record<string, CompressionAnnouncement>
  >({});
  // Keep this callback stable: context consumers include it in their
  // compression handler dependencies, so recreating it would re-register the
  // handler while an operation is in flight.
  const announce = useCallback((next: CompressionAnnouncement) => {
    setAnnouncements((current) => {
      const key = scopeKey(next);
      const previous = current[key];
      return previous?.operation === next.operation &&
        previous.phase === next.phase
        ? current
        : { ...current, [key]: next };
    });
  }, []);
  return { announcements, announce };
}

function SessionAnnouncement({
  announcement,
  spoken,
}: {
  announcement?: CompressionAnnouncement;
  spoken: WeakSet<CompressionAnnouncement>;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<CompressionPhase>();
  useEffect(() => {
    if (!announcement || spoken.has(announcement)) return;
    setPhase(undefined);
    let retentionTimer: number | undefined;
    // Keep the live nodes mounted before changing their text, including when
    // consecutive operations finish with the same message.
    const timer = window.setTimeout(() => {
      spoken.add(announcement);
      setPhase(announcement.phase);
      retentionTimer = window.setTimeout(() => setPhase(undefined), 10_000);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(retentionTimer);
    };
  }, [announcement, spoken]);
  const text = phase ? t(compressionMessageKey(phase)) : '';
  const error = phase && compressionPhaseTone(phase) === 'error';
  return (
    <div className="sr-only" data-web-shell-compression-announcer>
      <div role="status" aria-live="polite" aria-atomic="true">
        {!error ? text : ''}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {error ? text : ''}
      </div>
    </div>
  );
}

export function ContextCompressionAnnouncer({
  owners,
  announcements,
}: {
  owners: Array<ContextUsageControls | undefined>;
  announcements: Record<string, CompressionAnnouncement>;
}) {
  const portalRoot = useWebShellPortalRoot();
  const spoken = useRef(new WeakSet<CompressionAnnouncement>());
  const keys = new Set(
    owners.flatMap((owner) => (owner ? [scopeKey(owner)] : [])),
  );
  useEffect(() => {
    for (const [key, announcement] of Object.entries(announcements)) {
      if (!keys.has(key)) spoken.current.add(announcement);
    }
  });
  return portalRoot
    ? createPortal(
        [...keys].map((key) => (
          <SessionAnnouncement
            key={key}
            announcement={announcements[key]}
            spoken={spoken.current}
          />
        )),
        portalRoot,
      )
    : null;
}
