import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SessionTarget } from './types.js';
import type { SessionRouter } from './SessionRouter.js';

const REGISTRY_VERSION = 1;
const MAX_OPEN_TASKS = 8;
const TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface NamedSessionOwnerInput {
  senderId: string;
  chatId: string;
  threadId?: string;
  isGroup?: boolean;
}

export interface NamedSessionView {
  name: string;
  status: 'open' | 'closed';
  isolation: 'shared';
  active: boolean;
}

export interface NamedSessionSelection extends NamedSessionView {
  sessionId: string;
}

export interface NamedSessionManagerOptions {
  channelName: string;
  cwd: string;
  filePath: string;
  router: SessionRouter;
  isBusy(sessionId: string): boolean;
  now?: () => number;
}

interface StoredTask {
  name: string;
  sessionId: string;
  cwd: string;
  isolation: 'shared';
  status: 'open' | 'closed';
  target: SessionTarget;
  createdAt: number;
  updatedAt: number;
  lastSelectedAt: number;
}

interface StoredOwner {
  channelName: string;
  chatId: string;
  senderId: string;
  activeTaskName: string | null;
  tasks: StoredTask[];
}

interface StoredRegistry {
  version: 1;
  owners: StoredOwner[];
}

export class NamedSessionManager {
  private readonly channelName: string;
  private readonly cwd: string;
  private readonly filePath: string;
  private readonly router: SessionRouter;
  private readonly isBusy: (sessionId: string) => boolean;
  private readonly now: () => number;
  private registry: StoredRegistry;
  private readonly ownerOperations = new Map<string, Promise<void>>();

  constructor(options: NamedSessionManagerOptions) {
    this.channelName = options.channelName;
    this.cwd = options.cwd;
    this.filePath = options.filePath;
    this.router = options.router;
    this.isBusy = options.isBusy;
    this.now = options.now ?? Date.now;
    this.registry = this.readRegistry();
  }

  resolve(
    input: NamedSessionOwnerInput,
    expectedSessionId?: string,
    reserve?: (sessionId: string) => () => void,
  ): Promise<string | undefined> {
    return this.withOwnerLock(input, () =>
      this.resolveLocked(input, expectedSessionId, reserve),
    );
  }

  resolveAfterPreparation(
    input: NamedSessionOwnerInput,
    prepare: () => Promise<boolean | void>,
    needsSession: () => boolean,
    reserve: (sessionId: string) => () => void,
  ): Promise<
    | { status: 'aborted' | 'bypassed' }
    | { status: 'resolved'; sessionId?: string }
    | { status: 'resolve_error'; error: unknown }
  > {
    return this.withOwnerLock(input, async () => {
      if ((await prepare()) === false) return { status: 'aborted' };
      if (!needsSession()) return { status: 'bypassed' };
      try {
        return {
          status: 'resolved',
          sessionId: await this.resolveLocked(input, undefined, reserve),
        };
      } catch (error) {
        return { status: 'resolve_error', error };
      }
    });
  }

  list(
    input: NamedSessionOwnerInput,
    includeClosed: boolean,
  ): Promise<NamedSessionView[]> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner) return [];
      return owner.tasks
        .filter((task) => includeClosed || task.status === 'open')
        .map((task) => this.view(owner, task));
    });
  }

  current(
    input: NamedSessionOwnerInput,
  ): Promise<NamedSessionSelection | undefined> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner?.activeTaskName) return undefined;
      const task = this.findTask(owner, owner.activeTaskName);
      return task ? this.selection(owner, task) : undefined;
    });
  }

  create(
    input: NamedSessionOwnerInput,
    name: string,
  ): Promise<NamedSessionSelection> {
    return this.withOwnerLock(input, async () => {
      this.validateName(name);
      const existingOwner = await this.ensureOwner(input, false);
      const owner = existingOwner ?? this.createOwner(input, null, []);
      if (this.findTask(owner, name)) {
        throw new Error(`Task "${name}" already exists.`);
      }
      if (this.openTaskCount(owner) >= MAX_OPEN_TASKS) {
        throw new Error(
          'You already have eight open tasks. Close one before creating another.',
        );
      }
      this.assertCanLeaveSelected(owner, undefined);
      const timestamp = this.nextTimestamp(owner);

      const target = this.target(input);
      const sessionId = await this.createSession(
        target,
        this.cwd,
        `Could not create task "${name}".`,
      );
      const task: StoredTask = {
        name,
        sessionId,
        cwd: this.cwd,
        isolation: 'shared',
        status: 'open',
        target,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      const nextOwner: StoredOwner = {
        ...owner,
        activeTaskName: name,
        tasks: [...owner.tasks, task],
      };
      try {
        this.commitOwner(nextOwner);
      } catch (error) {
        await this.router
          .detachManagedSession(sessionId)
          .catch(() => undefined);
        throw error;
      }
      this.router.activateManagedSession(sessionId, target, this.cwd);
      return this.selection(nextOwner, task);
    });
  }

  use(
    input: NamedSessionOwnerInput,
    name: string,
  ): Promise<NamedSessionSelection> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner) throw new Error('No named tasks exist in this chat.');
      const task = this.findTask(owner, name);
      if (!task) throw new Error(`Task "${name}" was not found.`);
      this.assertCanLeaveSelected(owner, task.name);
      if (this.isBusy(task.sessionId)) {
        throw new Error(
          `Task "${task.name}" is still running or waiting for permission.`,
        );
      }
      if (
        task.status === 'closed' &&
        this.openTaskCount(owner) >= MAX_OPEN_TASKS
      ) {
        throw new Error(
          'You already have eight open tasks. Close one before reopening another.',
        );
      }
      const timestamp = this.nextTimestamp(owner);

      const loaded = await this.loadTask(
        task,
        `Could not load task "${task.name}". The current task was not changed.`,
      );
      const updatedTask: StoredTask = {
        ...task,
        status: 'open',
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      const nextOwner = this.replaceTask(owner, updatedTask, task.name);
      try {
        this.commitOwner(nextOwner);
      } catch (error) {
        if (loaded) {
          await this.router
            .detachManagedSession(task.sessionId)
            .catch(() => undefined);
        }
        throw error;
      }
      this.router.activateManagedSession(task.sessionId, task.target, task.cwd);
      return this.selection(nextOwner, updatedTask);
    });
  }

  close(
    input: NamedSessionOwnerInput,
    name: string,
  ): Promise<{ closed: NamedSessionView; active?: NamedSessionView }> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner) throw new Error('No named tasks exist in this chat.');
      const task = this.findTask(owner, name);
      if (!task) throw new Error(`Task "${name}" was not found.`);
      if (task.status === 'closed') {
        throw new Error(`Task "${task.name}" is already closed.`);
      }
      if (this.isBusy(task.sessionId)) {
        throw new Error(
          `Task "${task.name}" is still running or waiting for permission.`,
        );
      }

      const wasActive = this.sameName(owner.activeTaskName, task.name);
      const timestamp = this.nextTimestamp(owner);
      const replacement = wasActive
        ? owner.tasks
            .filter(
              (candidate) =>
                candidate.status === 'open' &&
                !this.sameName(candidate.name, task.name),
            )
            .sort((a, b) => b.lastSelectedAt - a.lastSelectedAt)[0]
        : undefined;
      let replacementLoaded = false;
      if (replacement) {
        if (this.isBusy(replacement.sessionId)) {
          throw new Error(
            `Task "${replacement.name}" is still running or waiting for permission.`,
          );
        }
        replacementLoaded = await this.loadTask(
          replacement,
          `Could not load fallback task "${replacement.name}". Task "${task.name}" was not closed.`,
        );
      }

      const closedTask: StoredTask = {
        ...task,
        status: 'closed',
        updatedAt: timestamp,
      };
      let nextOwner = this.replaceTask(
        owner,
        closedTask,
        wasActive ? (replacement?.name ?? null) : owner.activeTaskName,
      );
      const selectedReplacement = replacement
        ? {
            ...replacement,
            updatedAt: timestamp,
            lastSelectedAt: timestamp,
          }
        : undefined;
      if (selectedReplacement) {
        nextOwner = this.replaceTask(
          nextOwner,
          selectedReplacement,
          selectedReplacement.name,
        );
      }
      try {
        this.commitOwner(nextOwner);
      } catch (error) {
        if (replacement && replacementLoaded) {
          await this.router
            .detachManagedSession(replacement.sessionId)
            .catch(() => undefined);
        }
        throw error;
      }

      if (replacement) {
        this.router.activateManagedSession(
          replacement.sessionId,
          replacement.target,
          replacement.cwd,
        );
      }
      try {
        await this.router.detachManagedSession(task.sessionId);
      } catch (error) {
        this.commitOwner(owner);
        this.router.forgetManagedSession(task.sessionId);
        await this.loadTask(
          task,
          `Task "${task.name}" could not be restored after close failed.`,
        );
        if (wasActive) {
          this.router.activateManagedSession(
            task.sessionId,
            task.target,
            task.cwd,
          );
        }
        throw new Error(`Failed to close task "${task.name}".`, {
          cause: error,
        });
      }
      return {
        closed: this.view(nextOwner, closedTask),
        ...(selectedReplacement
          ? { active: this.view(nextOwner, selectedReplacement) }
          : {}),
      };
    });
  }

  reset(
    input: NamedSessionOwnerInput,
  ): Promise<
    { name: string; previousSessionId: string; sessionId: string } | undefined
  > {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner?.activeTaskName) return undefined;
      const task = this.findTask(owner, owner.activeTaskName);
      if (!task || task.status !== 'open') return undefined;
      const timestamp = this.nextTimestamp(owner);

      const sessionId = await this.createSession(
        task.target,
        task.cwd,
        `Could not reset task "${task.name}".`,
      );
      const updatedTask: StoredTask = {
        ...task,
        sessionId,
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      const nextOwner = this.replaceTask(owner, updatedTask, task.name);
      try {
        this.commitOwner(nextOwner);
      } catch (error) {
        await this.router
          .detachManagedSession(sessionId)
          .catch(() => undefined);
        throw error;
      }
      this.router.activateManagedSession(
        sessionId,
        updatedTask.target,
        updatedTask.cwd,
      );
      this.router.forgetManagedSession(task.sessionId);
      return {
        name: task.name,
        previousSessionId: task.sessionId,
        sessionId,
      };
    });
  }

  private async ensureOwner(
    input: NamedSessionOwnerInput,
    createDefault: boolean,
  ): Promise<StoredOwner | undefined> {
    const existing = this.getOwner(input);
    if (existing) return existing;

    const sessionId = this.router.getSession(
      this.channelName,
      input.senderId,
      input.chatId,
    );
    const routedTarget = sessionId
      ? this.router.getTarget(sessionId)
      : undefined;
    if (
      sessionId &&
      routedTarget &&
      (routedTarget.channelName !== this.channelName ||
        routedTarget.chatId !== input.chatId ||
        routedTarget.senderId !== input.senderId)
    ) {
      this.adoptForeignLegacyRoute(sessionId, routedTarget);
    }
    if (
      sessionId &&
      routedTarget?.channelName === this.channelName &&
      routedTarget.chatId === input.chatId &&
      routedTarget.senderId === input.senderId
    ) {
      const timestamp = this.nextTimestamp();
      const task: StoredTask = {
        name: 'default',
        sessionId,
        cwd: this.router.getSessionCwd(sessionId) ?? this.cwd,
        isolation: 'shared',
        status: 'open',
        target: routedTarget,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      const adopted = this.createOwner(input, task.name, [task]);
      this.commitOwner(adopted);
      return adopted;
    }
    if (!createDefault) return undefined;

    const target = this.target(input);
    const timestamp = this.nextTimestamp();
    const createdSessionId = await this.createSession(
      target,
      this.cwd,
      'Could not create the default task.',
    );
    const task: StoredTask = {
      name: 'default',
      sessionId: createdSessionId,
      cwd: this.cwd,
      isolation: 'shared',
      status: 'open',
      target,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSelectedAt: timestamp,
    };
    const created = this.createOwner(input, task.name, [task]);
    try {
      this.commitOwner(created);
    } catch (error) {
      await this.router
        .detachManagedSession(createdSessionId)
        .catch(() => undefined);
      throw error;
    }
    this.router.activateManagedSession(createdSessionId, target, this.cwd);
    return created;
  }

  private async resolveLocked(
    input: NamedSessionOwnerInput,
    expectedSessionId?: string,
    reserve?: (sessionId: string) => () => void,
  ): Promise<string | undefined> {
    const owner = await this.ensureOwner(input, true);
    if (!owner?.activeTaskName) return undefined;
    const task = this.findTask(owner, owner.activeTaskName);
    if (!task || task.status !== 'open') {
      throw new Error('The selected Channel task is unavailable.');
    }
    if (
      expectedSessionId !== undefined &&
      task.sessionId !== expectedSessionId
    ) {
      return undefined;
    }
    const release = reserve?.(task.sessionId);
    try {
      await this.loadTask(
        task,
        `Could not load task "${task.name}". No replacement session was created.`,
      );
      this.router.activateManagedSession(task.sessionId, task.target, task.cwd);
      return task.sessionId;
    } catch (error) {
      release?.();
      throw error;
    }
  }

  private adoptForeignLegacyRoute(
    sessionId: string,
    target: SessionTarget,
  ): void {
    const cwd = this.router.getSessionCwd(sessionId);
    if (target.channelName !== this.channelName || cwd !== this.cwd) {
      throw new Error('Cannot safely migrate a colliding legacy session.');
    }
    const existing = this.getOwner(target);
    if (existing) {
      if (existing.tasks.some((task) => task.sessionId === sessionId)) return;
      throw new Error('Colliding legacy session conflicts with named tasks.');
    }
    const timestamp = this.nextTimestamp();
    const task: StoredTask = {
      name: 'default',
      sessionId,
      cwd,
      isolation: 'shared',
      status: 'open',
      target,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSelectedAt: timestamp,
    };
    this.commitOwner(this.createOwner(target, task.name, [task]));
  }

  private assertCanLeaveSelected(
    owner: StoredOwner,
    nextTaskName: string | undefined,
  ): void {
    if (
      !owner.activeTaskName ||
      (nextTaskName && this.sameName(owner.activeTaskName, nextTaskName))
    ) {
      return;
    }
    const selected = this.findTask(owner, owner.activeTaskName);
    if (selected && this.isBusy(selected.sessionId)) {
      throw new Error(
        `Task "${selected.name}" is still running or waiting for permission.`,
      );
    }
  }

  private async loadTask(
    task: StoredTask,
    failureMessage: string,
  ): Promise<boolean> {
    try {
      return (
        await this.router.loadManagedSession(
          task.sessionId,
          task.target,
          task.cwd,
        )
      ).loaded;
    } catch (error) {
      throw new Error(failureMessage, { cause: error });
    }
  }

  private async createSession(
    target: SessionTarget,
    cwd: string,
    failureMessage: string,
  ): Promise<string> {
    try {
      return await this.router.createManagedSession(target, cwd);
    } catch (error) {
      throw new Error(failureMessage, { cause: error });
    }
  }

  private withOwnerLock<T>(
    input: NamedSessionOwnerInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([
      this.channelName,
      input.chatId,
      input.senderId,
    ]);
    const previous = this.ownerOperations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerOperations.set(key, tail);
    return result.finally(() => {
      if (this.ownerOperations.get(key) === tail) {
        this.ownerOperations.delete(key);
      }
    });
  }

  private getOwner(input: NamedSessionOwnerInput): StoredOwner | undefined {
    const owner = this.registry.owners.find(
      (candidate) =>
        candidate.channelName === this.channelName &&
        candidate.chatId === input.chatId &&
        candidate.senderId === input.senderId,
    );
    return owner ? this.cloneOwner(owner) : undefined;
  }

  private createOwner(
    input: NamedSessionOwnerInput,
    activeTaskName: string | null,
    tasks: StoredTask[],
  ): StoredOwner {
    return {
      channelName: this.channelName,
      chatId: input.chatId,
      senderId: input.senderId,
      activeTaskName,
      tasks,
    };
  }

  private target(input: NamedSessionOwnerInput): SessionTarget {
    return {
      channelName: this.channelName,
      senderId: input.senderId,
      chatId: input.chatId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isGroup !== undefined ? { isGroup: input.isGroup } : {}),
    };
  }

  private findTask(owner: StoredOwner, name: string): StoredTask | undefined {
    const normalized = this.normalizeName(name);
    return owner.tasks.find(
      (task) => this.normalizeName(task.name) === normalized,
    );
  }

  private replaceTask(
    owner: StoredOwner,
    task: StoredTask,
    activeTaskName: string | null,
  ): StoredOwner {
    return {
      ...owner,
      activeTaskName,
      tasks: owner.tasks.map((candidate) =>
        this.sameName(candidate.name, task.name) ? task : candidate,
      ),
    };
  }

  private view(owner: StoredOwner, task: StoredTask): NamedSessionView {
    return {
      name: task.name,
      status: task.status,
      isolation: task.isolation,
      active:
        task.status === 'open' &&
        this.sameName(owner.activeTaskName, task.name),
    };
  }

  private selection(
    owner: StoredOwner,
    task: StoredTask,
  ): NamedSessionSelection {
    return { ...this.view(owner, task), sessionId: task.sessionId };
  }

  private openTaskCount(owner: StoredOwner): number {
    return owner.tasks.filter((task) => task.status === 'open').length;
  }

  private nextTimestamp(owner?: StoredOwner): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid named-session clock value.');
    }
    let timestamp = now;
    for (const task of owner?.tasks ?? []) {
      timestamp = Math.max(
        timestamp,
        task.createdAt + 1,
        task.updatedAt + 1,
        task.lastSelectedAt + 1,
      );
    }
    if (!Number.isSafeInteger(timestamp)) {
      throw new Error('Named-session timestamp limit reached.');
    }
    return timestamp;
  }

  private validateName(name: string): void {
    if (!TASK_NAME_PATTERN.test(name)) {
      throw new Error(
        'Task names must be 1-32 ASCII letters, numbers, underscores, or hyphens and start with a letter or number.',
      );
    }
  }

  private normalizeName(name: string): string {
    return name.toLowerCase();
  }

  private sameName(a: string | null, b: string): boolean {
    return a !== null && this.normalizeName(a) === this.normalizeName(b);
  }

  private cloneOwner(owner: StoredOwner): StoredOwner {
    return {
      ...owner,
      tasks: owner.tasks.map((task) => ({
        ...task,
        target: { ...task.target },
      })),
    };
  }

  private commitOwner(owner: StoredOwner): void {
    const owners = this.registry.owners.map((candidate) =>
      candidate.channelName === owner.channelName &&
      candidate.chatId === owner.chatId &&
      candidate.senderId === owner.senderId
        ? owner
        : candidate,
    );
    if (
      !owners.some(
        (candidate) =>
          candidate.channelName === owner.channelName &&
          candidate.chatId === owner.chatId &&
          candidate.senderId === owner.senderId,
      )
    ) {
      owners.push(owner);
    }
    const next: StoredRegistry = { version: REGISTRY_VERSION, owners };
    if (!this.isRegistry(next)) {
      throw new Error('Invalid named-session registry update.');
    }
    this.writeRegistry(next);
    this.registry = next;
  }

  private readRegistry(): StoredRegistry {
    if (!existsSync(this.filePath)) {
      return { version: REGISTRY_VERSION, owners: [] };
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Failed to read named-session registry: ${this.filePath}`,
        {
          cause: error,
        },
      );
    }
    if (!this.isRegistry(value)) {
      throw new Error(`Invalid named-session registry: ${this.filePath}`);
    }
    return value;
  }

  private writeRegistry(registry: StoredRegistry): void {
    const dir = dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Some filesystems do not implement POSIX modes.
      }
      writeFileSync(tempPath, JSON.stringify(registry, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tempPath, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Some filesystems do not implement POSIX modes.
      }
    } catch (error) {
      throw new Error('Failed to persist named-session registry.', {
        cause: error,
      });
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best-effort temporary-file cleanup.
      }
    }
  }

  private isRegistry(value: unknown): value is StoredRegistry {
    if (!this.isRecord(value) || value['version'] !== REGISTRY_VERSION) {
      return false;
    }
    const owners = value['owners'];
    if (!Array.isArray(owners)) return false;
    const ownerKeys = new Set<string>();
    const sessionIds = new Set<string>();
    for (const owner of owners) {
      if (!this.isOwner(owner, ownerKeys, sessionIds)) return false;
    }
    return true;
  }

  private isOwner(
    value: unknown,
    ownerKeys: Set<string>,
    sessionIds: Set<string>,
  ): value is StoredOwner {
    if (!this.isRecord(value)) return false;
    const channelName = value['channelName'];
    const chatId = value['chatId'];
    const senderId = value['senderId'];
    const activeTaskName = value['activeTaskName'];
    const tasks = value['tasks'];
    if (
      channelName !== this.channelName ||
      typeof chatId !== 'string' ||
      typeof senderId !== 'string' ||
      (activeTaskName !== null && typeof activeTaskName !== 'string') ||
      !Array.isArray(tasks)
    ) {
      return false;
    }
    const ownerKey = JSON.stringify([channelName, chatId, senderId]);
    if (ownerKeys.has(ownerKey)) return false;
    ownerKeys.add(ownerKey);
    const names = new Set<string>();
    let openTasks = 0;
    let activeFound = activeTaskName === null;
    for (const task of tasks) {
      if (!this.isTask(task, channelName, chatId, senderId)) return false;
      const normalized = this.normalizeName(task.name);
      if (names.has(normalized) || sessionIds.has(task.sessionId)) return false;
      names.add(normalized);
      sessionIds.add(task.sessionId);
      if (task.status === 'open') openTasks++;
      if (
        activeTaskName !== null &&
        task.status === 'open' &&
        this.sameName(activeTaskName, task.name)
      ) {
        activeFound = true;
      }
    }
    return openTasks <= MAX_OPEN_TASKS && activeFound;
  }

  private isTask(
    value: unknown,
    channelName: string,
    chatId: string,
    senderId: string,
  ): value is StoredTask {
    if (!this.isRecord(value) || !this.isRecord(value['target'])) return false;
    const target = value['target'];
    return (
      typeof value['name'] === 'string' &&
      TASK_NAME_PATTERN.test(value['name']) &&
      typeof value['sessionId'] === 'string' &&
      value['sessionId'].length > 0 &&
      value['cwd'] === this.cwd &&
      value['isolation'] === 'shared' &&
      (value['status'] === 'open' || value['status'] === 'closed') &&
      this.isTimestamp(value['createdAt']) &&
      this.isTimestamp(value['updatedAt']) &&
      this.isTimestamp(value['lastSelectedAt']) &&
      target['channelName'] === channelName &&
      target['chatId'] === chatId &&
      target['senderId'] === senderId &&
      (target['threadId'] === undefined ||
        typeof target['threadId'] === 'string') &&
      (target['isGroup'] === undefined ||
        typeof target['isGroup'] === 'boolean')
    );
  }

  private isTimestamp(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
