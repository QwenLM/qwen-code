import { Laptop, Server } from 'lucide-react';
import { getDaemonBaseUrl } from '../../config/daemon';
import { useWorkspaceHosts } from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';

export function WorkspaceLocation({ cwd }: { cwd?: string }) {
  const { t } = useI18n();
  const hosts = useWorkspaceHosts();
  const origin = getDaemonBaseUrl();
  const remote = Boolean(origin) && origin !== window.location.origin;
  // Naming the host only helps once a project can live on more than one.
  if (
    !remote &&
    !hosts.some((host) => host.origin !== window.location.origin)
  ) {
    return null;
  }
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
