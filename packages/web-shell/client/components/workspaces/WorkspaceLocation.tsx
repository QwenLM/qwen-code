import { Laptop, Server } from 'lucide-react';
import { getDaemonBaseUrl } from '../../config/daemon';
import { useI18n } from '../../i18n';

export function WorkspaceLocation({ cwd }: { cwd?: string }) {
  const { t } = useI18n();
  const origin = getDaemonBaseUrl();
  const remote = origin && origin !== window.location.origin;
  const Icon = remote ? Server : Laptop;
  const label = remote ? origin : t('workspaceHost.local');
  return (
    <div
      className="flex min-w-0 items-center gap-2 border-b px-4 py-1 text-xs text-muted-foreground"
      title={`${label} — ${cwd || ''}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">
        {remote ? t('workspaceHost.remote') : label}
      </span>
      <span className="truncate">
        {remote ? `${origin} · ` : ''}
        {cwd}
      </span>
    </div>
  );
}
