/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Who outside may call which agent, and to do what.
 *
 * Separate from the daemon's own authentication on purpose. The daemon's
 * management token says "you may administer this daemon"; a grant says "this
 * one external caller may ask this one agent for this one kind of work". The
 * plan is explicit that the management token is never handed to an external
 * collaborator, so authenticating as a caller must not be a route to it — a
 * grant is the only thing an A2A request is checked against, and it names an
 * agent rather than a daemon.
 *
 * Secrets are never stored, only their digests, and never travel in a thread,
 * a prompt, a tool argument or a log line.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  readAgentWorkspace,
  updateAgentWorkspaceCallerGrants,
} from './store.js';
import type { A2AGrant, A2AGrantScope } from './types.js';

/**
 * What a grant permits.
 *
 * Deliberately coarse, and deliberately not "everything the agent can do".
 * `analysis` is read-only work — the plan's first opened agent does read-only
 * analysis of a pre-authorised repository, and code writes and open MCP access
 * are explicitly not the default. A grant that cannot express "read-only"
 * would make the safe case unrepresentable and the unsafe one the only option.
 */
export const A2A_GRANT_SCOPES: readonly A2AGrantScope[] = ['analysis', 'full'];

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function matchesSecret(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a mismatch rather than returning false.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface IssuedGrant {
  grant: Omit<A2AGrant, 'secretHash'>;
  /** Returned exactly once, at issue. Nothing stores it. */
  secret: string;
}

/**
 * Open one agent to one caller.
 *
 * A grant is per agent, not per daemon: opening agent A to a caller says
 * nothing about agent B, and the plan requires that a grant in one direction
 * confer nothing in the other.
 */
export async function issueA2AGrant(
  projectRoot: string,
  input: {
    callerId: string;
    agentId: string;
    scope: A2AGrantScope;
    expiresAt?: number;
  },
  now = Date.now(),
): Promise<IssuedGrant> {
  const { callerId, agentId, scope } = input;
  if (!callerId || !agentId) {
    throw new Error('A grant needs a caller and an agent.');
  }
  if (!A2A_GRANT_SCOPES.includes(scope)) {
    throw new Error(`Unknown grant scope "${scope}".`);
  }
  const secret = randomBytes(32).toString('base64url');
  const grant: A2AGrant = {
    callerId,
    agentId,
    scope,
    secretHash: hashSecret(secret),
    createdAt: now,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
  await updateAgentWorkspaceCallerGrants(projectRoot, (grants) => [
    // Re-issuing replaces rather than accumulates: two live secrets for one
    // pair means revoking one leaves the caller in.
    ...grants.filter(
      (existing) =>
        existing.callerId !== callerId || existing.agentId !== agentId,
    ),
    grant,
  ]);
  const { secretHash: _secretHash, ...view } = grant;
  return { grant: view, secret };
}

/** Withdraw a grant. Returns whether one was there to withdraw. */
export async function revokeA2AGrant(
  projectRoot: string,
  input: { callerId: string; agentId: string },
): Promise<boolean> {
  let removed = false;
  await updateAgentWorkspaceCallerGrants(projectRoot, (grants) => {
    const next = grants.filter(
      (grant) =>
        grant.callerId !== input.callerId || grant.agentId !== input.agentId,
    );
    removed = next.length !== grants.length;
    return next;
  });
  return removed;
}

export type GrantCheck =
  | { ok: true; grant: Omit<A2AGrant, 'secretHash'> }
  | {
      ok: false;
      /**
       * Why it failed, for the daemon's own log. It is deliberately NOT for
       * the caller: telling an unauthorised caller whether an agent exists,
       * or whether its own secret was merely expired, hands it a way to
       * enumerate agents and to distinguish "revoked" from "never had one".
       */
      reason: 'no_grant' | 'bad_secret' | 'expired' | 'out_of_scope';
    };

/**
 * Check one inbound call against the grants.
 *
 * Every failure mode is one refusal to the caller. The distinctions above stay
 * on this side of the boundary.
 */
export async function checkA2AGrant(
  projectRoot: string,
  input: {
    callerId: string;
    agentId: string;
    secret: string;
    /** The scope this particular call needs. */
    required: A2AGrantScope;
  },
  now = Date.now(),
): Promise<GrantCheck> {
  const workspace = await readAgentWorkspace(projectRoot);
  const grant = (workspace.callerGrants ?? []).find(
    (candidate) =>
      candidate.callerId === input.callerId &&
      candidate.agentId === input.agentId,
  );
  if (!grant) return { ok: false, reason: 'no_grant' };
  if (!input.secret || !matchesSecret(input.secret, grant.secretHash)) {
    return { ok: false, reason: 'bad_secret' };
  }
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }
  // `full` covers `analysis`; `analysis` does not cover `full`. Spelled out
  // rather than ordered by array index so adding a scope cannot silently widen
  // an existing one by landing in the wrong position.
  const permitted =
    grant.scope === 'full' ||
    (grant.scope === 'analysis' && input.required === 'analysis');
  if (!permitted) return { ok: false, reason: 'out_of_scope' };
  const { secretHash: _secretHash, ...view } = grant;
  return { ok: true, grant: view };
}

/** Grants on this workspace, without their digests. */
export async function listA2AGrants(
  projectRoot: string,
): Promise<Array<Omit<A2AGrant, 'secretHash'>>> {
  const workspace = await readAgentWorkspace(projectRoot);
  return (workspace.callerGrants ?? []).map(
    ({ secretHash: _secretHash, ...view }) => view,
  );
}
