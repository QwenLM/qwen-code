import type { ContextUsageControls } from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';

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
      role={
        result?.kind === 'failed' || result?.kind === 'refreshFailed'
          ? 'alert'
          : 'status'
      }
    >
      {t(
        controls?.compressing
          ? 'contextUsage.compressing'
          : result?.kind === 'completed'
            ? 'contextUsage.compressed'
            : result?.kind === 'cancelled'
              ? 'contextUsage.compressCancelled'
              : result?.kind === 'interrupted'
                ? 'contextUsage.compressInterrupted'
                : result?.kind === 'refreshFailed'
                  ? 'contextUsage.compressRefreshFailed'
                  : 'contextUsage.compressFailed',
      )}
    </div>
  );
}
