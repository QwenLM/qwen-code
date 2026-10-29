/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Host-injected catalog row. Shown disabled in the composer picker. */
export interface WebShellUnavailableModel {
  id: string;
  label?: string;
  /** Plain-text hint. A successful mount replaces this string. */
  tooltip?: string;
}

export interface WebShellUnavailableModelTooltipInfo {
  readonly model: WebShellUnavailableModel;
}

export interface WebShellUnavailableModelTooltipHandle {
  update(info: WebShellUnavailableModelTooltipInfo): void;
  dispose(): void;
}

/**
 * Synchronous, keep referentially stable. Return null/undefined to fall back
 * to `model.tooltip` or no hint.
 */
export type WebShellUnavailableModelTooltipMount = (
  container: HTMLElement,
  info: WebShellUnavailableModelTooltipInfo,
) => WebShellUnavailableModelTooltipHandle | null | undefined;
