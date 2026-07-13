import { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';

interface AddWorkspaceDialogProps {
  onClose: () => void;
  onAdd: (cwd: string, persist: boolean) => Promise<void>;
}

const HINT_ID = 'add-workspace-hint';
const ERROR_ID = 'add-workspace-error';

export function AddWorkspaceDialog({
  onClose,
  onAdd,
}: AddWorkspaceDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [persist, setPersist] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = path.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\//]/.test(trimmed)) {
        setError(t('sidebar.addWorkspaceAbsError'));
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        await onAdd(trimmed, persist);
        onClose();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('sidebar.addWorkspaceError'),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [path, persist, onAdd, onClose, t],
  );

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      size="md"
      onClose={onClose}
    >
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="add-workspace-path">
              {t('sidebar.addWorkspacePath')}
            </FieldLabel>
            <Input
              ref={inputRef}
              id="add-workspace-path"
              type="text"
              placeholder="/absolute/path/to/project"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                if (error) setError(null);
              }}
              disabled={submitting}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error ? `${ERROR_ID} ${HINT_ID}` : HINT_ID}
              aria-invalid={error ? true : undefined}
            />
            <FieldDescription id={HINT_ID}>
              {t('sidebar.addWorkspaceHint')}
            </FieldDescription>
            {error && <FieldError id={ERROR_ID}>{error}</FieldError>}
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="add-workspace-persist">
                {t('sidebar.addWorkspacePersist')}
              </FieldLabel>
              <FieldDescription>
                {t('sidebar.addWorkspacePersistHint')}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="add-workspace-persist"
              checked={persist}
              onCheckedChange={setPersist}
              disabled={submitting}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
          >
            {t('sidebar.addWorkspaceCancel')}
          </Button>
          <Button type="submit" disabled={submitting || !path.trim()}>
            {submitting
              ? t('sidebar.addWorkspaceAdding')
              : t('sidebar.addWorkspaceRegister')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
