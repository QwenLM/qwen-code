/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../../config/config.js';
import type { ArtifactHostConfig } from './publisher.js';
import { createArtifactPublisher } from './create-publisher.js';
import { LocalPublisher } from './local-publisher.js';
import { HostPublisher } from './host-publisher.js';

const cfg = (kind: 'local' | 'host', host?: ArtifactHostConfig): Config =>
  ({
    getArtifactPublisherKind: () => kind,
    getArtifactHostConfig: () => host,
  }) as unknown as Config;

describe('createArtifactPublisher', () => {
  it('returns LocalPublisher for the local kind', () => {
    expect(createArtifactPublisher(cfg('local'))).toBeInstanceOf(
      LocalPublisher,
    );
  });

  it('returns HostPublisher for the host kind', () => {
    const pub = createArtifactPublisher(
      cfg('host', {
        uploadCommand: 'up {file}',
        urlTemplate: 'https://h/{key}',
      }),
    );
    expect(pub).toBeInstanceOf(HostPublisher);
  });

  it('returns HostPublisher even when host config is missing (defers to publish-time error)', () => {
    expect(createArtifactPublisher(cfg('host'))).toBeInstanceOf(HostPublisher);
  });
});
