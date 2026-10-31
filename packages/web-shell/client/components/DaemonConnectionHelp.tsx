import { getTranslator, type WebShellLanguage } from '../i18n';

export function DaemonConnectionHelp({
  language,
  expanded = false,
}: {
  language: WebShellLanguage;
  expanded?: boolean;
}) {
  const t = getTranslator(language);
  const pageOrigin = window.location.origin;

  return (
    <details
      open={expanded || undefined}
      className="text-sm text-muted-foreground"
    >
      <summary className="cursor-pointer">
        {t('daemon.connection.setup')}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <p>
          {t('daemon.connection.pageOrigin')}:{' '}
          <code className="break-all">{pageOrigin}</code>
        </p>
        <p>{t('daemon.connection.setupCommand')}</p>
        <p>{t('daemon.connection.setupHttps')}</p>
        <p>{t('daemon.connection.setupOrigins')}</p>
        <p>{t('daemon.connection.existingService')}</p>
      </div>
    </details>
  );
}
