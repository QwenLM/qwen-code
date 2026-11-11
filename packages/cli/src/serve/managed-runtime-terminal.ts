/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebTerminalRegistry } from '@qwen-code/qwen-code-core/services/web-terminal-registry.js';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  createTerminalWsHandler,
  type WebTerminalWorkspaceContext,
} from './routes/terminal.js';
import type { ManagedRuntimeRequestIdentity } from './managed-runtime-attestation-contract.js';

/**
 * The user-terminal upgrade route of a terminal-capable Managed Runtime
 * worker. Only the control plane's relay reaches it, authenticated with the
 * same bearer/lease identity as every owned worker route; Session-level
 * authorization is enforced by the relay before it opens this connection.
 */
export const MANAGED_RUNTIME_TERMINAL_ROUTE = Object.freeze({
  key: 'terminal',
  method: 'GET',
  path: '/internal/managed-runtime/v3/terminal',
  protocolVersion: 3,
  cacheControl: 'no-store',
} as const);

/** Per-Session terminal cap within the worker-wide registry limit. */
export const MAX_MANAGED_SESSION_TERMINALS = 4;

/**
 * The exit receipt WebTerminalRegistry.release() reports for a live PTY it
 * terminates (128 + SIGTERM). The hold's wire contract rejects an `exited`
 * answer whose evidence is entirely null, so a released terminal must carry
 * this proven code rather than a bare end. Kept in sync with the registry's
 * release() exit listener; a test pins the two together.
 */
export const TERMINAL_RELEASE_EXIT_CODE = 143;

const MAX_SELECTOR_LENGTH = 256;

function equalSecret(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

function refuseUpgrade(
  socket: Duplex,
  status: number,
  code: string,
  message: string,
): void {
  const body = JSON.stringify({ code, error: message });
  socket.write(
    `HTTP/1.1 ${status} ${code}\r\n` +
      'Content-Type: application/json\r\n' +
      'Cache-Control: no-store\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body,
  );
  socket.destroy();
}

interface ParsedTerminalOperation {
  readonly kind: 'terminal-status' | 'terminal-terminate';
  readonly operationId: string;
  readonly targetOperationId: string;
  readonly sessionKey: {
    readonly tenantId: string;
    readonly sessionId: string;
  };
}

const OPERATION_KEYS = [
  'kind',
  'operationId',
  'sessionKey',
  'targetOperationId',
];

function parseTerminalOperation(value: unknown): ParsedTerminalOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('managed_terminal_invalid');
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(',') !==
    [...OPERATION_KEYS].sort().join(',')
  ) {
    throw new Error('managed_terminal_invalid');
  }
  const kind = object['kind'];
  if (kind !== 'terminal-status' && kind !== 'terminal-terminate') {
    throw new Error('managed_terminal_invalid');
  }
  const sessionKey = object['sessionKey'];
  if (
    !sessionKey ||
    typeof sessionKey !== 'object' ||
    typeof (sessionKey as Record<string, unknown>)['tenantId'] !== 'string' ||
    typeof (sessionKey as Record<string, unknown>)['sessionId'] !== 'string'
  ) {
    throw new Error('managed_terminal_invalid');
  }
  for (const key of ['operationId', 'targetOperationId'] as const) {
    const field = object[key];
    if (typeof field !== 'string' || !field || field.length > 512) {
      throw new Error('managed_terminal_invalid');
    }
  }
  return {
    kind,
    operationId: object['operationId'] as string,
    targetOperationId: object['targetOperationId'] as string,
    sessionKey: sessionKey as { tenantId: string; sessionId: string },
  };
}

/**
 * Hosts the worker's interactive terminals. Terminals are tagged with the
 * Runtime Session selector the relay supplies; an attach may only address a
 * terminal of the same Session, and each Session holds at most
 * MAX_MANAGED_SESSION_TERMINALS live terminals. The frame protocol is the
 * daemon Web Terminal's, delegated to the shared connection handler.
 */
export class ManagedRuntimeTerminals {
  private readonly registry = new WebTerminalRegistry();
  private readonly owners = new Map<string, string>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connection: (ws: WebSocket, req: IncomingMessage) => void;
  private disposed = false;

  constructor(
    private readonly identity: ManagedRuntimeRequestIdentity,
    private readonly workspaceCwd: string,
    private readonly env: Readonly<NodeJS.ProcessEnv>,
  ) {
    this.connection = createTerminalWsHandler(this.registry, (selector) =>
      this.resolveWorkspace(selector),
    ).onConnection;
  }

  /** Wires the upgrade listener of the worker's private HTTP server. */
  register(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head);
    });
  }

  private resolveWorkspace(
    selector: string,
  ): WebTerminalWorkspaceContext | undefined {
    if (!selector || selector.length > MAX_SELECTOR_LENGTH) return undefined;
    return { workspaceCwd: this.workspaceCwd, env: this.env };
  }

  private authorize(
    req: IncomingMessage,
  ): { status: number; code: string } | undefined {
    const authorization = req.headers['authorization'];
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ') ||
      !equalSecret(authorization.slice('Bearer '.length), this.identity.token)
    ) {
      return { status: 401, code: 'managed_runtime_unauthorized' };
    }
    if (req.headers['cache-control'] !== 'no-store') {
      return { status: 400, code: 'managed_runtime_attestation_invalid' };
    }
    if (
      req.headers['x-qwen-managed-lease-id'] !== this.identity.leaseId ||
      req.headers['x-qwen-managed-lease-epoch'] !== String(this.identity.epoch)
    ) {
      return { status: 409, code: 'managed_runtime_identity_conflict' };
    }
    return undefined;
  }

  private liveCount(selector: string): number {
    let live = 0;
    for (const [terminalId, owner] of this.owners) {
      if (owner !== selector) continue;
      const snapshot = this.registry.readSnapshot(terminalId);
      if (snapshot && !snapshot.exited && !snapshot.failed) live += 1;
    }
    return live;
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (
      req.method !== 'GET' ||
      url.pathname !== MANAGED_RUNTIME_TERMINAL_ROUTE.path
    ) {
      refuseUpgrade(socket, 404, 'not_found', 'Unknown upgrade route.');
      return;
    }
    const refusal = this.authorize(req);
    if (refusal) {
      refuseUpgrade(
        socket,
        refusal.status,
        refusal.code,
        'Managed Runtime credentials are invalid.',
      );
      return;
    }
    if (this.disposed) {
      refuseUpgrade(
        socket,
        503,
        'managed_runtime_unavailable',
        'Worker is closing.',
      );
      return;
    }
    const terminalId = url.searchParams.get('terminalId');
    const selector = url.searchParams.get('cwd');
    if (
      !terminalId ||
      terminalId.length > MAX_SELECTOR_LENGTH ||
      !selector ||
      selector.length > MAX_SELECTOR_LENGTH
    ) {
      refuseUpgrade(
        socket,
        400,
        'managed_terminal_invalid',
        'Terminal identity is invalid.',
      );
      return;
    }
    const snapshot = this.registry.readSnapshot(terminalId);
    const owner = this.owners.get(terminalId);
    if (snapshot && owner !== undefined && owner !== selector) {
      refuseUpgrade(
        socket,
        409,
        'managed_terminal_identity_conflict',
        'Terminal belongs to another Session.',
      );
      return;
    }
    if (
      !snapshot &&
      this.liveCount(selector) >= MAX_MANAGED_SESSION_TERMINALS
    ) {
      refuseUpgrade(
        socket,
        429,
        'managed_terminal_limit',
        'Session terminal limit reached.',
      );
      return;
    }
    this.owners.set(terminalId, selector);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      Promise.resolve(this.connection(ws, req)).catch(() => {
        try {
          ws.terminate();
        } catch {
          // Socket is already gone.
        }
      });
    });
  }

  /**
   * Answers the hold's maintenance controls about one terminal. `running` is
   * registered-live; `exited` is a proven end (a native exit, or a terminal
   * this Session admitted that is no longer registered); `unknown` is anything
   * it cannot prove — never a claimed exit. The owners record is retained after
   * a terminal ends so a released/reclaimed terminal still answers `exited`
   * instead of wedging its hold.
   */
  control(value: unknown): {
    operationId: string;
    state: 'exited' | 'running' | 'unknown';
    unitName?: string;
    evidence?: { exitCode: number | null; exitSignal: string | null };
  } {
    const operation = parseTerminalOperation(value);
    const terminalId = operation.targetOperationId;
    const selector = operation.sessionKey.sessionId;
    const owner = this.owners.get(terminalId);
    if (owner !== undefined && owner !== selector) {
      return { operationId: terminalId, state: 'unknown' };
    }
    const snapshot = this.registry.readSnapshot(terminalId);
    if (snapshot && !snapshot.exited && !snapshot.failed) {
      if (operation.kind === 'terminal-status') {
        return {
          operationId: terminalId,
          state: 'running',
          unitName: terminalId,
        };
      }
      this.registry.release(terminalId, this.workspaceCwd);
      return {
        operationId: terminalId,
        state: 'exited',
        evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
      };
    }
    if (snapshot && snapshot.exitCode !== undefined) {
      return {
        operationId: terminalId,
        state: 'exited',
        evidence: { exitCode: snapshot.exitCode, exitSignal: null },
      };
    }
    // Ownership is recorded before the asynchronous create completes, so a
    // missing snapshot here can still be a terminal mid-creation — not a
    // proven exit. Status keeps the hold; termination cancels the pending
    // creation so the shell can never start after the hold is discharged.
    if (this.registry.isCreating(terminalId)) {
      if (operation.kind === 'terminal-status') {
        return { operationId: terminalId, state: 'unknown' };
      }
      this.registry.release(terminalId, this.workspaceCwd);
      return {
        operationId: terminalId,
        state: 'exited',
        evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
      };
    }
    if (owner !== undefined && !snapshot) {
      return {
        operationId: terminalId,
        state: 'exited',
        evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
      };
    }
    // A failed spawn, or anything else without provable exit evidence, must
    // not claim an end the wire contract would accept as settled.
    return { operationId: terminalId, state: 'unknown' };
  }

  /** Kills every terminal; used by the worker close path. */
  dispose(): void {
    this.disposed = true;
    this.registry.dispose();
    this.owners.clear();
    this.wss.close();
  }
}
