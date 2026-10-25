/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const mockState = vi.hoisted(() => ({
  runtimeBaseDir: '',
}));

vi.mock('@qwen-code/qwen-code-core/config/storage.js', () => ({
  Storage: {
    getRuntimeBaseDir: () => mockState.runtimeBaseDir,
    getGlobalQwenDir: () => mockState.runtimeBaseDir,
  },
}));

vi.mock('@qwen-code/qwen-code-core/services/session-registry.js', () => ({
  listLiveSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

import { registerTodosRoutes } from './todos.js';

function createMockApp() {
  const routes: Record<
    string,
    { handler: (req: unknown, res: unknown) => unknown }
  > = {};
  return {
    get: vi.fn(
      (p: string, handler: (req: unknown, res: unknown) => unknown) => {
        routes[`GET ${p}`] = { handler };
      },
    ),
    post: vi.fn((p: string, ...mw: unknown[]) => {
      routes[`POST ${p}`] = {
        handler: mw[mw.length - 1] as (req: unknown, res: unknown) => unknown,
      };
    }),
    routes,
  };
}

function createMockRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((data: unknown) => {
      res.body = data;
      return res;
    }),
  };
  return res;
}

describe('registerTodosRoutes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createMockApp>;
  let res: ReturnType<typeof createMockRes>;
  const isWorkspaceTrusted = vi.fn(() => true);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-test-'));
    mockState.runtimeBaseDir = tmpDir;
    app = createMockApp();
    res = createMockRes();
    isWorkspaceTrusted.mockReturnValue(true);
    registerTodosRoutes(app as never, {
      mutate: vi.fn(
        () => (_req: unknown, _res: unknown, next: () => void) => next(),
      ) as never,
      safeBody: vi.fn(
        (req: { body?: Record<string, unknown> }) => req.body ?? {},
      ) as never,
      isWorkspaceTrusted,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /todos', () => {
    it('returns an empty aggregate when no todo files exist', async () => {
      const route = app.routes['GET /todos'];
      expect(route).toBeDefined();
      await route.handler({ query: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        v: 2,
        totals: { projects: 0, sessions: 0, open: 0 },
        groups: [],
      });
    });

    it('returns 403 when workspace is untrusted', async () => {
      isWorkspaceTrusted.mockReturnValue(false);
      const route = app.routes['GET /todos'];
      await route.handler({ query: {} }, res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'workspace_untrusted' });
    });

    it('aggregates todos from the store', async () => {
      const todoDir = path.join(tmpDir, 'todos');
      fs.mkdirSync(todoDir, { recursive: true });
      fs.writeFileSync(
        path.join(todoDir, 'session-abc.json'),
        JSON.stringify({
          todos: [
            { id: '1', content: 'Task one', status: 'pending' },
            { id: '2', content: 'Task two', status: 'completed' },
          ],
          sessionId: 'session-abc',
        }),
      );
      const route = app.routes['GET /todos'];
      await route.handler({ query: {} }, res);
      expect(res.statusCode).toBe(200);
      const body = res.body as {
        totals: { pending: number; completed: number; sessions: number };
      };
      expect(body.totals.pending).toBe(1);
      expect(body.totals.completed).toBe(1);
      expect(body.totals.sessions).toBe(1);
    });
  });

  describe('POST /todos/update', () => {
    it('returns 400 for a path-traversal sessionId', async () => {
      const route = app.routes['POST /todos/update'];
      const mockReq = {
        body: { sessionId: '../../outside', todoId: '1', status: 'completed' },
      };
      (route as { handler: (req: unknown, res: unknown) => unknown }).handler(
        mockReq,
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'todos_bad_session_id' });
    });

    it('returns 400 for an invalid status', async () => {
      const route = app.routes['POST /todos/update'];
      const mockReq = {
        body: { sessionId: 'session-abc', todoId: '1', status: 'cancelled' },
      };
      await route.handler(mockReq, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'todos_bad_status' });
    });

    it('returns 403 when workspace is untrusted', async () => {
      isWorkspaceTrusted.mockReturnValue(false);
      const route = app.routes['POST /todos/update'];
      const mockReq = {
        body: { sessionId: 'session-abc', todoId: '1', status: 'completed' },
      };
      await route.handler(mockReq, res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'workspace_untrusted' });
    });

    it('flips a todo status and preserves sibling fields', async () => {
      const todoDir = path.join(tmpDir, 'todos');
      fs.mkdirSync(todoDir, { recursive: true });
      const filePath = path.join(todoDir, 'session-abc.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          planId: 'plan-1',
          todos: [{ id: '1', content: 'Task', status: 'pending' }],
          sessionId: 'session-abc',
        }),
      );
      const route = app.routes['POST /todos/update'];
      const mockReq = {
        body: { sessionId: 'session-abc', todoId: '1', status: 'completed' },
      };
      await route.handler(mockReq, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        before: 'pending',
        after: 'completed',
      });
      const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(written.todos[0].status).toBe('completed');
      expect(written.planId).toBe('plan-1');
    });

    it('sets a due date in the overlay with planId scoping', async () => {
      const todoDir = path.join(tmpDir, 'todos');
      fs.mkdirSync(todoDir, { recursive: true });
      fs.writeFileSync(
        path.join(todoDir, 'session-abc.json'),
        JSON.stringify({
          planId: 'plan-1',
          todos: [{ id: '1', content: 'Task', status: 'pending' }],
          sessionId: 'session-abc',
        }),
      );
      const route = app.routes['POST /todos/update'];
      const mockReq = {
        body: { sessionId: 'session-abc', todoId: '1', dueDate: '2026-12-25' },
      };
      await route.handler(mockReq, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ dueDate: '2026-12-25' });
      const overlay = JSON.parse(
        fs.readFileSync(path.join(todoDir, 'due-dates.json'), 'utf-8'),
      );
      expect(overlay['session-abc:plan-1:1']).toBe('2026-12-25');
    });
  });
});
