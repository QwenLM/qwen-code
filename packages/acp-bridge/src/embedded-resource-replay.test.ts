/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  MAX_RECORDED_EMBEDDED_RESOURCES,
  readDaemonNativeResourceIndexes,
  snapshotReplayableEmbeddedResources,
} from './embedded-resource-replay.js';
import { attachmentResourceUri } from './attachment-resource-uri.js';
import type { SessionAttachmentReference } from './sessionAttachments.js';

function textResource(uri: string, text: string): ContentBlock {
  return { type: 'resource', resource: { uri, text } };
}

function resourceReference(attachmentId: string): SessionAttachmentReference {
  return {
    type: 'resource',
    attachmentId,
    mimeType: 'text/plain',
    size: 1,
  };
}

describe('snapshotReplayableEmbeddedResources', () => {
  it('retains embedded text resources under the retention bounds', () => {
    const prompt = [
      textResource('context://example/a', 'alpha'),
      textResource('context://example/b', 'beta'),
    ];

    const snapshot = snapshotReplayableEmbeddedResources(prompt);

    expect(snapshot).toEqual({ resources: prompt, truncated: false });
    expect(snapshot.resources[0]).not.toBe(prompt[0]);
  });

  it('drops only the blocks that would exceed the byte budget', () => {
    const small = textResource('context://example/small', 'fits');
    const oversized = textResource(
      'context://example/oversized',
      'x'.repeat(256 * 1024),
    );
    const later = textResource('context://example/later', 'also fits');

    const snapshot = snapshotReplayableEmbeddedResources([
      small,
      oversized,
      later,
    ]);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.resources).toEqual([small, later]);
  });

  it('bounds the retained resource count', () => {
    const prompt = Array.from(
      { length: MAX_RECORDED_EMBEDDED_RESOURCES + 1 },
      () => textResource('context://example/tiny', ''),
    );

    const snapshot = snapshotReplayableEmbeddedResources(prompt);

    expect(snapshot.resources).toHaveLength(MAX_RECORDED_EMBEDDED_RESOURCES);
    expect(snapshot.truncated).toBe(true);
  });

  it('neither retains nor charges a resource with an empty URI', () => {
    const valid = textResource('context://ok', 'y'.repeat(100 * 1024));
    const prompt = [textResource('', 'x'.repeat(200 * 1024)), valid];

    const snapshot = snapshotReplayableEmbeddedResources(prompt);

    expect(snapshot).toEqual({ resources: [valid], truncated: false });
  });

  it('retains only text resources and skips blob resources without throwing', () => {
    const blobOnly: ContentBlock = {
      type: 'resource',
      resource: {
        uri: 'context://example/image',
        blob: 'QUJD',
        mimeType: 'image/png',
      },
    };
    expect(snapshotReplayableEmbeddedResources([blobOnly])).toEqual({
      resources: [],
      truncated: false,
    });

    const text = textResource('context://example/selection', 'kept');
    const snapshot = snapshotReplayableEmbeddedResources([blobOnly, text]);
    expect(snapshot).toEqual({ resources: [text], truncated: false });
  });

  it('skips malformed blocks without throwing and keeps valid siblings', () => {
    const valid = textResource('context://example/valid', 'kept');
    const prompt = [
      null,
      { type: 'resource' },
      { type: 'resource', resource: null },
      { type: 'resource', resource: 5 },
      {
        type: 'resource',
        resource: { uri: 'context://example/numeric', text: 5 },
      },
      valid,
    ] as unknown as ContentBlock[];

    const snapshot = snapshotReplayableEmbeddedResources(prompt);

    expect(snapshot).toEqual({ resources: [valid], truncated: false });
  });

  it('exempts daemon-native positions from retention', () => {
    const direct = textResource('context://example/direct', 'direct');
    const prompt = [textResource('attachment:///notes.txt', 'native'), direct];

    const snapshot = snapshotReplayableEmbeddedResources(prompt, [0]);

    expect(snapshot).toEqual({ resources: [direct], truncated: false });
  });
});

describe('readDaemonNativeResourceIndexes', () => {
  it('skips malformed prompt blocks without throwing on the legacy path', () => {
    const references = [resourceReference('notes.txt')];
    const prompt = [
      null,
      { type: 'resource' },
      { type: 'resource', resource: null },
      textResource(attachmentResourceUri('notes.txt'), 'native'),
    ] as unknown as ContentBlock[];

    expect(
      readDaemonNativeResourceIndexes(undefined, prompt, references),
    ).toEqual([3]);
  });

  it('keeps ambiguous same-URI blocks on the legacy path', () => {
    const references = [resourceReference('notes.txt')];
    const prompt = [
      textResource(attachmentResourceUri('notes.txt'), 'native'),
      textResource(attachmentResourceUri('notes.txt'), 'direct'),
    ];

    expect(
      readDaemonNativeResourceIndexes(undefined, prompt, references),
    ).toEqual([]);
  });

  it('rejects malformed indexed blocks without throwing on the position path', () => {
    const references = [resourceReference('notes.txt')];
    const prompt = [
      null,
      textResource(attachmentResourceUri('notes.txt'), 'native'),
      { type: 'resource', resource: null },
    ] as unknown as ContentBlock[];

    expect(readDaemonNativeResourceIndexes([0], prompt, references)).toEqual(
      [],
    );
    expect(readDaemonNativeResourceIndexes([1], prompt, references)).toEqual([
      1,
    ]);
    expect(readDaemonNativeResourceIndexes([2], prompt, references)).toEqual(
      [],
    );
    expect(readDaemonNativeResourceIndexes([1, 0], prompt, references)).toEqual(
      [],
    );
  });

  it('validates large position metadata in linear time', () => {
    const count = 20_000;
    const references = Array.from({ length: count }, (_, index) =>
      resourceReference(`notes-${index}.txt`),
    );
    const prompt = references.map((reference) =>
      textResource(attachmentResourceUri(reference.attachmentId), ''),
    );
    const value = Array.from({ length: count }, (_, index) => index);

    expect(
      readDaemonNativeResourceIndexes(value, prompt, references),
    ).toHaveLength(count);
  });
});
