import { Laptop, Server } from 'lucide-react';
import { getDaemonBaseUrl } from '../../config/daemon';
import { useWorkspaceHosts } from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';

/**
 * Compact label naming the host a chat runs on, with the working directory in
 * its tooltip. Hidden until a project can live on more than one host.
 */
export function WorkspaceLocation({ cwd }: { cwd?: string }) {
  const { t } = useI18n();
  const hosts = useWorkspaceHosts();
  const origin = getDaemonBaseUrl();
  const remote = Boolean(origin) && origin !== window.location.origin;
  if (
    !remote &&
    !hosts.some((host) => host.origin !== window.location.origin)
  ) {
    return null;
  }
  const Icon = remote ? Server : Laptop;
  const host = remote ? new URL(origin).host : t('workspaceHost.local');
  const label = remote ? `${t('workspaceHost.remote')} · ${host}` : host;
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
      title={cwd ? `${remote ? origin : host} — ${cwd}` : label}
      data-testid="workspace-location"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
