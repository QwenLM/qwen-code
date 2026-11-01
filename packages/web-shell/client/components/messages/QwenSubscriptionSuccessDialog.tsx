import { CheckIcon, CrownIcon, UserRoundIcon, XIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../themeContext';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog';
import themeStyles from '../dialogs/DialogShell.module.css';

export function QwenSubscriptionSuccessDialog({
  email,
  plan,
  model,
  onClose,
}: {
  email: string;
  plan: string;
  model: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-web-shell-dialog
        data-keyboard-scope
        data-subscription-success
        className={`${theme === 'light' ? themeStyles.themeLight : `${themeStyles.themeDark} dark`} max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto p-8 font-sans sm:max-w-[480px]`}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <XIcon />
        </Button>
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className="relative mb-2 size-16 text-[var(--agent-blue-500)]"
            aria-hidden="true"
          >
            <svg
              viewBox="17.5 27.7 135.6 135.6"
              className="size-full"
              fill="currentColor"
            >
              <path d="M130.06,43.66h-33.37c0-1.42-.37-2.84-1.1-4.11l-4.47-7.74c-1.47-2.54-4.18-4.11-7.12-4.11h-8.93c-2.94,0-5.65,1.57-7.12,4.11l-13.68,23.69c-1.47,2.54-1.47,5.67,0,8.22l4.47,7.74c1.47,2.54,4.18,4.11,7.12,4.11h64.19c2.94,0,5.65-1.57,7.12-4.11l4.47-7.74c1.47-2.54,1.47-5.67,0-8.22l-4.47-7.74c-1.47-2.54-4.18-4.11-7.12-4.11Z" />
              <path d="M19.75,83.66l16.68,28.9c-1.23.71-2.27,1.74-3.01,3.01l-4.47,7.74c-1.47,2.54-1.47,5.67,0,8.22l4.47,7.74c1.47,2.54,4.18,4.11,7.12,4.11h27.35c2.94,0,5.65-1.57,7.12-4.11l4.47-7.74c1.47-2.54,1.47-5.67,0-8.22l-32.1-55.59c-1.47-2.54-4.18-4.11-7.12-4.11h-8.93c-2.94,0-5.65,1.57-7.12,4.11l-4.47,7.74c-1.47,2.54-1.47,5.67,0,8.22Z" />
              <path d="M109.55,159.19l16.68-28.9c1.23.71,2.64,1.1,4.11,1.1h8.93c2.94,0,5.65-1.57,7.12-4.11l4.47-7.74c1.47-2.54,1.47-5.67,0-8.22l-13.68-23.69c-1.47-2.54-4.18-4.11-7.12-4.11h-8.93c-2.94,0-5.65,1.57-7.12,4.11l-32.1,55.59c-1.47,2.54-1.47,5.67,0,8.22l4.47,7.74c1.47,2.54,4.18,4.11,7.12,4.11h8.93c2.94,0,5.65-1.57,7.12-4.11Z" />
            </svg>
            <span className="absolute -right-2 -bottom-1 flex size-7 items-center justify-center rounded-full bg-[var(--success-color)] text-background ring-4 ring-popover">
              <CheckIcon className="size-4" strokeWidth={3} />
            </span>
          </div>
          <DialogTitle className="text-2xl font-semibold">
            {t('subscription.successTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('subscription.successDescription')}
          </DialogDescription>
        </div>
        <dl className="grid gap-4 border-b pb-6 text-sm">
          <div className="flex items-start gap-3">
            <dt className="flex shrink-0 items-center gap-3 text-muted-foreground">
              <UserRoundIcon className="size-4" aria-hidden="true" />
              {t('subscription.accountLabel')}
            </dt>
            <dd className="m-0 min-w-0 flex-1 text-right font-medium [overflow-wrap:anywhere]">
              {email}
            </dd>
          </div>
          <div className="flex items-start gap-3">
            <dt className="flex shrink-0 items-center gap-3 text-muted-foreground">
              <CrownIcon className="size-4" aria-hidden="true" />
              {t('subscription.planLabel')}
            </dt>
            <dd className="m-0 flex-1 text-right font-medium">Qwen {plan}</dd>
          </div>
          {model && (
            <div className="flex items-start gap-3 text-muted-foreground">
              <dt>{t('subscription.modelLabel')}</dt>
              <dd className="m-0 min-w-0 flex-1 text-right [overflow-wrap:anywhere]">
                {model}
              </dd>
            </div>
          )}
        </dl>
        <Button
          className="h-11 w-full bg-[var(--agent-blue-500)] text-white hover:bg-[var(--agent-blue-400)]"
          onClick={onClose}
        >
          {t('subscription.startUsing')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
