/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedHarnessSessionRoutes } from './hosted-harness-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

const POST_PR_COMMENT_ACTION = {
  name: 'post_pr_comment',
  description: 'Post a pull request comment on the task bound to this turn.',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', minLength: 1, maxLength: 4000 },
    },
    required: ['body'],
    additionalProperties: false,
  },
} as const;

function promptDigest(prompt: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
}

describe('turn-scoped host actions on external Files sessions', () => {
  useHostedTextSession();

  it('executes worker file writes alongside turn-scoped host actions and replays interrupted responses idempotently', async () => {
    const hostExecutions: Array<{
      sessionId: string;
      body: Record<string, unknown>;
    }> = [];
    const receipts = new Map<
      string,
      {
        argsDigest: string;
        response: Record<string, unknown>;
      }
    >();
    let dropFirstResponse = true;

    const brokerServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const match =
          /^\/internal\/runtime-broker\/v1\/harness-sessions\/([^/]+)\/host-actions\/execute$/.exec(
            req.url ?? '',
          );
        if (!match || req.method !== 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found', message: 'not found' }));
          return;
        }
        if (req.headers.authorization !== 'Bearer broker-secret') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ code: 'unauthorized', message: 'unauthorized' }),
          );
          return;
        }
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const key = `${parsed['promptId']}:${parsed['callId']}`;
        let stored = receipts.get(key);
        let replayed = true;
        if (!stored) {
          replayed = false;
          hostExecutions.push({ sessionId: match[1], body: parsed });
          stored = {
            argsDigest: String(parsed['argsDigest']),
            response: {
              turnId: 'turn-18578',
              promptId: parsed['promptId'],
              callId: parsed['callId'],
              actionName: parsed['actionName'],
              isError: false,
              text: 'Posted comment ic-9001',
              output: {
                commentId: 'ic-9001',
                url: 'https://github.example/org/repo/pull/42#issuecomment-9001',
              },
            },
          };
          receipts.set(key, stored);
        } else if (stored.argsDigest !== parsed['argsDigest']) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'host_turn_action_conflict',
              message: 'argsDigest mismatch',
            }),
          );
          return;
        }
        if (dropFirstResponse) {
          dropFirstResponse = false;
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...stored.response, replayed }));
      });
    });
    await new Promise<void>((resolve) =>
      brokerServer.listen(0, '127.0.0.1', resolve),
    );
    const brokerPort = (brokerServer.address() as { port: number }).port;

    const harnessApp = express();
    harnessApp.use(express.json());
    const contract = createHostedHarnessContract(
      `sha256:${'a'.repeat(64)}`,
      BOOT_ID,
      ['hosted-workspace-shell/1'],
    );
    installHostedHarnessContractMiddleware(harnessApp, contract);
    registerHostedHarnessSessionRoutes(harnessApp, contract, state.root, {
      baseUrl: `http://127.0.0.1:${brokerPort}/internal/runtime-broker/v1`,
      token: 'broker-secret',
    });
    const listener: Server = createServer(harnessApp);
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );

    const workerExecutedTools: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-ext',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'releaseMount',
    ).mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepare').mockImplementation(
      async (toolName, callId) => ({
        executionId: `exec-${callId}`,
        toolName,
      }),
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'execute').mockImplementation(
      async (_executionId, args) => {
        workerExecutedTools.push(
          String((args as { file_path?: string }).file_path ?? 'unknown'),
        );
        return {
          status: 'SUCCEEDED',
          output: {
            llmContent: 'Wrote review-summary.md',
            returnDisplay: 'ok',
          },
        } as Awaited<ReturnType<HostedWorkspaceBroker['execute']>>;
      },
    );
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledge',
    ).mockResolvedValue();

    let observedToolNames: string[] = [];
    let observedHostResponse: Record<string, unknown> | undefined;

    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      expect(toolTurn).toBeDefined();
      const declarations = await toolTurn!.declarations(signal);
      observedToolNames = declarations.map((decl) => decl.name ?? '');

      const writeCallId = 'call-write-1';
      const writeResponses = await toolTurn!.execute(
        [
          {
            callId: writeCallId,
            name: 'write_file',
            args: { file_path: 'review-summary.md', content: '# LGTM\n' },
            prompt_id: PROMPT_ID,
          },
        ],
        [
          {
            functionCall: {
              id: writeCallId,
              name: 'write_file',
              args: { file_path: 'review-summary.md', content: '# LGTM\n' },
            },
          },
        ],
        'test-model',
        signal,
      );
      expect(writeResponses).toHaveLength(1);

      const commentCallId = 'call-comment-1';
      const commentArgs = { body: 'Reviewed artifacts and wrote summary.' };
      const commentResponses = await toolTurn!.execute(
        [
          {
            callId: commentCallId,
            name: 'post_pr_comment',
            args: commentArgs,
            prompt_id: PROMPT_ID,
          },
        ],
        [
          {
            functionCall: {
              id: commentCallId,
              name: 'post_pr_comment',
              args: commentArgs,
            },
          },
        ],
        'test-model',
        signal,
      );
      observedHostResponse = commentResponses[0]?.functionResponse?.response as
        | Record<string, unknown>
        | undefined;
      return {
        text: `Done: ${(observedHostResponse?.['commentId'] as string) ?? 'missing'}`,
        model: 'test-model',
      };
    });

    try {
      const created = await headers(supertest(listener).post('/session'))
        .send({
          sessionId: SESSION_ID,
          sessionScope: 'thread',
          managedSessionStore: store(),
          toolProfile: 'hosted-workspace-external-files/1',
          approvalMode: 'default',
        })
        .expect(200);
      const clientId = created.body.clientId as string;

      const prompt = [{ type: 'text', text: 'Review PR and post summary' }];
      await headers(supertest(listener).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: promptDigest(prompt),
          hostActions: [POST_PR_COMMENT_ACTION],
        })
        .expect(202);

      // Idempotent replay with identical hostActions succeeds; altered hostActions conflicts.
      await headers(supertest(listener).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: promptDigest(prompt),
          hostActions: [POST_PR_COMMENT_ACTION],
        })
        .expect(202);
      await headers(supertest(listener).post(`/session/${SESSION_ID}/prompt`))
        .set('X-Qwen-Client-Id', clientId)
        .send({
          prompt,
          promptId: PROMPT_ID,
          payloadDigest: promptDigest(prompt),
          hostActions: [
            {
              ...POST_PR_COMMENT_ACTION,
              description: 'Different action contract',
            },
          ],
        })
        .expect(409);

      await vi.waitFor(
        async () => {
          const status = await headers(
            supertest(listener).get(`/session/${SESSION_ID}/status`),
          ).set('X-Qwen-Client-Id', clientId);
          expect(status.body.hasActivePrompt).toBe(false);
          expect(observedHostResponse).toBeDefined();
        },
        { timeout: settleTimeoutMs() },
      );

      expect(observedToolNames).toEqual([
        'read_file',
        'write_file',
        'edit',
        'glob',
        'post_pr_comment',
      ]);
      expect(workerExecutedTools).toEqual(['review-summary.md']);
      // Even though the first HTTP response dropped mid-flight, the host side effect
      // ran once and the retried callback delivered the reconciled commentId.
      expect(hostExecutions).toHaveLength(1);
      expect(hostExecutions[0]?.sessionId).toBe(SESSION_ID);
      expect(hostExecutions[0]?.body).toMatchObject({
        promptId: PROMPT_ID,
        callId: 'call-comment-1',
        actionName: 'post_pr_comment',
        arguments: { body: 'Reviewed artifacts and wrote summary.' },
      });
      expect(observedHostResponse).toMatchObject({
        commentId: 'ic-9001',
        turnId: 'turn-18578',
        callId: 'call-comment-1',
      });
    } finally {
      await headers(supertest(listener).delete(`/session/${SESSION_ID}`));
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
        listener.closeAllConnections();
      });
      await new Promise<void>((resolve) => {
        brokerServer.close(() => resolve());
        brokerServer.closeAllConnections();
      });
    }
  });

  it('validates typed host action schemas before invoking the Broker and preserves unannotated and non-external-files profiles', async () => {
    const executeSpy = vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'executeHostAction',
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    const server = await app(true);

    // 1. Ordinary hosted-workspace-files/1 session rejects hostActions and retains exact tool list.
    const filesSessionId = randomUUID();
    const filesCreated = await headers(supertest(server).post('/session'))
      .send({
        sessionId: filesSessionId,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const filesClientId = filesCreated.body.clientId as string;

    const prompt = [{ type: 'text', text: 'check tools' }];
    const refusedFiles = await headers(
      supertest(server).post(`/session/${filesSessionId}/prompt`),
    )
      .set('X-Qwen-Client-Id', filesClientId)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: promptDigest(prompt),
        hostActions: [POST_PR_COMMENT_ACTION],
      });
    expect(refusedFiles.status).toBe(400);
    expect(refusedFiles.body.code).toBe('invalid_hosted_turn_host_actions');

    // 2. External Shell session rejects hostActions.
    const shellSessionId = randomUUID();
    const shellCreated = await headers(supertest(server).post('/session'))
      .send({
        sessionId: shellSessionId,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-external-shell/1',
        captureBytes: 4096,
      })
      .expect(200);
    const refusedShell = await headers(
      supertest(server).post(`/session/${shellSessionId}/prompt`),
    )
      .set('X-Qwen-Client-Id', shellCreated.body.clientId as string)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: promptDigest(prompt),
        hostActions: [POST_PR_COMMENT_ACTION],
      });
    expect(refusedShell.status).toBe(400);
    expect(refusedShell.body.code).toBe('invalid_hosted_turn_host_actions');

    // 3. External Files session: client-files remains 409; unannotated turn keeps 4 tools;
    // annotated turn rejects schema-invalid arguments without calling Broker.
    const extCreated = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-external-files/1',
      })
      .expect(200);
    const extClientId = extCreated.body.clientId as string;

    const clientFilesAttempt = await headers(
      supertest(server).post(`/session/${SESSION_ID}/client-files`),
    )
      .set('X-Qwen-Client-Id', extClientId)
      .send({
        action: 'register',
        url: 'http://127.0.0.1:9/mcp',
        token: 'tok',
      });
    expect(clientFilesAttempt.status).toBe(409);
    expect(clientFilesAttempt.body.code).toBe(
      'hosted_client_files_profile_unsupported',
    );

    const toolLists: string[][] = [];
    let invalidArgsError: unknown;
    state.model.mockImplementation(async ({ toolTurn, signal }) => {
      const decls = await toolTurn!.declarations(signal);
      toolLists.push(decls.map((d) => d.name ?? ''));
      if (decls.some((d) => d.name === 'post_pr_comment')) {
        const res = await toolTurn!.execute(
          [
            {
              callId: 'bad-call',
              name: 'post_pr_comment',
              args: { body: '', unexpected: true },
              prompt_id: 'annotated-turn',
            },
          ],
          [
            {
              functionCall: {
                id: 'bad-call',
                name: 'post_pr_comment',
                args: { body: '', unexpected: true },
              },
            },
          ],
          'test-model',
          signal,
        );
        invalidArgsError = res[0]?.functionResponse?.response?.['error'];
      }
      return { text: 'ok', model: 'test-model' };
    });

    // Unannotated turn on external Files session:
    const unannotatedPromptId = randomUUID();
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', extClientId)
      .send({
        prompt,
        promptId: unannotatedPromptId,
        payloadDigest: promptDigest(prompt),
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        expect(toolLists).toHaveLength(1);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(toolLists[0]).toEqual(['read_file', 'write_file', 'edit', 'glob']);

    // Wait for unannotated turn to finish before submitting annotated turn:
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', extClientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );

    // Annotated turn with schema-invalid call:
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', extClientId)
      .send({
        prompt,
        promptId: randomUUID(),
        payloadDigest: promptDigest(prompt),
        hostActions: [POST_PR_COMMENT_ACTION],
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', extClientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(toolLists).toHaveLength(2);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(toolLists[1]).toEqual([
      'read_file',
      'write_file',
      'edit',
      'glob',
      'post_pr_comment',
    ]);
    expect(String(invalidArgsError)).toContain('body');
    expect(executeSpy).not.toHaveBeenCalled();

    await headers(supertest(server).delete(`/session/${filesSessionId}`));
    await headers(supertest(server).delete(`/session/${shellSessionId}`));
  });
});
