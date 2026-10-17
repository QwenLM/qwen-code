import type { ContextUsageControls } from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';
import { compressionMessageKey } from './ContextCompressionAnnouncer';

export function ContextCompressionFeedback({
  controls,
  className,
}: {
  controls?: Pick<ContextUsageControls, 'compressing' | 'result'>;
  className?: string;
}) {
  const { t } = useI18n();
  const result = controls?.result;
  if (!controls?.compressing && !result) return null;
  return (
    <div
      className={className}
      data-tone={
        result?.kind === 'failed' || result?.kind === 'refreshFailed'
          ? 'error'
          : 'status'
      }
      data-web-shell-compression-feedback
    >
      {t(
        compressionMessageKey(controls?.compressing ? 'pending' : result!.kind),
      )}
    </div>
  );
}
