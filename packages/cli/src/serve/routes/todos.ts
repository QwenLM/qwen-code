/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-session todo aggregation — the daemon-side surface behind the Web
 * Shell "Todos" page.
 *
 * The native todo store is one JSON file per session under
 * `<runtimeBaseDir>/todos/<sessionId>.json`, written by the `todo_write`
 * tool. Each file is self-contained, but todos are invisible once their
 * session ends: this route aggregates every file, attributes each session
 * to its project working directory, and offers a minimal update path that
 * flips exactly one todo status.
 *
 * Project attribution: the live session registry (`sessionId` → `cwd`)
 * first, then the per-project chat runtime records
 * (`<runtimeBaseDir>/projects/<encoded>/chats/<sessionId>.runtime.json`,
 * field `work_dir`) as the fallback for sessions that are no longer live.
 * Sessions with no resolvable project group under `(unmapped project)`.
 *
 * Due dates live in a sidecar overlay (`todos/due-dates.json`, keyed
 * `sessionId:planId:todoId` → `YYYY-MM-DD`) rather than inside the native
 * todo files: `todo_write` rewrites its whole file from the agent's list, so
 * any extra field stored there would be silently dropped on the next write.
 * The overlay key includes the `planId` because `todo_write` reuses simple
 * IDs (like `1`) when a completed plan is replaced — without planId scoping,
 * a deadline set on the old plan's `1` would leak into the new plan's `1`.
 * The overlay is merged into the aggregate and never touches native files.
 * Overlay writes are serialized so concurrent updates cannot silently
 * overwrite each other.
 *
 * Reads never mutate anything. The write path uses the non-strict
 * `mutate()` gate — flipping one status is the same capability class as
 * other durable user-state writes (scheduled-task edits).
 */

import type { Application, Request, RequestHandler } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { listLiveSessions } from '@qwen-code/qwen-code-core/services/session-registry.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  blockedBy?: string[];
  dueDate?: string | null;
  tags?: string[];
}

interface TodoTagOverlay {
  definitions: Record<string, { color: string }>;
  assignments: Record<string, string[]>;
}

interface TodoPlanFile {
  planId?: string;
  todos: TodoItem[];
  sessionId?: string;
}

export interface RegisterTodosRoutesDeps {
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  /** When provided and false, both routes refuse (untrusted workspace). */
  isWorkspaceTrusted?: () => boolean;
}

/** One session's todos, as shown on the Todos page. */
interface TodoSessionView {
  sessionId: string;
  cwd: string | null;
  mtimeMs: number;
  todos: TodoItem[];
}

/** Todos grouped by project working directory. */
interface TodoGroupView {
  project: string;
  open: number;
  done: number;
  sessions: TodoSessionView[];
}

const TODO_STATUSES: readonly TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
];

/** Sessions whose chat records live outside any known project. */
const UNMAPPED_PROJECT = '(unmapped project)';

/** Sidecar overlay for due dates; see the file header for why it is separate. */
const DUE_DATES_FILENAME = 'due-dates.json';
const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Sidecar overlay for tags; same rationale as due dates — todo_write wipes extras. */
const TAGS_FILENAME = 'todo-tags.json';
const TAG_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TAG_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,24}$/;

/**
 * Session IDs are UUIDs or `default` — alphanumeric with hyphens. Rejecting
 * anything else prevents path-traversal via crafted IDs like `../outside`
 * reaching `<runtimeBaseDir>/outside.json`.
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function getTodoDir(): string {
  return path.join(Storage.getRuntimeBaseDir(), 'todos');
}

function getDueDatesPath(): string {
  return path.join(getTodoDir(), DUE_DATES_FILENAME);
}

/**
 * Serializes ALL write operations on the native todo files and the due-date
 * overlay. The previous `withOverlayLock` only covered the overlay; the
 * native-file status flip ran unlocked, so a concurrent status flip and a
 * due-date edit could interleave: both read the same snapshot, each applied
 * its own edit, and the second write silently discarded the first. The lock
 * covers the entire read-modify-write cycle — file read, status flip, overlay
 * update, and both writes. The chain swallows rejections so one failed write
 * does not wedge the queue for subsequent requests.
 */
let todoWriteChain: Promise<void> = Promise.resolve();

function withTodoWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = todoWriteChain.then(fn, fn);
  todoWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Atomic file write: writes to a sibling temp file then renames over the
 * target, so a crash mid-write never leaves a truncated JSON file (which
 * `todo_write` would then drop on its next read, silently losing the list).
 */
async function atomicWriteJson(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data, 'utf-8');
  await fs.rename(tmp, filePath);
}

function isMissingFileError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads the due-date overlay. ENOENT is the legitimate first-run case and
 * always yields an empty map. Any other failure (corrupt JSON, EACCES, …)
 * must NOT silently degrade to `{}` on the write path: the POST handler's
 * read-modify-write would then persist that `{}` and destroy the overlay.
 * `strict: true` rethrows so the POST handler fails the request before any
 * write happens; the non-strict GET path logs and serves the page without
 * due dates.
 */
async function readDueDates(opts?: {
  strict?: boolean;
}): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(
      await fs.readFile(getDueDatesPath(), 'utf-8'),
    ) as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string' && DUE_DATE_PATTERN.test(value)) {
        map[key] = value;
      }
    }
    return map;
  } catch (err) {
    if (isMissingFileError(err)) return {};
    if (opts?.strict) throw err;
    writeStderrLine(
      `qwen serve: reading ${DUE_DATES_FILENAME} failed (${describeError(err)}); serving without due dates`,
    );
    return {};
  }
}

async function writeDueDates(map: Record<string, string>): Promise<void> {
  await fs.mkdir(getTodoDir(), { recursive: true });
  await atomicWriteJson(getDueDatesPath(), JSON.stringify(map, null, 2));
}

function getTagsPath(): string {
  return path.join(getTodoDir(), TAGS_FILENAME);
}

/**
 * Reads the tag overlay. Same contract as `readDueDates`: ENOENT is the
 * legitimate first-run case; `strict: true` rethrows every other failure so
 * the POST handler's read-modify-write can never persist an empty overlay
 * over a file it could not read.
 */
async function readTodoTags(opts?: {
  strict?: boolean;
}): Promise<TodoTagOverlay> {
  try {
    const raw = JSON.parse(await fs.readFile(getTagsPath(), 'utf-8')) as Record<
      string,
      unknown
    >;
    const overlay: TodoTagOverlay = { definitions: {}, assignments: {} };
    const defs = raw['definitions'] as Record<string, unknown> | undefined;
    if (defs && typeof defs === 'object') {
      for (const [name, val] of Object.entries(defs)) {
        if (
          TAG_NAME_PATTERN.test(name) &&
          val &&
          typeof val === 'object' &&
          typeof (val as Record<string, unknown>)['color'] === 'string' &&
          TAG_COLOR_PATTERN.test(
            (val as Record<string, unknown>)['color'] as string,
          )
        ) {
          overlay.definitions[name] = {
            color: (val as Record<string, unknown>)['color'] as string,
          };
        }
      }
    }
    const assigns = raw['assignments'] as Record<string, unknown> | undefined;
    if (assigns && typeof assigns === 'object') {
      for (const [key, val] of Object.entries(assigns)) {
        if (Array.isArray(val)) {
          overlay.assignments[key] = val.filter(
            (t): t is string =>
              typeof t === 'string' && TAG_NAME_PATTERN.test(t),
          );
        }
      }
    }
    return overlay;
  } catch (err) {
    if (isMissingFileError(err)) return { definitions: {}, assignments: {} };
    if (opts?.strict) throw err;
    writeStderrLine(
      `qwen serve: reading ${TAGS_FILENAME} failed (${describeError(err)}); serving without tags`,
    );
    return { definitions: {}, assignments: {} };
  }
}

async function writeTodoTags(overlay: TodoTagOverlay): Promise<void> {
  await fs.mkdir(getTodoDir(), { recursive: true });
  await atomicWriteJson(getTagsPath(), JSON.stringify(overlay, null, 2));
}

async function readTodoPlan(
  todoDir: string,
  sessionId: string,
): Promise<TodoPlanFile | null> {
  try {
    const content = await fs.readFile(
      path.join(todoDir, `${sessionId}.json`),
      'utf-8',
    );
    const data = JSON.parse(content) as Record<string, unknown>;
    if (!data || !Array.isArray(data['todos'])) return null;
    const todos = data['todos'] as TodoItem[];
    return {
      ...(typeof data['planId'] === 'string' ? { planId: data['planId'] } : {}),
      todos: todos.filter(
        (todo) =>
          todo &&
          typeof todo['id'] === 'string' &&
          typeof todo['content'] === 'string' &&
          TODO_STATUSES.includes(todo['status']),
      ),
      ...(typeof data['sessionId'] === 'string'
        ? { sessionId: data['sessionId'] }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves `sessionId → project cwd` for the given ids. Live registry
 * records win; for the rest the per-project chat runtime record is read
 * (`work_dir`). Unresolvable ids are simply absent from the map.
 *
 * The scan uses the same `getRuntimeBaseDir()` root the todo files live
 * under, so a custom `QWEN_RUNTIME_DIR` relocates both halves together
 * instead of reading todos from one root and chat records from another.
 */
async function resolveSessionCwds(
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const cwds = new Map<string, string>();
  const missing = new Set(sessionIds);
  try {
    for (const record of await listLiveSessions()) {
      if (record.cwd && missing.delete(record.sessionId)) {
        cwds.set(record.sessionId, record.cwd);
      }
    }
  } catch (err) {
    writeStderrLine(
      `qwen serve: GET /todos could not read the session registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (missing.size === 0) return cwds;

  const chatsRoot = path.join(Storage.getRuntimeBaseDir(), 'projects');
  let projects: string[] = [];
  try {
    projects = await fs.readdir(chatsRoot);
  } catch {
    return cwds;
  }
  for (const project of projects) {
    if (missing.size === 0) break;
    for (const sessionId of [...missing]) {
      const runtimePath = path.join(
        chatsRoot,
        project,
        'chats',
        `${sessionId}.runtime.json`,
      );
      try {
        const raw = JSON.parse(
          await fs.readFile(runtimePath, 'utf-8'),
        ) as Record<string, unknown>;
        if (typeof raw['work_dir'] === 'string' && raw['work_dir']) {
          cwds.set(sessionId, raw['work_dir']);
          missing.delete(sessionId);
        }
      } catch {
        // No runtime record for this session under this project.
      }
    }
  }
  return cwds;
}

export function registerTodosRoutes(
  app: Application,
  deps: RegisterTodosRoutesDeps,
): void {
  const { mutate, safeBody, isWorkspaceTrusted } = deps;

  app.get('/todos', async (req, res) => {
    if (isWorkspaceTrusted?.() === false) {
      res.status(403).json({
        error: 'Workspace is not trusted',
        code: 'workspace_untrusted',
      });
      return;
    }
    try {
      const includeAll = req.query['all'] === '1';
      const todoDir = getTodoDir();
      let names: string[] = [];
      try {
        names = await fs.readdir(todoDir);
      } catch {
        res.status(200).json({
          v: 2,
          generatedAt: Date.now(),
          totals: {
            projects: 0,
            sessions: 0,
            open: 0,
            pending: 0,
            in_progress: 0,
            completed: 0,
          },
          groups: [],
        });
        return;
      }

      const dueDates = await readDueDates();
      const tagOverlay = await readTodoTags();
      const sessions: TodoSessionView[] = [];
      for (const name of names) {
        if (
          !name.endsWith('.json') ||
          name === DUE_DATES_FILENAME ||
          name === TAGS_FILENAME
        )
          continue;
        const fileSessionId = name.slice(0, -'.json'.length);
        let mtimeMs = 0;
        try {
          mtimeMs = (await fs.stat(path.join(todoDir, name))).mtimeMs;
        } catch {
          continue;
        }
        const plan = await readTodoPlan(todoDir, fileSessionId);
        if (!plan || plan.todos.length === 0) continue;
        const sessionId = plan.sessionId ?? fileSessionId;
        const overlayPrefix = `${sessionId}:${plan.planId ?? ''}:`;
        sessions.push({
          sessionId,
          cwd: null,
          mtimeMs,
          todos: [...plan.todos]
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map((todo) => ({
              ...todo,
              dueDate: dueDates[`${overlayPrefix}${todo.id}`] ?? null,
              tags: tagOverlay.assignments[`${overlayPrefix}${todo.id}`] ?? [],
            })),
        });
      }

      const cwds = await resolveSessionCwds(sessions.map((s) => s.sessionId));
      const byProject = new Map<string, TodoSessionView[]>();
      for (const session of sessions) {
        session.cwd = cwds.get(session.sessionId) ?? null;
        const project = session.cwd ?? UNMAPPED_PROJECT;
        const list = byProject.get(project) ?? [];
        list.push(session);
        byProject.set(project, list);
      }

      const totals = {
        projects: 0,
        sessions: 0,
        open: 0,
        pending: 0,
        in_progress: 0,
        completed: 0,
      };
      const groups: TodoGroupView[] = [];
      for (const [project, list] of byProject) {
        const visible = includeAll
          ? list
          : list.filter((s) => s.todos.some((t) => t.status !== 'completed'));
        if (visible.length === 0) continue;
        visible.sort((a, b) => b.mtimeMs - a.mtimeMs);
        let open = 0;
        let done = 0;
        for (const session of visible) {
          for (const todo of session.todos) {
            if (!TODO_STATUSES.includes(todo.status)) continue;
            if (todo.status === 'completed') {
              done += 1;
              totals.completed += 1;
            } else {
              open += 1;
              totals.open += 1;
              totals[todo.status] += 1;
            }
          }
        }
        totals.projects += 1;
        totals.sessions += visible.length;
        groups.push({ project, open, done, sessions: visible });
      }
      // Most recently active project first.
      groups.sort(
        (a, b) =>
          Math.max(...b.sessions.map((s) => s.mtimeMs)) -
          Math.max(...a.sessions.map((s) => s.mtimeMs)),
      );

      res.status(200).json({
        v: 2,
        generatedAt: Date.now(),
        totals,
        groups,
        tagDefinitions: tagOverlay.definitions,
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /todos failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to aggregate todos',
        code: 'todos_read_failed',
      });
    }
  });

  app.post('/todos/update', mutate(), (req, res) => {
    if (isWorkspaceTrusted?.() === false) {
      res.status(403).json({
        error: 'Workspace is not trusted',
        code: 'workspace_untrusted',
      });
      return;
    }
    const body = safeBody(req);
    const sessionId = body['sessionId'];
    const todoId = body['todoId'];
    const status = body['status'];
    const hasDueDate = Object.prototype.hasOwnProperty.call(body, 'dueDate');
    const dueDate = body['dueDate'];
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof todoId !== 'string' ||
      !todoId
    ) {
      res.status(400).json({
        error: 'sessionId and todoId are required',
        code: 'todos_bad_request',
      });
      return;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      res.status(400).json({
        error: 'sessionId must be alphanumeric with hyphens/underscores only',
        code: 'todos_bad_session_id',
      });
      return;
    }
    if (
      status === undefined &&
      !hasDueDate &&
      !Object.prototype.hasOwnProperty.call(body, 'tags')
    ) {
      res.status(400).json({
        error: 'nothing to update: provide status, dueDate, and/or tags',
        code: 'todos_bad_request',
      });
      return;
    }
    if (
      status !== undefined &&
      (typeof status !== 'string' ||
        !TODO_STATUSES.includes(status as TodoStatus))
    ) {
      res.status(400).json({
        error: `status must be one of: ${TODO_STATUSES.join(' | ')}`,
        code: 'todos_bad_status',
      });
      return;
    }
    if (
      hasDueDate &&
      dueDate !== null &&
      (typeof dueDate !== 'string' || !DUE_DATE_PATTERN.test(dueDate))
    ) {
      res.status(400).json({
        error: 'dueDate must be YYYY-MM-DD or null',
        code: 'todos_bad_due_date',
      });
      return;
    }
    const hasTags = Object.prototype.hasOwnProperty.call(body, 'tags');
    const rawTags = body['tags'];
    if (hasTags) {
      if (!Array.isArray(rawTags)) {
        res.status(400).json({
          error: 'tags must be an array of tag names',
          code: 'todos_bad_tags',
        });
        return;
      }
      for (const tag of rawTags) {
        if (typeof tag !== 'string' || !TAG_NAME_PATTERN.test(tag)) {
          res.status(400).json({
            error: `invalid tag name "${tag}": must be 1-24 chars, alphanumeric/hyphen/underscore`,
            code: 'todos_bad_tag_name',
          });
          return;
        }
      }
    }
    const tagDefinition = body['tagDefinition'] as
      | { name?: unknown; color?: unknown }
      | undefined;
    if (tagDefinition !== undefined) {
      if (
        typeof tagDefinition.name !== 'string' ||
        !TAG_NAME_PATTERN.test(tagDefinition.name) ||
        typeof tagDefinition.color !== 'string' ||
        !TAG_COLOR_PATTERN.test(tagDefinition.color)
      ) {
        res.status(400).json({
          error: 'tagDefinition must be {name: string, color: #rrggbb}',
          code: 'todos_bad_tag_definition',
        });
        return;
      }
    }
    const validatedTags: string[] | undefined = hasTags
      ? (rawTags as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    // Narrow validated body fields to their runtime types — the `unknown`
    // from safeBody does not flow into the async closure below.
    const validatedStatus =
      status !== undefined && typeof status === 'string'
        ? (status as TodoStatus)
        : undefined;
    const validatedDueDate: string | null | undefined = hasDueDate
      ? dueDate === null
        ? null
        : String(dueDate)
      : undefined;

    return withTodoWriteLock(async () => {
      const todoDir = getTodoDir();
      const filePath = path.join(todoDir, `${sessionId}.json`);
      try {
        // Read the plan file inside the lock: the overlay key needs the
        // planId, the todo must exist before either edit is applied, and
        // a concurrent writer may have changed the file since the lock
        // was acquired — so the read must happen under the same lock that
        // guards the write.
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content) as Record<string, unknown>;
        if (!data || !Array.isArray(data['todos'])) {
          throw Object.assign(new Error(`not a todo store file: ${filePath}`), {
            code: 'todos_not_found',
          });
        }
        const todos = data['todos'] as Array<Record<string, unknown>>;
        const todo = todos.find((t) => String(t['id']) === todoId);
        if (!todo) {
          res.status(404).json({
            error: `todo ${todoId} not found in session ${sessionId}`,
            code: 'todos_not_found',
          });
          return;
        }
        const planId = typeof data['planId'] === 'string' ? data['planId'] : '';

        // Read both overlays strictly BEFORE any write: a corrupt or
        // unreadable overlay must fail the whole request with nothing
        // persisted. The status flip used to be committed first, so a
        // request carrying status + dueDate (or tags) answered 500 with
        // the flip already on disk. The reads stay inside the lock —
        // hoisting them above it would reopen the lost-update window the
        // lock exists to close.
        const dueDateMap =
          validatedDueDate === undefined
            ? undefined
            : await readDueDates({ strict: true });
        const tagOverlay =
          validatedTags === undefined && tagDefinition === undefined
            ? undefined
            : await readTodoTags({ strict: true });

        let before: string | null = null;
        if (validatedStatus !== undefined) {
          before = typeof todo['status'] === 'string' ? todo['status'] : null;
          todo['status'] = validatedStatus;
          await fs.mkdir(todoDir, { recursive: true });
          await atomicWriteJson(filePath, JSON.stringify(data, null, 2));
        }

        // The overlay writes run under the same lock as the native file
        // write — no inner lock needed, the outer withTodoWriteLock already
        // serializes the entire read-modify-write cycle.
        let appliedDueDate: string | null = null;
        if (validatedDueDate !== undefined && dueDateMap !== undefined) {
          const key = `${sessionId}:${planId}:${todoId}`;
          if (validatedDueDate === null) {
            delete dueDateMap[key];
          } else {
            dueDateMap[key] = validatedDueDate;
          }
          await writeDueDates(dueDateMap);
          appliedDueDate = validatedDueDate;
        }

        // Tag assignment update — same lock, same overlay pattern as due dates.
        let appliedTags: string[] | undefined;
        if (tagOverlay !== undefined) {
          if (
            tagDefinition !== undefined &&
            typeof tagDefinition.name === 'string' &&
            typeof tagDefinition.color === 'string'
          ) {
            tagOverlay.definitions[tagDefinition.name] = {
              color: tagDefinition.color,
            };
          }
          if (validatedTags !== undefined) {
            const tagKey = `${sessionId}:${planId}:${todoId}`;
            if (validatedTags.length === 0) {
              delete tagOverlay.assignments[tagKey];
            } else {
              tagOverlay.assignments[tagKey] = validatedTags;
            }
            appliedTags = validatedTags;
          }
          await writeTodoTags(tagOverlay);
        }

        res.status(200).json({
          v: 2,
          ok: true,
          sessionId,
          todoId,
          before,
          after: validatedStatus ?? undefined,
          dueDate: appliedDueDate,
          tags: appliedTags,
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /todos/update failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res
          .status(
            (err as { code?: string }).code === 'todos_not_found' ? 404 : 500,
          )
          .json({
            error: 'Failed to update todo',
            code: (err as { code?: string }).code ?? 'todos_update_failed',
          });
      }
    });
  });
}
