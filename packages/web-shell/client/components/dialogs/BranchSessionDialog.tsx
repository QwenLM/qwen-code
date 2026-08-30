import { useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';

export type BranchSessionIsolation = 'current' | 'worktree';

export function BranchSessionDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (isolation: BranchSessionIsolation) => void;
}) {
  const { t } = useI18n();
  const [isolation, setIsolation] = useState<BranchSessionIsolation>('current');

  return (
    <div className="flex flex-col gap-5">
      <RadioGroup
        value={isolation}
        onValueChange={(value) => setIsolation(value as BranchSessionIsolation)}
        aria-label={t('branch.dialog.title')}
        className="flex flex-col gap-2.5"
      >
        {(['current', 'worktree'] as const).map((value) => (
          <div
            key={value}
            className="flex items-start gap-2.5 rounded-lg border border-border p-3 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted"
          >
            <RadioGroupItem
              id={`branch-session-isolation-${value}`}
              value={value}
              disabled={busy}
              className="mt-0.5"
            />
            <label
              htmlFor={`branch-session-isolation-${value}`}
              className="flex flex-1 cursor-pointer flex-col gap-1"
            >
              <span className="text-sm font-semibold text-foreground">
                {t(
                  value === 'current'
                    ? 'branch.dialog.current.title'
                    : 'branch.dialog.worktree.title',
                )}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  value === 'current'
                    ? 'branch.dialog.current.description'
                    : 'branch.dialog.worktree.description',
                )}
              </span>
            </label>
          </div>
        ))}
      </RadioGroup>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {t('branch.dialog.cancel')}
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => onConfirm(isolation)}
        >
          {t(busy ? 'branch.dialog.creating' : 'branch.dialog.confirm')}
        </Button>
      </div>
    </div>
  );
}
