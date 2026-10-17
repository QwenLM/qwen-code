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
 * (`<globalQwenDir>/projects/<encoded>/chats/<sessionId>.runtime.json`,
 * field `work_dir`) as the fallback for sessions that are no longer live.
 * Sessions with no resolvable project group under `(unmapped project)`.
 *
 * Due dates live in a sidecar overlay (`todos/due-dates.json`, keyed
 * `sessionId:todoId` → `YYYY-MM-DD`) rather than inside the native todo
 * files: `todo_write` rewrites its whole file from the agent's list, so any
 * extra field stored there would be silently dropped on the next write.
 * The overlay is merged into the aggregate and never touches native files.
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
}

interface TodoPlanFile {
  planId?: string;
  todos: TodoItem[];
  sessionId?: string;
}

export interface RegisterTodosRoutesDeps {
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
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

function getTodoDir(): string {
  return path.join(Storage.getRuntimeBaseDir(), 'todos');
}

function getDueDatesPath(): string {
  return path.join(getTodoDir(), DUE_DATES_FILENAME);
}

async function readDueDates(): Promise<Record<string, string>> {
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
  } catch {
    return {};
  }
}

async function writeDueDates(map: Record<string, string>): Promise<void> {
  await fs.mkdir(getTodoDir(), { recursive: true });
  await fs.writeFile(getDueDatesPath(), JSON.stringify(map, null, 2), 'utf-8');
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

  const chatsRoot = path.join(Storage.getGlobalQwenDir(), 'projects');
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
  const { mutate, safeBody } = deps;

  app.get('/todos', async (req, res) => {
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
      const sessions: TodoSessionView[] = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name === DUE_DATES_FILENAME) continue;
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
        sessions.push({
          sessionId,
          cwd: null,
          mtimeMs,
          todos: [...plan.todos]
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map((todo) => ({
              ...todo,
              dueDate: dueDates[`${sessionId}:${todo.id}`] ?? null,
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
    if (status === undefined && !hasDueDate) {
      res.status(400).json({
        error: 'nothing to update: provide status and/or dueDate',
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

    void (async () => {
      const todoDir = getTodoDir();
      const filePath = path.join(todoDir, `${sessionId}.json`);
      try {
        let before: string | null = null;
        if (status !== undefined) {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content) as Record<string, unknown>;
          if (!data || !Array.isArray(data['todos'])) {
            throw Object.assign(
              new Error(`not a todo store file: ${filePath}`),
              { code: 'todos_not_found' },
            );
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
          before = typeof todo['status'] === 'string' ? todo['status'] : null;
          todo['status'] = status;
          await fs.mkdir(todoDir, { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        }

        let appliedDueDate: string | null = null;
        if (hasDueDate) {
          const map = await readDueDates();
          const key = `${sessionId}:${todoId}`;
          if (dueDate === null) {
            delete map[key];
          } else {
            map[key] = dueDate;
          }
          await writeDueDates(map);
          appliedDueDate = dueDate === null ? null : (dueDate as string);
        }

        res.status(200).json({
          v: 2,
          ok: true,
          sessionId,
          todoId,
          before,
          after: status ?? undefined,
          dueDate: appliedDueDate,
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
    })();
  });
}
