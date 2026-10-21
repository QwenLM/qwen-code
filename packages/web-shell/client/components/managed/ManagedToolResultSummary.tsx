import { useI18n } from '../../i18n';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { ManagedToolResult } from './managed-tool-result-types';

export function ManagedToolResultSummary({
  result,
  onOpen,
}: {
  result: ManagedToolResult;
  onOpen?: (itemId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
      data-managed-tool-result={result.id}
    >
      <Badge variant="outline">
        {t(`managed.result.execution.${result.execution_status}`)}
      </Badge>
      <Badge variant="outline">
        {t(`managed.result.capture.${result.capture_status ?? 'none'}`)}
      </Badge>
      <Badge variant="outline">
        {t(`managed.result.delivery.${result.delivery_status}`)}
      </Badge>
      {onOpen && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpen(result.item_id)}
        >
          {t('managed.result.view')}
        </Button>
      )}
    </div>
  );
}
