/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A tab registry with stable lookups for both public and provider identities. */
export class TabRegistry<T extends { id: string; providerTabId: number }> {
  private readonly byId = new Map<string, T>();
  private readonly byProviderId = new Map<number, T>();

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  getByProviderId(providerTabId: number): T | undefined {
    return this.byProviderId.get(providerTabId);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  set(value: T): void {
    const previousById = this.byId.get(value.id);
    if (previousById !== undefined)
      this.byProviderId.delete(previousById.providerTabId);
    const previousByProvider = this.byProviderId.get(value.providerTabId);
    if (previousByProvider !== undefined)
      this.byId.delete(previousByProvider.id);
    this.byId.set(value.id, value);
    this.byProviderId.set(value.providerTabId, value);
  }

  delete(id: string): boolean {
    const value = this.byId.get(id);
    if (value === undefined) return false;
    this.byId.delete(id);
    this.byProviderId.delete(value.providerTabId);
    return true;
  }

  values(): IterableIterator<T> {
    return this.byId.values();
  }

  clear(): void {
    this.byId.clear();
    this.byProviderId.clear();
  }
}
