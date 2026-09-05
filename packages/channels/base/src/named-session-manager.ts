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
import { dirname, isAbsolute } from 'node:path';
import process from 'node:process';
import { canonicalizeWorkspacePath } from './paths.js';
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
  isolation: NamedSessionIsolation;
  active: boolean;
}

export interface NamedSessionSelection extends NamedSessionView {
  sessionId: string;
}

export interface NamedSessionTaskReference {
  taskName: string;
  status: 'open' | 'closed';
  target: SessionTarget;
}

export interface NamedSessionManagerOptions {
  channelName: string;
  cwd: string;
  filePath: string;
  router: SessionRouter;
  isBusy(sessionId: string): boolean;
  now?: () => number;
}

export type NamedSessionIsolation = 'shared' | 'worktree';

interface StoredTask {
  name: string;
  sessionId: string;
  cwd: string;
  isolation: NamedSessionIsolation;
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
  workspaceCwd: string;
  owners: StoredOwner[];
}

export class NamedSessionManager {
  private readonly channelName: string;
  private readonly cwd: string;
  private readonly canonicalCwd: string;
  private readonly filePath: string;
  private readonly router: SessionRouter;
  private readonly isBusy: (sessionId: string) => boolean;
  private readonly now: () => number;
  private registry: StoredRegistry;
  private taskBySessionId: Map<string, NamedSessionTaskReference>;
  private readonly ownerOperations = new Map<string, Promise<void>>();

  constructor(options: NamedSessionManagerOptions) {
    this.channelName = options.channelName;
    this.cwd = options.cwd;
    this.canonicalCwd = canonicalizeWorkspacePath(options.cwd);
    this.filePath = options.filePath;
    this.router = options.router;
    this.isBusy = options.isBusy;
    this.now = options.now ?? Date.now;
    this.registry = this.readRegistry();
    this.taskBySessionId = this.buildTaskIndex(this.registry);
  }

  presentation(sessionId: string): NamedSessionTaskReference | undefined {
    const reference = this.taskBySessionId.get(sessionId);
    return reference ? this.cloneTaskReference(reference) : undefined;
  }

  async resolvePresentation(
    sessionId: string,
  ): Promise<NamedSessionTaskReference | undefined> {
    const existing = this.presentation(sessionId);
    if (existing) return existing;

    const target = this.router.getTarget(sessionId);
    if (
      target?.channelName !== this.channelName ||
      this.router.getSession(
        this.channelName,
        target.senderId,
        target.chatId,
      ) !== sessionId
    ) {
      return undefined;
    }

    return this.withOwnerLock(target, async () => {
      const concurrent = this.presentation(sessionId);
      if (concurrent) return concurrent;
      if (this.getOwner(target)) return undefined;

      const routedTarget = this.router.getTarget(sessionId);
      if (
        routedTarget?.channelName !== this.channelName ||
        routedTarget.chatId !== target.chatId ||
        routedTarget.senderId !== target.senderId ||
        this.router.getSession(
          this.channelName,
          target.senderId,
          target.chatId,
        ) !== sessionId
      ) {
        return undefined;
      }
      const routedCwd = this.router.getSessionCwd(sessionId);
      if (routedCwd !== undefined && !this.isCurrentCwd(routedCwd)) {
        return undefined;
      }

      const timestamp = this.nextTimestamp();
      const task: StoredTask = {
        name: 'default',
        sessionId,
        cwd: routedCwd ?? this.cwd,
        isolation: 'shared',
        status: 'open',
        target: routedTarget,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      this.commitOwner(this.createOwner(routedTarget, task.name, [task]));
      return this.presentation(sessionId);
    });
  }

  resolve(
    input: NamedSessionOwnerInput,
    reserve?: (sessionId: string) => () => void,
  ): Promise<string | undefined> {
    return this.withOwnerLock(input, () => this.resolveLocked(input, reserve));
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
          sessionId: await this.resolveLocked(input, reserve),
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

  lookup(
    input: NamedSessionOwnerInput,
    name: string,
  ): Promise<NamedSessionSelection | undefined> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner) return undefined;
      const task = this.findTask(owner, name);
      return task ? this.selection(owner, task) : undefined;
    });
  }

  /**
   * Reload a task a queued turn is already bound to. Resolves to the session
   * id the caller must dispatch on — the healed replacement when a superseded
   * redirect fired — or undefined when the task is no longer reservable.
   */
  resumeReserved(
    input: NamedSessionOwnerInput,
    sessionId: string,
  ): Promise<string | undefined> {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      const task = owner?.tasks.find(
        (candidate) =>
          candidate.sessionId === sessionId && candidate.status === 'open',
      );
      if (!task) return undefined;
      const result = await this.loadTask(
        task,
        `Could not reload reserved task "${task.name}".`,
      );
      return result.sessionId;
    });
  }

  create(
    input: NamedSessionOwnerInput,
    name: string,
    isolation: NamedSessionIsolation = 'shared',
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
      const timestamp = this.nextTimestamp(owner);

      const target = this.target(input);
      const sessionId = await this.createSession(
        target,
        isolation,
        `Could not create task "${name}".`,
      );
      const sessionCwd = this.router.getSessionCwd(sessionId);
      if (!sessionCwd) {
        await this.router
          .detachManagedSession(sessionId)
          .catch(() => undefined);
        throw new Error(`Could not determine task "${name}" workspace.`);
      }
      const task: StoredTask = {
        name,
        sessionId,
        cwd: sessionCwd,
        isolation,
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
      this.router.activateManagedSession(sessionId, target, task.cwd);
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
      if (
        task.status === 'closed' &&
        this.openTaskCount(owner) >= MAX_OPEN_TASKS
      ) {
        throw new Error(
          'You already have eight open tasks. Close one before reopening another.',
        );
      }
      const timestamp = this.nextTimestamp(owner);

      const loadResult = await this.loadTask(
        task,
        `Could not load task "${task.name}". The current task was not changed.`,
      );
      const updatedTask: StoredTask = {
        ...task,
        sessionId: loadResult.sessionId,
        status: 'open',
        updatedAt: timestamp,
        lastSelectedAt: timestamp,
      };
      const nextOwner = this.replaceTask(owner, updatedTask, task.name);
      try {
        this.commitOwner(nextOwner);
      } catch (error) {
        if (loadResult.loaded) {
          await this.router
            .detachManagedSession(loadResult.sessionId)
            .catch(() => undefined);
        }
        throw error;
      }
      this.router.activateManagedSession(
        loadResult.sessionId,
        updatedTask.target,
        updatedTask.cwd,
      );
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
      let replacementSessionId: string | undefined;
      if (replacement) {
        const replacementLoad = await this.loadTask(
          replacement,
          `Could not load fallback task "${replacement.name}". Task "${task.name}" was not closed.`,
        );
        replacementLoaded = replacementLoad.loaded;
        replacementSessionId = replacementLoad.sessionId;
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
            sessionId: replacementSessionId ?? replacement.sessionId,
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
            .detachManagedSession(replacementSessionId ?? replacement.sessionId)
            .catch(() => undefined);
        }
        throw error;
      }

      if (replacement) {
        this.router.activateManagedSession(
          replacementSessionId ?? replacement.sessionId,
          replacement.target,
          replacement.cwd,
        );
      }
      try {
        await this.router.detachManagedSession(task.sessionId);
      } catch (error) {
        // The fallback's load may have healed its own superseded redirect
        // mid-close; restoring the raw snapshot would undo that heal.
        const healedReplacement =
          replacement !== undefined &&
          replacementSessionId !== undefined &&
          replacementSessionId !== replacement.sessionId
            ? { ...replacement, sessionId: replacementSessionId }
            : undefined;
        this.commitOwner(
          healedReplacement
            ? this.replaceTask(owner, healedReplacement, owner.activeTaskName)
            : owner,
        );
        this.router.forgetManagedSession(task.sessionId);
        const restored = await this.loadTask(
          task,
          `Task "${task.name}" could not be restored after close failed.`,
        );
        if (wasActive) {
          this.router.activateManagedSession(
            restored.sessionId,
            task.target,
            task.cwd,
          );
        }
        throw new Error(`Failed to close task "${task.name}".`, {
          cause: error,
        });
      }
      const activeTask = nextOwner.activeTaskName
        ? this.findTask(nextOwner, nextOwner.activeTaskName)
        : undefined;
      return {
        closed: this.view(nextOwner, closedTask),
        ...(activeTask ? { active: this.view(nextOwner, activeTask) } : {}),
      };
    });
  }

  reset(input: NamedSessionOwnerInput): Promise<
    | {
        name: string;
        previousSessionId: string;
        sessionId: string;
        worktreeKept: boolean;
      }
    | undefined
  > {
    return this.withOwnerLock(input, async () => {
      const owner = await this.ensureOwner(input, false);
      if (!owner?.activeTaskName) return undefined;
      const task = this.findTask(owner, owner.activeTaskName);
      if (!task || task.status !== 'open') return undefined;
      const timestamp = this.nextTimestamp(owner);

      if (task.isolation === 'worktree') {
        // Worktree reset is an ownership transfer, not a new conversation:
        // the daemon moves the checkout to a fresh session and supersedes
        // this one. Busy tasks fail before any daemon call, and the daemon
        // resumes an interrupted transfer itself, so one attempt is enough.
        if (this.isBusy(task.sessionId)) {
          throw new Error(
            `Task "${task.name}" is busy. Wait for the running prompt to finish (or cancel it), then try again.`,
          );
        }
        const sessionId = await this.resetWorktreeSession(task);
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
          worktreeKept: true,
        };
      }

      const sessionId = await this.createSession(
        task.target,
        task.isolation,
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
        worktreeKept: false,
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
      const routedCwd = this.router.getSessionCwd(sessionId);
      if (routedCwd !== undefined && !this.isCurrentCwd(routedCwd)) {
        await this.router
          .detachManagedSession(sessionId)
          .catch(() => undefined);
      } else {
        const timestamp = this.nextTimestamp();
        const task: StoredTask = {
          name: 'default',
          sessionId,
          cwd: routedCwd ?? this.cwd,
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
    }
    if (!createDefault) return undefined;

    const target = this.target(input);
    const timestamp = this.nextTimestamp();
    const createdSessionId = await this.createSession(
      target,
      'shared',
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
    reserve?: (sessionId: string) => () => void,
  ): Promise<string | undefined> {
    const owner = await this.ensureOwner(input, true);
    if (!owner?.activeTaskName) return undefined;
    const task = this.findTask(owner, owner.activeTaskName);
    if (!task || task.status !== 'open') {
      throw new Error('The selected Channel task is unavailable.');
    }
    const release = reserve?.(task.sessionId);
    let activeRelease = release;
    try {
      const result = await this.loadTask(
        task,
        `Could not load task "${task.name}". No replacement session was created.`,
      );
      if (result.sessionId !== task.sessionId && reserve) {
        // The task moved to its replacement session; the reservation must
        // follow the id the caller will dispatch on.
        release?.();
        activeRelease = reserve(result.sessionId);
      }
      this.router.activateManagedSession(
        result.sessionId,
        task.target,
        task.cwd,
      );
      return result.sessionId;
    } catch (error) {
      activeRelease?.();
      throw error;
    }
  }

  private adoptForeignLegacyRoute(
    sessionId: string,
    target: SessionTarget,
  ): void {
    const cwd = this.router.getSessionCwd(sessionId);
    if (
      target.channelName !== this.channelName ||
      cwd === undefined ||
      !this.isCurrentCwd(cwd)
    ) {
      this.router.forgetManagedSession(sessionId);
      return;
    }
    const existing = this.getOwner(target);
    if (existing) {
      if (existing.tasks.some((task) => task.sessionId === sessionId)) return;
      this.router.forgetManagedSession(sessionId);
      return;
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

  private async loadTask(
    task: StoredTask,
    failureMessage: string,
  ): Promise<{ loaded: boolean; sessionId: string }> {
    try {
      const result = await this.router.loadManagedSession(
        task.sessionId,
        task.target,
        this.cwd,
        task.cwd,
        task.isolation,
      );
      if (
        result.redirectedFrom !== undefined &&
        result.sessionId !== task.sessionId
      ) {
        this.healSupersededTask(task, result.sessionId);
      }
      // Callers must use the returned id for everything after this point:
      // when a superseded redirect fired, the caller's `task` snapshot still
      // names the old session, and building registry updates from it would
      // overwrite the heal.
      return result;
    } catch (error) {
      throw new Error(failureMessage, { cause: error });
    }
  }

  /**
   * Point a task at its replacement session after a superseded redirect
   * healed the route. No-op when the registry entry already moved on (a
   * concurrent reset under the same owner lock cannot interleave, but a
   * stale in-memory snapshot could).
   */
  private healSupersededTask(task: StoredTask, sessionId: string): void {
    const owner = this.getOwner(task.target);
    if (!owner) return;
    const current = this.findTask(owner, task.name);
    if (!current || current.sessionId !== task.sessionId) return;
    const timestamp = this.nextTimestamp(owner);
    this.commitOwner(
      this.replaceTask(
        owner,
        { ...current, sessionId, updatedAt: timestamp },
        owner.activeTaskName,
      ),
    );
  }

  private async resetWorktreeSession(task: StoredTask): Promise<string> {
    try {
      return await this.router.replaceManagedWorktreeSession(
        task.sessionId,
        task.target,
        this.cwd,
        task.cwd,
      );
    } catch (error) {
      throw new Error(`Could not reset task "${task.name}".`, {
        cause: error,
      });
    }
  }

  private async createSession(
    target: SessionTarget,
    isolation: NamedSessionIsolation,
    failureMessage: string,
  ): Promise<string> {
    try {
      return await this.router.createManagedSession(
        target,
        this.cwd,
        isolation,
      );
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

  private cloneTaskReference(
    reference: NamedSessionTaskReference,
  ): NamedSessionTaskReference {
    return { ...reference, target: { ...reference.target } };
  }

  private buildTaskIndex(
    registry: StoredRegistry,
  ): Map<string, NamedSessionTaskReference> {
    const index = new Map<string, NamedSessionTaskReference>();
    for (const owner of registry.owners) {
      for (const task of owner.tasks) {
        index.set(task.sessionId, {
          taskName: task.name,
          status: task.status,
          target: { ...task.target },
        });
      }
    }
    return index;
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
    const next: StoredRegistry = {
      version: REGISTRY_VERSION,
      workspaceCwd: this.canonicalCwd,
      owners,
    };
    if (!this.isRegistry(next)) {
      throw new Error('Invalid named-session registry update.');
    }
    const nextTaskBySessionId = this.buildTaskIndex(next);
    this.writeRegistry(next);
    this.registry = next;
    this.taskBySessionId = nextTaskBySessionId;
  }

  private readRegistry(): StoredRegistry {
    if (!existsSync(this.filePath)) {
      return {
        version: REGISTRY_VERSION,
        workspaceCwd: this.canonicalCwd,
        owners: [],
      };
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
      if (this.isRegistry(value, true, true)) {
        return { ...value, workspaceCwd: this.canonicalCwd };
      }
      if (
        this.isRegistry(value, false) ||
        this.isRegistry(value, false, true)
      ) {
        const stalePath = `${this.filePath}.stale-${randomUUID()}`;
        try {
          renameSync(this.filePath, stalePath);
        } catch (error) {
          throw new Error('Failed to archive stale named-session registry.', {
            cause: error,
          });
        }
        process.stderr.write(
          '[NamedSessionManager] Archived a stale registry after the channel working directory changed.\n',
        );
        return {
          version: REGISTRY_VERSION,
          workspaceCwd: this.canonicalCwd,
          owners: [],
        };
      }
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

  private isRegistry(
    value: unknown,
    requireCurrentCwd = true,
    allowMissingWorkspaceCwd = false,
  ): value is StoredRegistry {
    if (!this.isRecord(value) || value['version'] !== REGISTRY_VERSION) {
      return false;
    }
    const workspaceCwd = value['workspaceCwd'];
    if (
      workspaceCwd === undefined
        ? !allowMissingWorkspaceCwd
        : typeof workspaceCwd !== 'string' ||
          (requireCurrentCwd &&
            canonicalizeWorkspacePath(workspaceCwd) !== this.canonicalCwd)
    ) {
      return false;
    }
    const owners = value['owners'];
    if (!Array.isArray(owners)) return false;
    const ownerKeys = new Set<string>();
    const sessionIds = new Set<string>();
    for (const owner of owners) {
      if (!this.isOwner(owner, ownerKeys, sessionIds, requireCurrentCwd)) {
        return false;
      }
    }
    if (
      workspaceCwd === undefined &&
      owners.some(
        (owner) =>
          this.isRecord(owner) &&
          Array.isArray(owner['tasks']) &&
          owner['tasks'].some(
            (task) => this.isRecord(task) && task['isolation'] === 'worktree',
          ),
      )
    ) {
      return false;
    }
    return true;
  }

  private isOwner(
    value: unknown,
    ownerKeys: Set<string>,
    sessionIds: Set<string>,
    requireCurrentCwd: boolean,
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
      if (
        !this.isTask(task, channelName, chatId, senderId, requireCurrentCwd)
      ) {
        return false;
      }
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
    requireCurrentCwd: boolean,
  ): value is StoredTask {
    if (!this.isRecord(value) || !this.isRecord(value['target'])) return false;
    const target = value['target'];
    return (
      typeof value['name'] === 'string' &&
      TASK_NAME_PATTERN.test(value['name']) &&
      typeof value['sessionId'] === 'string' &&
      value['sessionId'].length > 0 &&
      typeof value['cwd'] === 'string' &&
      isAbsolute(value['cwd']) &&
      (value['isolation'] === 'shared' || value['isolation'] === 'worktree') &&
      (!requireCurrentCwd ||
        (value['isolation'] === 'shared'
          ? this.isCurrentCwd(value['cwd'])
          : !this.isCurrentCwd(value['cwd']))) &&
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

  private isCurrentCwd(cwd: string): boolean {
    return canonicalizeWorkspacePath(cwd) === this.canonicalCwd;
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
