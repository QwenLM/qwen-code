import { Laptop, Server } from 'lucide-react';
import { useI18n } from '../../i18n';

/**
 * Icon + short name for one daemon host: the page origin reads as "Local",
 * anything else shows its URL host. Shared by the sidebar host groups and
 * the composer workspace picker so every surface names hosts identically.
 */
export function HostLabel({ origin }: { origin: string }) {
  const { t } = useI18n();
  const local = origin === window.location.origin;
  const Icon = local ? Laptop : Server;
  return (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {local ? t('workspaceHost.local') : new URL(origin).host}
      </span>
    </>
  );
}
