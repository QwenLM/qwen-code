import { useContext } from 'react';
import type { ContextCompressionControls } from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';
import {
  ContextCompressionAnnouncementContext,
  compressionMessageKey,
  compressionPhaseTone,
} from './ContextCompressionAnnouncer';

export function ContextCompressionFeedback({
  controls,
  className,
}: {
  controls?: Pick<ContextCompressionControls, 'compressing' | 'result'>;
  className?: string;
}) {
  const { t } = useI18n();
  const announce = useContext(ContextCompressionAnnouncementContext);
  const phase = controls?.compressing ? 'pending' : controls?.result?.kind;
  if (!phase) return null;
  const tone = compressionPhaseTone(phase);
  return (
    <div
      className={className}
      role={announce ? undefined : tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      data-web-shell-compression-feedback
    >
      {t(compressionMessageKey(phase))}
    </div>
  );
}
