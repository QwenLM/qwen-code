/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import type { Application, RequestHandler } from 'express';
import type { HostedHarnessPlacement } from '@qwen-code/qwen-code-core/managed-runtime/hosted-harness-release.js';
import {
  hostedHarnessContractMiddleware,
  type HostedHarnessContract,
} from './hosted-harness-contract.js';

const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseHostedHarnessInstanceId(value: string): string {
  if (!INSTANCE_ID.test(value))
    throw new Error('Invalid Hosted Harness instance identity.');
  return value;
}

export function parseHostedHarnessPlacement(
  value: unknown,
): HostedHarnessPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Harness placement is required.');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'bootId,instanceId,placementEpoch' ||
    typeof record['instanceId'] !== 'string' ||
    typeof record['bootId'] !== 'string' ||
    !UUID.test(record['bootId']) ||
    !Number.isSafeInteger(record['placementEpoch']) ||
    (record['placementEpoch'] as number) < 1
  )
    throw new Error('Invalid Harness placement.');
  return {
    instanceId: parseHostedHarnessInstanceId(record['instanceId']),
    bootId: record['bootId'],
    placementEpoch: record['placementEpoch'] as number,
  };
}

export interface HostedHarnessCounters {
  attachedSessions: number;
  activeTurns: number;
  openingSessions: number;
  pendingInputs: number;
  heldResources: number;
  pendingPublications: number;
}

export class HostedHarnessInstance {
  private drainOperation?: string;
  private operations = 0;

  constructor(
    readonly contract: HostedHarnessContract & { instanceId: string },
    private readonly counters: () => HostedHarnessCounters,
    private readonly onDrain?: () => void,
  ) {}

  get accepting(): boolean {
    return this.drainOperation === undefined;
  }

  get inFlightMutations(): number {
    return this.operations;
  }

  track: RequestHandler = (req, res, next) => {
    if (req.path.endsWith('/events') || req.path.endsWith('/ownership:release'))
      return next();
    this.operations += 1;
    // A disconnected response cannot prove its asynchronous operation ended.
    // Keep the owner non-releasable; the bounded shutdown takes the crash path.
    res.once('finish', () => {
      this.operations -= 1;
    });
    next();
  };

  snapshot() {
    const counters = { ...this.counters(), inFlightMutations: this.operations };
    const state = this.accepting
      ? 'ACCEPTING'
      : counters.attachedSessions === 0 &&
          counters.openingSessions === 0 &&
          counters.activeTurns === 0 &&
          counters.inFlightMutations === 0 &&
          counters.heldResources === 0 &&
          counters.pendingPublications === 0
        ? 'DRAINED'
        : 'QUIESCING';
    return {
      format: 'qwen-hosted-harness-instance/1' as const,
      instanceId: this.contract.instanceId,
      bootId: this.contract.bootId,
      capabilityDigest: this.contract.capabilityDigest,
      state,
      counters,
    };
  }

  register(app: Application): void {
    const prefix = '/internal/hosted-harness/v1';
    app.use(prefix, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      hostedHarnessContractMiddleware(this.contract)(req, res, next);
    });
    app.get(`${prefix}/instance`, (_req, res) => res.json(this.snapshot()));
    app.post(`${prefix}/instance:drain`, (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (
        !body ||
        Object.keys(body).sort().join(',') !== 'expectedBootId,operationId' ||
        typeof body['operationId'] !== 'string' ||
        !UUID.test(body['operationId']) ||
        body['expectedBootId'] !== this.contract.bootId
      ) {
        res.status(400).json({ code: 'invalid_hosted_harness_drain' });
        return;
      }
      if (this.drainOperation && this.drainOperation !== body['operationId']) {
        res.status(409).json({ code: 'hosted_harness_drain_conflict' });
        return;
      }
      this.drainOperation = body['operationId'];
      this.onDrain?.();
      res
        .status(202)
        .json({ ...this.snapshot(), operationId: this.drainOperation });
    });
    app.get(`${prefix}/metrics`, (_req, res) => {
      const memory = process.memoryUsage();
      res.json({
        ...this.snapshot(),
        process: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          eventLoopUtilization: performance.eventLoopUtilization().utilization,
        },
      });
    });
  }
}
