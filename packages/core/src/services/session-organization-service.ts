/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';

export const GROUP_COLOR_OPTIONS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
] as const;

export type SessionGroupColor = (typeof GROUP_COLOR_OPTIONS)[number];

export interface SessionGroup {
  id: string;
  name: string;
  color: SessionGroupColor;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionOrganization {
  groupId: string | null;
  pinnedAt?: string;
  updatedAt: string;
}

export interface SessionOrganizationView extends SessionOrganization {
  isPinned: boolean;
}

export interface SessionOrganizationSnapshot {
  groups: SessionGroup[];
  sessions: Map<string, SessionOrganizationView>;
}

export interface SessionGroupCatalog {
  groups: SessionGroup[];
  colorOptions: SessionGroupColor[];
}

export interface CreateSessionGroupInput {
  name: string;
  color: SessionGroupColor;
}

export interface UpdateSessionGroupInput {
  name?: string;
  color?: SessionGroupColor;
  order?: number;
}

export interface UpdateSessionOrganizationInput {
  isPinned?: boolean;
  groupId?: string | null;
}

interface SessionOrganizationStoreV1 {
  schemaVersion: 1;
  groups: SessionGroup[];
  sessions: Record<string, Partial<SessionOrganization>>;
}

export class SessionOrganizationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SessionOrganizationError';
  }
}

const STORE_FILE = 'session-organization.v1.json';
const SCHEMA_VERSION = 1;
const MAX_GROUP_NAME_LENGTH = 64;
const locks = new Map<string, Promise<unknown>>();

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const codePoint = char.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function normalizeGroupName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new SessionOrganizationError(
      '`name` must be a string',
      'invalid_group_name',
      'name',
    );
  }
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_GROUP_NAME_LENGTH ||
    hasControlCharacter(trimmed)
  ) {
    throw new SessionOrganizationError(
      '`name` must be 1-64 characters and contain no control characters',
      'invalid_group_name',
      'name',
    );
  }
  return trimmed;
}

function assertGroupColor(color: unknown): asserts color is SessionGroupColor {
  if (
    typeof color !== 'string' ||
    !GROUP_COLOR_OPTIONS.includes(color as SessionGroupColor)
  ) {
    throw new SessionOrganizationError(
      '`color` must be one of the supported color options',
      'invalid_group_color',
      'color',
    );
  }
}

function normalizeOrder(order: unknown): number {
  if (
    typeof order !== 'number' ||
    !Number.isFinite(order) ||
    !Number.isSafeInteger(order)
  ) {
    throw new SessionOrganizationError(
      '`order` must be a safe integer',
      'invalid_group_order',
      'order',
    );
  }
  return order;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionGroup(value: unknown): value is SessionGroup {
  if (!isPlainRecord(value)) return false;
  if (typeof value['id'] !== 'string') return false;
  if (typeof value['name'] !== 'string') return false;
  if (typeof value['color'] !== 'string') return false;
  if (!GROUP_COLOR_OPTIONS.includes(value['color'] as SessionGroupColor)) {
    return false;
  }
  if (typeof value['order'] !== 'number' || !Number.isFinite(value['order'])) {
    return false;
  }
  return (
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

function emptyStore(): SessionOrganizationStoreV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    groups: [],
    sessions: Object.create(null) as Record<
      string,
      Partial<SessionOrganization>
    >,
  };
}

function groupNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function viewOrganization(
  organization: Partial<SessionOrganization> | undefined,
): SessionOrganizationView {
  const groupId =
    typeof organization?.groupId === 'string' ? organization.groupId : null;
  const pinnedAt =
    typeof organization?.pinnedAt === 'string'
      ? organization.pinnedAt
      : undefined;
  const updatedAt =
    typeof organization?.updatedAt === 'string'
      ? organization.updatedAt
      : new Date(0).toISOString();
  return {
    groupId,
    ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    updatedAt,
    isPinned: pinnedAt !== undefined,
  };
}

function serializeOrganization(
  organization: SessionOrganizationView,
): SessionOrganization {
  return {
    groupId: organization.groupId,
    ...(organization.pinnedAt !== undefined
      ? { pinnedAt: organization.pinnedAt }
      : {}),
    updatedAt: organization.updatedAt,
  };
}

export class SessionOrganizationService {
  private readonly storage: Storage;

  constructor(
    cwd: string,
    private readonly onWarning?: (message: string) => void,
  ) {
    this.storage = new Storage(cwd);
  }

  getStorePath(): string {
    return path.join(this.storage.getProjectDir(), STORE_FILE);
  }

  async listGroups(): Promise<SessionGroupCatalog> {
    const store = await this.readStore();
    return {
      groups: this.sortGroups(store.groups),
      colorOptions: [...GROUP_COLOR_OPTIONS],
    };
  }

  async readSnapshot(): Promise<SessionOrganizationSnapshot> {
    const store = await this.readStore();
    const validGroupIds = new Set(store.groups.map((group) => group.id));
    const sessions = new Map<string, SessionOrganizationView>();
    for (const [sessionId, raw] of Object.entries(store.sessions)) {
      const view = viewOrganization(raw);
      if (view.groupId !== null && !validGroupIds.has(view.groupId)) {
        view.groupId = null;
      }
      sessions.set(sessionId, view);
    }
    return { groups: this.sortGroups(store.groups), sessions };
  }

  async createGroup(input: CreateSessionGroupInput): Promise<SessionGroup> {
    const name = normalizeGroupName(input.name);
    assertGroupColor(input.color);
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.assertGroupNameAvailable(store.groups, name);
      const now = new Date().toISOString();
      const group: SessionGroup = {
        id: randomUUID(),
        name,
        color: input.color,
        order:
          store.groups.reduce(
            (maxOrder, existing) => Math.max(maxOrder, existing.order),
            -1,
          ) + 1,
        createdAt: now,
        updatedAt: now,
      };
      store.groups.push(group);
      await this.writeStore(store);
      return group;
    });
  }

  async updateGroup(
    groupId: string,
    input: UpdateSessionGroupInput,
  ): Promise<SessionGroup> {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const group = store.groups.find((candidate) => candidate.id === groupId);
      if (!group) {
        throw new SessionOrganizationError(
          `Group not found: ${groupId}`,
          'group_not_found',
          'groupId',
        );
      }
      if (input.name !== undefined) {
        const name = normalizeGroupName(input.name);
        this.assertGroupNameAvailable(store.groups, name, groupId);
        group.name = name;
      }
      if (input.color !== undefined) {
        assertGroupColor(input.color);
        group.color = input.color;
      }
      if (input.order !== undefined) {
        group.order = normalizeOrder(input.order);
      }
      group.updatedAt = new Date().toISOString();
      await this.writeStore(store);
      return group;
    });
  }

  async deleteGroup(groupId: string): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const before = store.groups.length;
      store.groups = store.groups.filter((group) => group.id !== groupId);
      if (store.groups.length === before) {
        return false;
      }
      const now = new Date().toISOString();
      for (const session of Object.values(store.sessions)) {
        if (session.groupId === groupId) {
          session.groupId = null;
          session.updatedAt = now;
        }
      }
      await this.writeStore(store);
      return true;
    });
  }

  async updateSessionOrganization(
    sessionId: string,
    input: UpdateSessionOrganizationInput,
  ): Promise<SessionOrganizationView> {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const current = viewOrganization(store.sessions[sessionId]);
      const now = new Date().toISOString();
      if (input.groupId !== undefined) {
        if (
          input.groupId !== null &&
          !store.groups.some((group) => group.id === input.groupId)
        ) {
          throw new SessionOrganizationError(
            `Group not found: ${input.groupId}`,
            'group_not_found',
            'groupId',
          );
        }
        current.groupId = input.groupId;
      }
      if (input.isPinned !== undefined) {
        if (input.isPinned) {
          current.pinnedAt = current.pinnedAt ?? now;
        } else {
          delete current.pinnedAt;
        }
      }
      current.updatedAt = now;
      store.sessions[sessionId] = serializeOrganization(current);
      await this.writeStore(store);
      return viewOrganization(store.sessions[sessionId]);
    });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.withStoreLock(async () => {
      const store = await this.readStore();
      if (!Object.prototype.hasOwnProperty.call(store.sessions, sessionId)) {
        return;
      }
      delete store.sessions[sessionId];
      await this.writeStore(store);
    });
  }

  private async withStoreLock<T>(work: () => Promise<T>): Promise<T> {
    const storePath = this.getStorePath();
    const previous = locks.get(storePath) ?? Promise.resolve();
    const next = previous.then(work, work);
    const lock = next
      .catch(() => undefined)
      .finally(() => {
        if (locks.get(storePath) === lock) {
          locks.delete(storePath);
        }
      });
    locks.set(storePath, lock);
    return next;
  }

  private async readStore(): Promise<SessionOrganizationStoreV1> {
    try {
      const raw = JSON.parse(
        await fs.readFile(this.getStorePath(), 'utf8'),
      ) as unknown;
      if (!isPlainRecord(raw) || raw['schemaVersion'] !== SCHEMA_VERSION) {
        return emptyStore();
      }
      const groups = Array.isArray(raw['groups'])
        ? raw['groups'].filter(isSessionGroup)
        : [];
      const sessions = isPlainRecord(raw['sessions']) ? raw['sessions'] : {};
      const normalizedSessions = Object.create(null) as Record<
        string,
        Partial<SessionOrganization>
      >;
      for (const [sessionId, organization] of Object.entries(sessions)) {
        if (isPlainRecord(organization)) {
          normalizedSessions[sessionId] = {
            groupId:
              typeof organization['groupId'] === 'string'
                ? organization['groupId']
                : null,
            ...(typeof organization['pinnedAt'] === 'string'
              ? { pinnedAt: organization['pinnedAt'] }
              : {}),
            updatedAt:
              typeof organization['updatedAt'] === 'string'
                ? organization['updatedAt']
                : new Date(0).toISOString(),
          };
        }
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        groups: this.dedupeGroups(groups),
        sessions: normalizedSessions,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyStore();
      }
      this.onWarning?.(
        `Failed to read session organization store at ${this.getStorePath()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return emptyStore();
    }
  }

  private async writeStore(store: SessionOrganizationStoreV1): Promise<void> {
    await fs.mkdir(path.dirname(this.getStorePath()), { recursive: true });
    await atomicWriteJSON(this.getStorePath(), {
      schemaVersion: SCHEMA_VERSION,
      groups: this.sortGroups(store.groups),
      sessions: store.sessions,
    });
  }

  private assertGroupNameAvailable(
    groups: SessionGroup[],
    name: string,
    exceptGroupId?: string,
  ): void {
    const key = groupNameKey(name);
    if (
      groups.some(
        (group) =>
          group.id !== exceptGroupId && groupNameKey(group.name) === key,
      )
    ) {
      throw new SessionOrganizationError(
        `Group name already exists: ${name}`,
        'group_name_conflict',
        'name',
      );
    }
  }

  private sortGroups(groups: SessionGroup[]): SessionGroup[] {
    return [...groups].sort((a, b) => {
      const byOrder = a.order - b.order;
      if (byOrder !== 0) return byOrder;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
  }

  private dedupeGroups(groups: SessionGroup[]): SessionGroup[] {
    const seen = new Set<string>();
    const deduped: SessionGroup[] = [];
    for (const group of groups) {
      const key = groupNameKey(group.name);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(group);
    }
    return deduped;
  }
}
