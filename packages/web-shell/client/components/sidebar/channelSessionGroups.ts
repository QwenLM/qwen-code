import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeCatalog,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';

export interface ChannelSessionGroup {
  id: string;
  label: string;
  sessions: DaemonSessionSummary[];
}

const FALLBACK_GROUP_ID = 'channel-type-fallback';

export function groupSessionsByChannelType(
  sessions: readonly DaemonSessionSummary[],
  catalog: DaemonChannelTypeCatalog,
  instances: Readonly<Record<string, DaemonChannelInstanceSnapshot>>,
  otherLabel: string,
): ChannelSessionGroup[] {
  const labels = new Map(
    catalog.map((descriptor) => [descriptor.type, descriptor.displayName]),
  );
  const groups = new Map<string, ChannelSessionGroup>();

  for (const session of sessions) {
    // Object.hasOwn: a sourceId like 'constructor' resolves through
    // Object.prototype on a plain record, so a bare index read would
    // dereference `.config` on the Object function and throw.
    const instance =
      session.sourceId && Object.hasOwn(instances, session.sourceId)
        ? instances[session.sourceId]
        : undefined;
    const configuredType = instance?.config['type'];
    const type =
      typeof configuredType === 'string'
        ? configuredType.trim() || undefined
        : undefined;
    const id = type ? `channel-type:${type}` : FALLBACK_GROUP_ID;
    const existing = groups.get(id);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    groups.set(id, {
      id,
      label: type ? (labels.get(type) ?? type) : otherLabel,
      sessions: [session],
    });
  }

  const ordered = [...groups.values()];
  const fallback = groups.get(FALLBACK_GROUP_ID);
  // Keep the unresolved "Other channels" section after every named platform
  // instead of letting first-seen session order wedge it between two of them.
  return fallback === undefined
    ? ordered
    : [...ordered.filter((group) => group !== fallback), fallback];
}
