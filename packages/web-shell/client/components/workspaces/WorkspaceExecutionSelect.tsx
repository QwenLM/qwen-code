import { useId } from 'react';
import { useI18n } from '../../i18n';
import { Field, FieldDescription, FieldLabel } from '../ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

export type WorkspaceExecutionMode = 'daemon' | 'managed';

export function WorkspaceExecutionSelect({
  value,
  onValueChange,
  disabled,
}: {
  value: WorkspaceExecutionMode;
  onValueChange: (value: WorkspaceExecutionMode) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <Field>
      <FieldLabel id={id}>{t('managed.executionMode')}</FieldLabel>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if ((next === 'daemon' || next === 'managed') && next !== value)
            onValueChange(next);
        }}
      >
        <SelectTrigger className="w-full" aria-labelledby={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daemon">
            {t('workspace.executionDaemon')}
          </SelectItem>
          <SelectItem value="managed">
            {t('workspace.executionManaged')}
          </SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>{t('workspace.executionHint')}</FieldDescription>
    </Field>
  );
}
