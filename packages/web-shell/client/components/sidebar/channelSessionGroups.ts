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
    const configuredType = session.sourceId
      ? instances[session.sourceId]?.config['type']
      : undefined;
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
