import type { DaemonClient } from '@qwen-code/sdk/daemon';
import {
  ArrowLeftIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  Settings2Icon,
} from 'lucide-react';
import { useI18n } from '../i18n';
import type { useCodeReviewSettings } from '../hooks/useCodeReviewSettings';
import { CodeReviewPage } from './code-review/CodeReviewPage';
import styles from './code-review/CodeReviewPage.module.css';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Switch } from './ui/switch';

export function CodeReviewWorkbench({
  client,
  settings,
  initialPrRef,
  onSelectPullRequest,
  onClose,
}: {
  client: DaemonClient;
  settings: ReturnType<typeof useCodeReviewSettings>;
  initialPrRef?: string;
  onSelectPullRequest: (ref: string | undefined) => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const settingsControl = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('prWorkbench.settings')}
          title={t('prWorkbench.settings')}
        >
          <Settings2Icon size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className={styles.settingsPopover}>
        <div className={styles.settingRow}>
          <span>{t('prWorkbench.enable')}</span>
          <Switch
            aria-label={t('prWorkbench.enable')}
            checked={settings.enabled}
            disabled={!settings.loaded || settings.busy || settings.locked}
            onCheckedChange={(enabled) => {
              void settings.setEnabled(enabled);
            }}
          />
        </div>
        <p>
          {t(
            settings.locked
              ? 'prWorkbench.settingLocked'
              : 'prWorkbench.accountScope',
          )}
        </p>
        {settings.error && (
          <p role="alert" className={styles.moreError}>
            {settings.error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
  if (settings.enabled) {
    return (
      <CodeReviewPage
        client={client}
        settingsControl={settingsControl}
        initialPrRef={initialPrRef}
        onSelectPullRequest={onSelectPullRequest}
        onClose={onClose}
      />
    );
  }
  return (
    <section className={styles.root} data-testid="code-review-gate">
      <aside className={styles.inbox}>
        <header className={styles.inboxHeader}>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('prWorkbench.back')}
            >
              <ArrowLeftIcon size={17} />
            </Button>
          )}
          <h1>{t('prWorkbench.title')}</h1>
          {settingsControl}
        </header>
        <p className={styles.gateHint}>{t('prWorkbench.accountScope')}</p>
      </aside>
      <div className={styles.empty}>
        {settings.loaded ? (
          <GitPullRequestIcon size={32} strokeWidth={1.5} />
        ) : (
          <LoaderCircleIcon size={28} className={styles.spinning} />
        )}
        <h2>
          {t(
            settings.loaded
              ? 'prWorkbench.disabledTitle'
              : 'prWorkbench.loading',
          )}
        </h2>
        {settings.loaded && (
          <p>
            {t(
              settings.locked
                ? 'prWorkbench.settingLocked'
                : 'prWorkbench.disabledBody',
            )}
          </p>
        )}
        {settings.error && (
          <p role="alert" className={styles.moreError}>
            {settings.error}
          </p>
        )}
        {settings.loaded && (!settings.locked || settings.error) && (
          <Button
            disabled={settings.busy}
            onClick={() => {
              void (settings.error
                ? settings.reload()
                : settings.setEnabled(true));
            }}
          >
            {settings.busy && (
              <LoaderCircleIcon size={15} className={styles.spinning} />
            )}
            {t(settings.error ? 'prWorkbench.retry' : 'prWorkbench.enable')}
          </Button>
        )}
      </div>
    </section>
  );
}
