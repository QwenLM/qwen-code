/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { ArtifactPublisher } from './publisher.js';
import { LocalPublisher } from './local-publisher.js';
import { HostPublisher } from './host-publisher.js';
import { OssPublisher } from './oss-publisher.js';

/**
 * Selects the artifact publisher from config: `oss` (native Aliyun OSS),
 * `host` (upload via a user command), or `local` (file:// on disk, the
 * default). A misconfigured `host`/`oss` selection still
 * returns the publisher, which throws an actionable error at publish time
 * rather than silently falling back.
 */
export function createArtifactPublisher(config: Config): ArtifactPublisher {
  const kind = config.getArtifactPublisherKind();
  switch (kind) {
    case 'host':
      return new HostPublisher(
        config.getArtifactHostConfig() ?? {
          uploadCommand: '',
          urlTemplate: '',
        },
      );
    case 'oss':
      return new OssPublisher(
        config.getArtifactOssConfig() ?? { bucket: '', endpoint: '' },
      );
    case 'local':
      return new LocalPublisher();
    default: {
      const unknown: never = kind;
      throw new Error(`Unknown artifact publisher kind: ${unknown}`);
    }
  }
}
