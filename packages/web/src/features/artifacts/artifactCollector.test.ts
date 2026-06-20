import { describe, expect, it } from 'vitest';
import type { DaemonToolTranscriptBlock } from '@qwen-code/webui/daemon-react-sdk';
import { collectArtifactsFromTranscript } from './artifactCollector';

function toolBlock(
  overrides: Partial<DaemonToolTranscriptBlock>,
): DaemonToolTranscriptBlock {
  const updatedAt = overrides.updatedAt ?? 1000;
  return {
    id: overrides.id ?? `tool-${updatedAt}`,
    kind: 'tool',
    toolCallId: overrides.toolCallId ?? `call-${updatedAt}`,
    title: overrides.title ?? 'Read',
    status: overrides.status ?? 'completed',
    preview: overrides.preview ?? { kind: 'generic' },
    clientReceivedAt: overrides.clientReceivedAt ?? updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
    ...overrides,
  };
}

describe('collectArtifactsFromTranscript', () => {
  it('normalizes workspace paths and merges read/write activity', () => {
    const artifacts = collectArtifactsFromTranscript(
      [
        toolBlock({
          id: 'read-app',
          title: 'Read file',
          toolName: 'Read',
          rawInput: { file_path: '/repo/packages/web/src/App.tsx' },
          updatedAt: 100,
        }),
        toolBlock({
          id: 'edit-app',
          title: 'Edit file',
          toolName: 'Edit',
          rawInput: { file_path: '/repo/packages/web/src/App.tsx' },
          updatedAt: 200,
        }),
      ],
      { workspaceCwd: '/repo' },
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        path: 'packages/web/src/App.tsx',
        operation: 'modified',
        readCount: 1,
        writeCount: 1,
        updatedAt: 200,
      }),
    ]);
  });

  it('collects preview locations and ignores unsafe path-like strings', () => {
    const artifacts = collectArtifactsFromTranscript([
      toolBlock({
        title: 'Glob results',
        toolName: 'Glob',
        locations: [
          'packages/web/src/styles.css',
          'https://example.test/file.ts',
        ],
        rawInput: {
          file: '../outside.ts',
          output: 'packages/web/src/App.tsx',
        },
        updatedAt: 100,
      }),
    ]);

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      'packages/web/src/styles.css',
      'packages/web/src/App.tsx',
    ]);
    expect(artifacts.every((artifact) => artifact.operation === 'read')).toBe(
      true,
    );
  });
});
