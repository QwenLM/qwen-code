/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
} from '@qwen-code/qwen-code-core';
import { validateAgainstSchema } from '@qwen-code/qwen-code-core';
import type { AgentRegistry } from '../agents/agentRegistry.js';
import type { SessionDaemon } from '../daemonPool.js';

const SCHEMA_RETRIES = 2;

export interface SessionSpawnerDeps {
  daemon: SessionDaemon;
  registry: AgentRegistry;
  runId: string;
  spawnedByTokenId: string;
  /** Called with (agentId, sessionId) as each workflow agent is registered. */
  onAgentSpawned?: (agentId: string, sessionId: string) => void;
}

/** Defensive extractors — reconcile against DaemonClient.prompt at Phase 3.0. */
function extractText(turn: unknown): string {
  if (typeof turn === 'string') return turn;
  const t = turn as { text?: unknown; result?: unknown } | null;
  if (typeof t?.text === 'string') return t.text;
  if (typeof t?.result === 'string') return t.result;
  return '';
}
function extractTokens(turn: unknown): number {
  const t = turn as {
    tokens?: unknown;
    usage?: { totalTokens?: unknown };
  } | null;
  if (typeof t?.tokens === 'number') return t.tokens;
  if (typeof t?.usage?.totalTokens === 'number') return t.usage.totalTokens;
  return 0;
}

/**
 * Gateway spawner (design: "SessionSpawner"). Each workflow agent IS a real
 * daemon session — observable, cost-tracked, searchable — tagged with the
 * workflow's runId on its AgentRecord. On abort (workflow cancel) the session
 * is ended.
 */
export class SessionSpawner implements AgentSpawner {
  constructor(private readonly deps: SessionSpawnerDeps) {}

  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    const session = await this.deps.daemon.createOrAttachSession({
      sessionScope: 'thread',
      ...(req.model !== undefined ? { modelServiceId: req.model } : {}),
      ...(req.cwd ? { workspaceCwd: req.cwd } : {}),
    });
    const sessionId = session.sessionId;
    const record = await this.deps.registry.register({
      sessionId,
      parentSessionId: null,
      agentType: req.agentType ?? 'general',
      task: req.prompt,
      spawnedByTokenId: this.deps.spawnedByTokenId,
      workflowRunId: this.deps.runId,
    });
    this.deps.onAgentSpawned?.(record.agentId, sessionId);

    // Cancel → end the session.
    const onAbort = () =>
      void this.deps.daemon.closeSession(sessionId).catch(() => {});
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let tokens = 0;
      const attempts = req.schema ? SCHEMA_RETRIES + 1 : 1;
      let promptText = req.schema
        ? `${req.prompt}\n\nReply with ONLY JSON conforming to:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      // No system-prompt field exists on CreateSessionRequest/PromptRequest,
      // so fold systemContext into the prompt text itself — mirroring how
      // HeadlessSpawner combines systemContext with the task (spawner.ts).
      promptText = req.systemContext
        ? `${req.systemContext}\n\n${promptText}`
        : promptText;
      let lastError = '';
      for (let attempt = 0; attempt < attempts; attempt++) {
        const turn = await this.deps.daemon.prompt(
          sessionId,
          {
            prompt: [{ type: 'text', text: promptText }],
          },
          req.signal,
        );
        tokens += extractTokens(turn);
        const text = extractText(turn);
        if (!req.schema) return { text, tokens };
        const check = validateAgainstSchema(text, req.schema);
        if (check.valid) return { structured: check.value, tokens };
        lastError = check.error;
        promptText = `Your reply was invalid (${lastError}). Return corrected JSON only.`;
      }
      throw new Error(
        `schema validation failed after ${attempts} attempts: ${lastError}`,
      );
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}
