/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_DAEMON_RESOURCE_BUDGET_BYTES = 512 * 1024 * 1024;
export const DEFAULT_DAEMON_NORMAL_ADMISSION_BYTES = 384 * 1024 * 1024;
export const DAEMON_EMERGENCY_POOL_BYTES = 3 * 1024 * 1024 - 1;

export type ResourceBudgetCategory =
  | 'runtime'
  | 'session'
  | 'connection'
  | 'ingress'
  | 'websocket_assembly'
  | 'outbound'
  | 'prompt'
  | 'replay'
  | 'virtual_transcript'
  | 'background'
  | 'voice'
  | 'process'
  | 'export'
  | 'fanout'
  | 'emergency';

export interface ResourceBudgetOwner {
  workspaceId?: string;
  runtimeGeneration?: string;
  channelGeneration?: string;
  operation?: string;
}

export interface ResourceBudgetRequest {
  category: ResourceBudgetCategory;
  bytes: number;
}

export type ResourceBudgetPriority = 'normal' | 'completion';

export interface ResourceBudgetCategorySnapshot {
  usedBytes: number;
  capBytes: number;
  highWaterBytes: number;
}

export interface ResourceBudgetSnapshot {
  enforced: true;
  usedBytes: number;
  normalUsedBytes: number;
  capBytes: number;
  normalAdmissionBytes: number;
  completionReserveBytes: number;
  highWaterBytes: number;
  categories: Record<ResourceBudgetCategory, ResourceBudgetCategorySnapshot>;
}

export type ResourceBudgetReservationResult =
  | { ok: true; lease: ResourceBudgetLease }
  | {
      ok: false;
      reason: 'parent_limit' | 'normal_admission_limit' | 'category_limit';
      category?: ResourceBudgetCategory;
      limitBytes: number;
      usedBytes: number;
      requestedBytes: number;
    };

export interface ResourceBudgetOptions {
  capBytes?: number;
  normalAdmissionBytes?: number;
  categoryCaps?: Partial<Record<ResourceBudgetCategory, number>>;
}

export class ResourceAdmissionError extends Error {
  readonly data: {
    errorKind: 'resource_admission_exhausted';
    httpStatus: 503;
    limitBytes: number;
    minimumBytes: number;
    actualBytesKnown: true;
    retryable: true;
  };

  constructor(result: Exclude<ResourceBudgetReservationResult, { ok: true }>) {
    super(
      `Resource admission requires ${result.requestedBytes} bytes but the effective limit is ${result.limitBytes} bytes`,
    );
    this.name = 'ResourceAdmissionError';
    this.data = {
      errorKind: 'resource_admission_exhausted',
      httpStatus: 503,
      limitBytes: result.limitBytes,
      minimumBytes: result.requestedBytes,
      actualBytesKnown: true,
      retryable: true,
    };
  }
}

const DEFAULT_CATEGORY_CAPS: Record<ResourceBudgetCategory, number> = {
  runtime: 25 * 1024 * 1024,
  session: 256 * 1024 * 1024,
  connection: 16 * 1024 * 1024,
  ingress: 128 * 1024 * 1024,
  websocket_assembly: 256 * 1024 * 1024,
  outbound: 256 * 1024 * 1024,
  prompt: 384 * 1024 * 1024,
  replay: 128 * 1024 * 1024,
  virtual_transcript: 64 * 1024 * 1024,
  background: 64 * 1024 * 1024,
  voice: 128 * 1024 * 1024,
  process: 128 * 1024 * 1024,
  export: 256 * 1024 * 1024,
  fanout: 32 * 1024 * 1024,
  emergency: DAEMON_EMERGENCY_POOL_BYTES,
};

const RESOURCE_BUDGET_CATEGORIES = Object.freeze(
  Object.keys(DEFAULT_CATEGORY_CAPS) as ResourceBudgetCategory[],
);

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function normalizeRequests(
  requests: readonly ResourceBudgetRequest[],
): Map<ResourceBudgetCategory, number> {
  const normalized = new Map<ResourceBudgetCategory, number>();
  for (const request of requests) {
    if (!Number.isSafeInteger(request.bytes) || request.bytes < 0) {
      throw new TypeError(
        'resource reservation bytes must be a non-negative safe integer',
      );
    }
    if (request.bytes === 0) continue;
    const combined = (normalized.get(request.category) ?? 0) + request.bytes;
    if (!Number.isSafeInteger(combined)) {
      throw new RangeError('combined resource reservation is too large');
    }
    normalized.set(request.category, combined);
  }
  return normalized;
}

function totalBytes(
  entries: ReadonlyMap<ResourceBudgetCategory, number>,
): number {
  let total = 0;
  for (const bytes of entries.values()) {
    total += bytes;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('total resource reservation is too large');
    }
  }
  return total;
}

export class ResourceBudget {
  readonly capBytes: number;
  readonly normalAdmissionBytes: number;
  readonly completionReserveBytes: number;

  private usedBytes = 0;
  private normalUsedBytes = 0;
  private highWaterBytes = 0;
  private readonly emergencyPoolBytes: number;
  private readonly categoryCaps: Record<ResourceBudgetCategory, number>;
  private readonly categoryUsed = new Map<ResourceBudgetCategory, number>();
  private readonly categoryHighWater = new Map<
    ResourceBudgetCategory,
    number
  >();

  constructor(options: ResourceBudgetOptions = {}) {
    this.capBytes = options.capBytes ?? DEFAULT_DAEMON_RESOURCE_BUDGET_BYTES;
    this.normalAdmissionBytes =
      options.normalAdmissionBytes ?? DEFAULT_DAEMON_NORMAL_ADMISSION_BYTES;
    assertPositiveSafeInteger('capBytes', this.capBytes);
    assertPositiveSafeInteger(
      'normalAdmissionBytes',
      this.normalAdmissionBytes,
    );
    if (this.normalAdmissionBytes > this.capBytes) {
      throw new TypeError('normalAdmissionBytes must not exceed capBytes');
    }
    this.completionReserveBytes = this.capBytes - this.normalAdmissionBytes;
    this.categoryCaps = { ...DEFAULT_CATEGORY_CAPS };
    for (const [category, cap] of Object.entries(
      options.categoryCaps ?? {},
    ) as Array<[ResourceBudgetCategory, number]>) {
      assertPositiveSafeInteger(`categoryCaps.${category}`, cap);
      this.categoryCaps[category] = cap;
    }
    this.emergencyPoolBytes =
      options.categoryCaps?.emergency ??
      (options.capBytes === undefined ? DAEMON_EMERGENCY_POOL_BYTES : 0);
    if (this.emergencyPoolBytes > this.capBytes) {
      throw new TypeError('emergency category cap must not exceed capBytes');
    }
    for (const category of RESOURCE_BUDGET_CATEGORIES) {
      this.categoryUsed.set(category, 0);
      this.categoryHighWater.set(category, 0);
    }
  }

  tryReserveComposite(
    requests: readonly ResourceBudgetRequest[],
    options: {
      priority?: ResourceBudgetPriority;
      owner?: ResourceBudgetOwner;
    } = {},
  ): ResourceBudgetReservationResult {
    const entries = normalizeRequests(requests);
    const requestedBytes = totalBytes(entries);
    const priority = options.priority ?? 'normal';
    const failure = this.checkReservation(entries, requestedBytes, priority);
    if (failure) return failure;
    this.commitReservation(entries, requestedBytes, priority);
    return {
      ok: true,
      lease: new ResourceBudgetLease(this, entries, priority, options.owner),
    };
  }

  snapshot(): ResourceBudgetSnapshot {
    const categories = {} as Record<
      ResourceBudgetCategory,
      ResourceBudgetCategorySnapshot
    >;
    for (const category of RESOURCE_BUDGET_CATEGORIES) {
      categories[category] = {
        usedBytes: this.categoryUsed.get(category) ?? 0,
        capBytes: this.categoryCaps[category],
        highWaterBytes: this.categoryHighWater.get(category) ?? 0,
      };
    }
    return {
      enforced: true,
      usedBytes: this.usedBytes,
      normalUsedBytes: this.normalUsedBytes,
      capBytes: this.capBytes,
      normalAdmissionBytes: this.normalAdmissionBytes,
      completionReserveBytes: this.completionReserveBytes,
      highWaterBytes: this.highWaterBytes,
      categories,
    };
  }

  grow(
    lease: ResourceBudgetLease,
    requests: readonly ResourceBudgetRequest[],
  ): ResourceBudgetReservationResult {
    const entries = normalizeRequests(requests);
    const requestedBytes = totalBytes(entries);
    const failure = this.checkReservation(
      entries,
      requestedBytes,
      lease.priority,
    );
    if (failure) return failure;
    this.commitReservation(entries, requestedBytes, lease.priority);
    lease.commitGrow(entries);
    return { ok: true, lease };
  }

  release(
    entries: ReadonlyMap<ResourceBudgetCategory, number>,
    priority: ResourceBudgetPriority,
  ): void {
    const releasedBytes = totalBytes(entries);
    this.usedBytes -= releasedBytes;
    if (priority === 'normal' && !entries.has('emergency')) {
      this.normalUsedBytes -= releasedBytes;
    }
    for (const [category, bytes] of entries) {
      this.categoryUsed.set(
        category,
        (this.categoryUsed.get(category) ?? 0) - bytes,
      );
    }
  }

  private checkReservation(
    entries: ReadonlyMap<ResourceBudgetCategory, number>,
    requestedBytes: number,
    priority: ResourceBudgetPriority,
  ): Exclude<ResourceBudgetReservationResult, { ok: true }> | undefined {
    const emergencyBytes = entries.get('emergency') ?? 0;
    if (emergencyBytes > 0 && entries.size !== 1) {
      throw new TypeError(
        'emergency reservations cannot include business categories',
      );
    }
    const emergencyUsed = this.categoryUsed.get('emergency') ?? 0;
    const parentUsed =
      emergencyBytes > 0 ? this.usedBytes : this.usedBytes - emergencyUsed;
    const parentLimit =
      emergencyBytes > 0
        ? this.capBytes
        : this.capBytes - this.emergencyPoolBytes;
    if (parentUsed + requestedBytes > parentLimit) {
      return {
        ok: false,
        reason: 'parent_limit',
        limitBytes: parentLimit,
        usedBytes: parentUsed,
        requestedBytes,
      };
    }
    for (const [category, bytes] of entries) {
      const usedBytes = this.categoryUsed.get(category) ?? 0;
      const capBytes = this.categoryCaps[category];
      if (usedBytes + bytes > capBytes) {
        return {
          ok: false,
          reason: 'category_limit',
          category,
          limitBytes: capBytes,
          usedBytes,
          requestedBytes: bytes,
        };
      }
    }
    if (
      emergencyBytes === 0 &&
      priority === 'normal' &&
      this.normalUsedBytes + requestedBytes > this.normalAdmissionBytes
    ) {
      return {
        ok: false,
        reason: 'normal_admission_limit',
        limitBytes: this.normalAdmissionBytes,
        usedBytes: this.normalUsedBytes,
        requestedBytes,
      };
    }
    return undefined;
  }

  private commitReservation(
    entries: ReadonlyMap<ResourceBudgetCategory, number>,
    requestedBytes: number,
    priority: ResourceBudgetPriority,
  ): void {
    this.usedBytes += requestedBytes;
    if (priority === 'normal' && !entries.has('emergency')) {
      this.normalUsedBytes += requestedBytes;
    }
    this.highWaterBytes = Math.max(this.highWaterBytes, this.usedBytes);
    for (const [category, bytes] of entries) {
      const usedBytes = (this.categoryUsed.get(category) ?? 0) + bytes;
      this.categoryUsed.set(category, usedBytes);
      this.categoryHighWater.set(
        category,
        Math.max(this.categoryHighWater.get(category) ?? 0, usedBytes),
      );
    }
  }
}

export class ResourceBudgetLease {
  private entries: Map<ResourceBudgetCategory, number>;
  private released = false;

  constructor(
    private readonly budget: ResourceBudget,
    entries: ReadonlyMap<ResourceBudgetCategory, number>,
    readonly priority: ResourceBudgetPriority,
    private owner?: ResourceBudgetOwner,
  ) {
    this.entries = new Map(entries);
  }

  get bytes(): number {
    return totalBytes(this.entries);
  }

  get currentOwner(): ResourceBudgetOwner | undefined {
    return this.owner;
  }

  transferOwner(owner: ResourceBudgetOwner): void {
    this.assertOpen();
    this.owner = owner;
  }

  tryGrow(
    requests: readonly ResourceBudgetRequest[],
  ): ResourceBudgetReservationResult {
    this.assertOpen();
    return this.budget.grow(this, requests);
  }

  split(
    requests: readonly ResourceBudgetRequest[],
    owner = this.owner,
  ): ResourceBudgetLease {
    this.assertOpen();
    const splitEntries = normalizeRequests(requests);
    for (const [category, bytes] of splitEntries) {
      if ((this.entries.get(category) ?? 0) < bytes) {
        throw new RangeError(
          `cannot split ${bytes} bytes from ${category} reservation`,
        );
      }
    }
    for (const [category, bytes] of splitEntries) {
      const remaining = (this.entries.get(category) ?? 0) - bytes;
      if (remaining === 0) this.entries.delete(category);
      else this.entries.set(category, remaining);
    }
    return new ResourceBudgetLease(
      this.budget,
      splitEntries,
      this.priority,
      owner,
    );
  }

  shrink(requests: readonly ResourceBudgetRequest[]): void {
    this.assertOpen();
    const shrinkEntries = normalizeRequests(requests);
    for (const [category, bytes] of shrinkEntries) {
      if ((this.entries.get(category) ?? 0) < bytes) {
        throw new RangeError(
          `cannot release ${bytes} bytes from ${category} reservation`,
        );
      }
    }
    for (const [category, bytes] of shrinkEntries) {
      const remaining = (this.entries.get(category) ?? 0) - bytes;
      if (remaining === 0) this.entries.delete(category);
      else this.entries.set(category, remaining);
    }
    this.budget.release(shrinkEntries, this.priority);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.budget.release(this.entries, this.priority);
    this.entries.clear();
  }

  commitGrow(entries: ReadonlyMap<ResourceBudgetCategory, number>): void {
    for (const [category, bytes] of entries) {
      this.entries.set(category, (this.entries.get(category) ?? 0) + bytes);
    }
  }

  private assertOpen(): void {
    if (this.released) {
      throw new Error('resource budget lease is already released');
    }
  }
}
