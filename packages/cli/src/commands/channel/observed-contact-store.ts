import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ObservedChannelContactGraph,
  ObservedChannelContactObservation,
  ObservedChannelGroup,
  ObservedChannelIdentity,
  ObservedChannelRelatedContact,
  ObservedChannelTopic,
} from '@qwen-code/channel-base';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';

const REGISTRY_VERSION = 1;
const MAX_OBSERVATIONS = 500;
const MAX_CHANNEL_NAME_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;
const MAX_ID_LENGTH = 4096;
export const OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS = 365 * 24 * 60 * 60;

interface PersistedObservedContact {
  channelName: string;
  user: ObservedChannelIdentity;
  group?: ObservedChannelIdentity;
  topic?: ObservedChannelIdentity;
  lastObservedAt: string;
}

interface ObservedContactRegistryFile {
  version: typeof REGISTRY_VERSION;
  observations: PersistedObservedContact[];
}

interface ObservedChannelContactStoreOptions {
  now?: () => Date;
  maxObservations?: number;
}

interface ListObservedContactsOptions {
  freshWithinSeconds: number;
}

interface MutableObservedGroup extends ObservedChannelGroup {
  userMap: Map<string, ObservedChannelRelatedContact>;
  topicMap: Map<string, MutableObservedTopic>;
}

interface MutableObservedTopic extends ObservedChannelTopic {
  userMap: Map<string, ObservedChannelRelatedContact>;
}

export class ObservedChannelContactStore {
  private readonly now: () => Date;
  private readonly maxObservations: number;

  constructor(
    private readonly filePath: string,
    options: ObservedChannelContactStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxObservations = options.maxObservations ?? MAX_OBSERVATIONS;
  }

  observe(
    channelName: string,
    observation: ObservedChannelContactObservation,
  ): void {
    this.validateObservation(channelName, observation);
    const observedAt = this.now();
    const next: PersistedObservedContact = {
      channelName,
      user: this.normalizeIdentity(observation.user),
      ...(observation.group
        ? { group: this.normalizeIdentity(observation.group) }
        : {}),
      ...(observation.topic
        ? { topic: this.normalizeIdentity(observation.topic) }
        : {}),
      lastObservedAt: observedAt.toISOString(),
    };
    const key = this.observationKey(next);
    const retentionCutoff =
      observedAt.getTime() - OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS * 1000;
    const observations = this.readObservations()
      .filter(
        (candidate) =>
          Date.parse(candidate.lastObservedAt) >= retentionCutoff &&
          this.observationKey(candidate) !== key,
      )
      .concat(next)
      .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))
      .slice(0, this.maxObservations);
    this.persist(observations);
  }

  list(options: ListObservedContactsOptions): ObservedChannelContactGraph {
    const { freshWithinSeconds } = options;
    if (
      !Number.isInteger(freshWithinSeconds) ||
      freshWithinSeconds < 1 ||
      freshWithinSeconds > OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS
    ) {
      throw new Error('Invalid observed contact freshness.');
    }
    const cutoff = this.now().getTime() - freshWithinSeconds * 1000;
    const observations = this.readObservations()
      .filter((observation) => Date.parse(observation.lastObservedAt) >= cutoff)
      .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
    const users = new Map<
      string,
      ObservedChannelContactGraph['users'][number]
    >();
    const groups = new Map<string, MutableObservedGroup>();

    for (const observation of observations) {
      if (!observation.group) {
        const key = this.identityKey(
          observation.channelName,
          observation.user.id,
        );
        if (!users.has(key)) {
          users.set(key, {
            channelName: observation.channelName,
            ...observation.user,
            lastObservedAt: observation.lastObservedAt,
          });
        }
        continue;
      }

      const groupKey = this.identityKey(
        observation.channelName,
        observation.group.id,
      );
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          channelName: observation.channelName,
          ...observation.group,
          lastObservedAt: observation.lastObservedAt,
          users: [],
          topics: [],
          userMap: new Map(),
          topicMap: new Map(),
        };
        groups.set(groupKey, group);
      }

      if (!group.userMap.has(observation.user.id)) {
        group.userMap.set(observation.user.id, {
          ...observation.user,
          lastObservedAt: observation.lastObservedAt,
        });
      }

      if (observation.topic) {
        let topic = group.topicMap.get(observation.topic.id);
        if (!topic) {
          topic = {
            ...observation.topic,
            lastObservedAt: observation.lastObservedAt,
            users: [],
            userMap: new Map(),
          };
          group.topicMap.set(observation.topic.id, topic);
        }
        if (!topic.userMap.has(observation.user.id)) {
          topic.userMap.set(observation.user.id, {
            ...observation.user,
            lastObservedAt: observation.lastObservedAt,
          });
        }
      }
    }

    return {
      users: [...users.values()],
      groups: [...groups.values()].map((group) => ({
        channelName: group.channelName,
        id: group.id,
        label: group.label,
        lastObservedAt: group.lastObservedAt,
        users: [...group.userMap.values()],
        topics: [...group.topicMap.values()].map((topic) => ({
          id: topic.id,
          label: topic.label,
          lastObservedAt: topic.lastObservedAt,
          users: [...topic.userMap.values()],
        })),
      })),
    };
  }

  private readObservations(): PersistedObservedContact[] {
    if (!existsSync(this.filePath)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      throw new Error('Invalid observed contact registry.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid observed contact registry.');
    }
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== REGISTRY_VERSION) {
      throw new Error('Unsupported observed contact registry version.');
    }
    if (
      !Array.isArray(record['observations']) ||
      record['observations'].length > this.maxObservations
    ) {
      throw new Error('Invalid observed contact registry.');
    }

    const observations = record['observations'].map((raw) =>
      this.parseObservation(raw),
    );
    const keys = new Set(observations.map((item) => this.observationKey(item)));
    if (keys.size !== observations.length) {
      throw new Error('Invalid observed contact registry.');
    }
    return observations;
  }

  private parseObservation(raw: unknown): PersistedObservedContact {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid observed contact registry.');
    }
    const record = raw as Record<string, unknown>;
    const channelName = record['channelName'];
    const lastObservedAt = record['lastObservedAt'];
    const user = this.parseIdentity(record['user']);
    const group =
      record['group'] === undefined
        ? undefined
        : this.parseIdentity(record['group']);
    const topic =
      record['topic'] === undefined
        ? undefined
        : this.parseIdentity(record['topic']);
    if (
      !this.isBoundedString(channelName, MAX_CHANNEL_NAME_LENGTH) ||
      typeof lastObservedAt !== 'string' ||
      !this.isCanonicalTimestamp(lastObservedAt) ||
      (topic !== undefined && group === undefined)
    ) {
      throw new Error('Invalid observed contact registry.');
    }
    return {
      channelName,
      user,
      ...(group ? { group } : {}),
      ...(topic ? { topic } : {}),
      lastObservedAt,
    };
  }

  private parseIdentity(raw: unknown): ObservedChannelIdentity {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid observed contact registry.');
    }
    const record = raw as Record<string, unknown>;
    const id = record['id'];
    const label = record['label'];
    if (
      !this.isBoundedString(id, MAX_ID_LENGTH) ||
      !this.isBoundedString(label, MAX_LABEL_LENGTH)
    ) {
      throw new Error('Invalid observed contact registry.');
    }
    return { id, label };
  }

  private validateObservation(
    channelName: string,
    observation: ObservedChannelContactObservation,
  ): void {
    if (
      !this.isBoundedString(channelName, MAX_CHANNEL_NAME_LENGTH) ||
      !this.isIdentity(observation.user) ||
      (observation.group !== undefined &&
        !this.isIdentity(observation.group)) ||
      (observation.topic !== undefined &&
        !this.isIdentity(observation.topic)) ||
      (observation.topic !== undefined && observation.group === undefined)
    ) {
      throw new Error('Invalid observed contact observation.');
    }
  }

  private isIdentity(value: ObservedChannelIdentity): boolean {
    return (
      this.isBoundedString(value.id, MAX_ID_LENGTH) &&
      this.isBoundedString(value.label, MAX_ID_LENGTH)
    );
  }

  private normalizeIdentity(
    value: ObservedChannelIdentity,
  ): ObservedChannelIdentity {
    return {
      id: value.id,
      label: this.truncateLabel(value.label),
    };
  }

  private truncateLabel(value: string): string {
    let result = '';
    for (const character of value) {
      if (result.length + character.length > MAX_LABEL_LENGTH) break;
      result += character;
    }
    return result;
  }

  private observationKey(observation: PersistedObservedContact): string {
    return JSON.stringify([
      observation.channelName,
      observation.user.id,
      observation.group?.id ?? '',
      observation.topic?.id ?? '',
    ]);
  }

  private identityKey(channelName: string, id: string): string {
    return JSON.stringify([channelName, id]);
  }

  private persist(observations: PersistedObservedContact[]): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows and some filesystems do not implement POSIX modes.
    }
    const data: ObservedContactRegistryFile = {
      version: REGISTRY_VERSION,
      observations,
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  }

  private isBoundedString(value: unknown, maxLength: number): value is string {
    return (
      typeof value === 'string' && value.length > 0 && value.length <= maxLength
    );
  }

  private isCanonicalTimestamp(value: string): boolean {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    );
  }
}
