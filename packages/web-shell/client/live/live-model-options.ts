/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonLiveSetupStatus } from '@qwen-code/sdk';

export interface LiveModelOption {
  /** What `experimental.liveVoice.model` is set to when this is picked. */
  value: string;
  label: string;
  /** False for a configured model that names no `realtimeOnly` route. */
  route: boolean;
}

/**
 * Choices for the Live Voice model picker, from the `realtimeOnly` routes the
 * daemon lists. An id is written bare unless two providers share it — a bare
 * id is then ambiguous to the daemon, so those are qualified `provider:id`.
 * The configured model is always present and selected, even when it names no
 * route (a hand-written id on the free-standing endpoint/key path).
 */
export function liveModelOptions(
  status: Pick<DaemonLiveSetupStatus, 'model' | 'models'>,
): { options: LiveModelOption[]; selected: string } {
  const routes = status.models ?? [];
  const idCounts = new Map<string, number>();
  for (const route of routes) {
    idCounts.set(route.id, (idCounts.get(route.id) ?? 0) + 1);
  }
  const options: LiveModelOption[] = routes.map((route) => {
    const shared = (idCounts.get(route.id) ?? 0) > 1;
    const name = route.name?.trim() || route.id;
    return {
      value: shared ? `${route.provider}:${route.id}` : route.id,
      label: shared ? `${name} · ${route.provider}` : name,
      route: true,
    };
  });
  // The setting may be qualified even when the id is unique.
  const current =
    options.find((option) => option.value === status.model) ??
    options[
      routes.findIndex(
        (route) => `${route.provider}:${route.id}` === status.model,
      )
    ];
  if (current) return { options, selected: current.value };
  return {
    options: [
      { value: status.model, label: status.model, route: false },
      ...options,
    ],
    selected: status.model,
  };
}
