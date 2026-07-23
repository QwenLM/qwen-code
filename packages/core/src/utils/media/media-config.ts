/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import {
  DEFAULT_MEDIA_DECISION_POLICY,
  type MediaDecisionPolicy,
} from './decision-policy.js';
import type { ReaderBackendSpec } from './reader-registry.js';

/**
 * Config surface for the media layer (Pattern D · config-controlled plugins).
 * Every field has a default so the first version runs with nothing configured
 * (native reader only). Swapping a reader model is a `readers[].model` edit;
 * flipping a decision owner is a `decisionPolicy` edit — core does not move.
 */

export type NativeReaderDecl = { id: string; kind: 'native' };
export type DelegatedReaderDecl = { kind: 'delegated' } & ReaderBackendSpec;
export type ReaderDecl = NativeReaderDecl | DelegatedReaderDecl;

export interface MediaInjectionConfig {
  /** How push-injected media enters the model (Seam B, plugin). */
  mode: 'summary-first' | 'bytes-first' | 'path-only';
}

export interface MediaUploadConfig {
  /** Upload backend KIND selector (deployment params come from env). */
  backend?: string;
  bucket?: string;
}

export interface MediaConfig {
  readers: ReaderDecl[];
  decisionPolicy: MediaDecisionPolicy;
  injection: MediaInjectionConfig;
  upload?: MediaUploadConfig;
}

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  readers: [{ id: 'native-inline', kind: 'native' }],
  decisionPolicy: DEFAULT_MEDIA_DECISION_POLICY,
  injection: { mode: 'summary-first' },
};

/**
 * Resolve the effective media config: user overrides merged over defaults.
 * Reads from `config.getMediaConfig()` when present; otherwise defaults apply,
 * keeping the layer fully functional with zero configuration.
 */
export function resolveMediaConfig(config: Config): MediaConfig {
  const user = config.getMediaConfig();
  if (!user) return DEFAULT_MEDIA_CONFIG;
  return {
    readers:
      user.readers && user.readers.length > 0
        ? user.readers
        : DEFAULT_MEDIA_CONFIG.readers,
    decisionPolicy: {
      ...DEFAULT_MEDIA_CONFIG.decisionPolicy,
      ...(user.decisionPolicy ?? {}),
    },
    injection: user.injection ?? DEFAULT_MEDIA_CONFIG.injection,
    upload: user.upload,
  };
}
