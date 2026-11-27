/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadCliRuntimeHelpers } from '@qwen-code/cli';
import {
  SettingsService,
  type SettingsSchema,
  type SettingsSchemaDefaults,
  type SettingsSchemaType,
} from '@qwen-code/resource';

// Shared per defaults object so every service reuses one compiled validator.
const schemas = new WeakMap<SettingsSchemaDefaults, SettingsSchema>();

/** Usage statistics are opt-in: the open-source build sends nothing by default. */
export class QwenSettingsService extends SettingsService {
  override getSchema(defaults: SettingsSchemaDefaults): SettingsSchema {
    let schema = schemas.get(defaults);
    if (!schema) {
      const base = super.getSchema(defaults) as SettingsSchemaType;
      const { privacy } = base;
      schema = {
        ...base,
        privacy: {
          ...privacy,
          properties: {
            ...privacy.properties,
            usageStatisticsEnabled: {
              ...privacy.properties.usageStatisticsEnabled,
              default: false,
            },
          },
        },
      };
      schemas.set(defaults, schema);
    }
    return schema;
  }
}

export async function prepareQwenSettings(): Promise<() => void> {
  const { AppFramework } = await loadCliRuntimeHelpers();
  return AppFramework.setSettingsServiceFactory(
    () => new QwenSettingsService(),
  );
}
