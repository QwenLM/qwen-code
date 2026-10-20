import type { useModelRefresh } from '../hooks/useModelRefresh';
import { useI18n } from '../i18n';
import { Button } from './ui/button';

export type ModelRefreshState = ReturnType<typeof useModelRefresh>;

export function ModelRefreshControl({ state }: { state?: ModelRefreshState }) {
  const { t } = useI18n();
  if (!state?.refresh) return null;
  return (
    <div className="flex flex-col gap-1 p-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={state.refreshing}
        onClick={() => void state.refresh?.()}
      >
        {t(state.refreshing ? 'model.refreshing' : 'model.refresh')}
      </Button>
      {state.error ? (
        <div role="alert" className="text-xs text-destructive">
          {t('model.refreshFailed', { error: state.error })}
        </div>
      ) : null}
    </div>
  );
}
