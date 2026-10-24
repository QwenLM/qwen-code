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
  isValidId,
  readAgentWorkspace,
  updateAgentWorkspaceCallerGrants,
} from './store.js';
import type { A2AGrant } from './types.js';

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
    expiresAt?: number;
  },
  now = Date.now(),
): Promise<IssuedGrant> {
  const { callerId, agentId } = input;
  // The same checks the store applies when it reads the record back: one bad
  // grant written here would make the whole workspace record unreadable.
  if (!isValidId(callerId) || !isValidId(agentId)) {
    throw new Error('A grant needs a valid caller id and agent id.');
  }
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) {
    throw new Error('A grant expiry must be a finite timestamp.');
  }
  if (!Number.isFinite(now)) {
    throw new Error('A grant creation time must be a finite timestamp.');
  }
  const secret = randomBytes(32).toString('base64url');
  const grant: A2AGrant = {
    callerId,
    agentId,
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
      reason: 'no_grant' | 'bad_secret' | 'expired';
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
