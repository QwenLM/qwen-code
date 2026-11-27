/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import type { Config } from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { useInstalledPluginItems } from './useInstalledPluginItems.js';
import { useInstalledPluginsController } from './useInstalledPluginsController.js';
import { buildInstalledPluginPresentation } from './installedPluginPresentation.js';
import { InstalledPluginsView } from './InstalledPluginsView.js';

export interface ManagePluginsProps {
  config: Config | null;
  settings: LoadedSettings;
  onClose: () => void;
  /** Callback invoked after any plugin operation (toggle/uninstall). */
  onPluginsChanged?: () => void;
  /** Incremented when plugins change; triggers recomputation. */
  refreshKey?: number;
  /** Pre-target a specific plugin by name (e.g. from /plugins enable <name>). */
  targetPlugin?: string;
  /** Action to auto-execute on the target plugin. */
  targetAction?: 'enable' | 'disable' | 'uninstall';
}

export function ManagePlugins(props: ManagePluginsProps): React.JSX.Element {
  const items = useInstalledPluginItems(props);
  const presentation = useMemo(
    () =>
      new Map(
        items.map((item) => [item.id, buildInstalledPluginPresentation(item)]),
      ),
    [items],
  );
  const controller = useInstalledPluginsController(props, items, presentation);
  return <InstalledPluginsView controller={controller} />;
}
