import { describe, expect, it } from 'vitest';
import type { DaemonSessionArtifactInput } from '@qwen-code/sdk/daemon';
import { readReportedArtifacts } from './reported-artifacts';

const exportedArtifact: DaemonSessionArtifactInput = {
  kind: 'file',
  storage: 'workspace',
  title: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
  workspacePath: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
  mimeType: 'text/markdown; charset=utf-8',
  sizeBytes: 42,
};

function slashCommandMeta(sessionArtifacts: unknown) {
  return { source: 'slash_command', sessionArtifacts };
}

describe('readReportedArtifacts', () => {
  // Each rejecting fixture carries exactly one defect and is otherwise a
  // valid export descriptor, so it isolates a single guard clause. The
  // accepted vocabulary comes from the producer: `exportCommand` emits
  // kind 'file' | 'html' with storage 'workspace'.
  it.each([
    { ...exportedArtifact, storage: 'published' },
    { ...exportedArtifact, kind: 'image' },
    { ...exportedArtifact, managedId: 'existing' },
  ])('drops a descriptor whose only defect is %s', (descriptor) => {
    expect(readReportedArtifacts(slashCommandMeta([descriptor]))).toEqual([]);
    expect(
      readReportedArtifacts(slashCommandMeta([exportedArtifact, descriptor])),
    ).toEqual([exportedArtifact]);
  });

  it('rebuilds the descriptor instead of forwarding transcript metadata', () => {
    // The projection is the only barrier between transcript-carried `_meta`
    // and the fields the daemon store honors, so fields the producer never
    // emits must not ride along.
    const descriptor = {
      ...exportedArtifact,
      description: 'model-authored summary',
      metadata: { 'qwen.workspace.sha256': 'forged' },
      retention: 'pinned',
      clientRetained: true,
    };
    expect(readReportedArtifacts(slashCommandMeta([descriptor]))).toEqual([
      exportedArtifact,
    ]);
  });
});
