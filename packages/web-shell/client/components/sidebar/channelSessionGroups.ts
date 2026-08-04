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
    const id = type ? `channel-type:${type}` : 'channel-type-fallback';
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

  return [...groups.values()];
}
