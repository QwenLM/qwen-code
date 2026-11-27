/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export * from '../config/settings.js';
/** Test fixtures use the same initialized service as production. */
import { SettingsService } from '@qwen-code/resource';
import { createCliSettingsService } from '../config/createCliSettingsService.js';
import {
  getSettingsResolveOptions,
  type SettingSource,
} from '../config/settings.js';
export function loadSettings(
  cwd = process.cwd(),
  sources?: readonly SettingSource[],
  fileSources?: Pick<
    import('@qwen-code/resource').SettingsFileSources,
    'user'
  >,
) {
  if (fileSources && ('project' in fileSources || 'local' in fileSources)) {
    throw new Error('loadSettings test helper only supports a user file source');
  }
  const service = new SettingsService();
  if (fileSources?.user) {
    const original = service.getUserSettingsSource(fileSources.user.path);
    original.read = fileSources.user.read.bind(fileSources.user);
    original.invalidate = fileSources.user.invalidate.bind(fileSources.user);
  }
  createCliSettingsService({ service, environmentPolicy: 'session' });
  return service.resolve(getSettingsResolveOptions(cwd, sources));
}
export function loadSettingsWithService(
  cwd: string,
  service: import('@qwen-code/resource').SettingsService,
  sources?: readonly SettingSource[],
  flag?: string,
) {
  return service.resolve(getSettingsResolveOptions(cwd, sources, flag));
}
