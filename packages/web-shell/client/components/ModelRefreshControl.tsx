import { RefreshCwIcon } from 'lucide-react';
import type { useModelRefresh } from '../hooks/useModelRefresh';
import { useI18n } from '../i18n';
import { Button } from './ui/button';

export type ModelRefreshState = ReturnType<typeof useModelRefresh>;

export function ModelRefreshControl({ state }: { state?: ModelRefreshState }) {
  const { t } = useI18n();
  if (!state?.refresh) return null;
  const label = t(state.refreshing ? 'model.refreshing' : 'model.refresh');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={state.refreshing}
      aria-label={label}
      title={label}
      onClick={() => void state.refresh?.()}
    >
      <RefreshCwIcon
        aria-hidden="true"
        className={
          state.refreshing
            ? 'animate-spin motion-reduce:animate-none'
            : undefined
        }
      />
    </Button>
  );
}

export function ModelRefreshError({ state }: { state?: ModelRefreshState }) {
  const { t } = useI18n();
  if (!state?.refresh || !state.error) return null;
  return (
    <div role="alert" className="text-xs text-destructive">
      {t('model.refreshFailed', { error: state.error })}
    </div>
  );
}
