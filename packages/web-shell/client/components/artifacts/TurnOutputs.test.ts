import { describe, expect, it } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  getArtifactPreviewContent,
  getFileChangePreviewContent,
  isRenderedFilePath,
  type TurnOutputFileChange,
} from './TurnOutputs';

describe('TurnOutputs helpers', () => {
  it('uses workspace cwd when matching artifact preview content', () => {
    const artifact = {
      id: 'artifact-1',
      kind: 'html',
      workspacePath: 'reports/summary.html',
    } as DaemonSessionArtifact;
    const changes: TurnOutputFileChange[] = [
      {
        path: '/workspace/project/reports/summary.html',
        status: 'modified',
        toolCallId: 'tool-1',
        isArtifact: true,
        diffs: [
          {
            oldText: '<html>old</html>',
            newText: '<html>new</html>',
            fullContent: true,
          },
        ],
      },
    ];

    expect(
      getArtifactPreviewContent(artifact, changes, '/workspace/project'),
    ).toBe('<html>new</html>');
  });

  it('uses changed Markdown content for artifact previews', () => {
    const artifact = {
      id: 'artifact-1',
      kind: 'file',
      workspacePath: 'notes.md',
    } as DaemonSessionArtifact;
    const change: TurnOutputFileChange = {
      path: '/workspace/project/notes.md',
      status: 'modified',
      toolCallId: 'tool-1',
      isArtifact: true,
      diffs: [
        {
          oldText: '# Old',
          newText: '# New',
          fullContent: true,
        },
      ],
    };

    expect(
      getArtifactPreviewContent(artifact, [change], '/workspace/project'),
    ).toBe('# New');
  });

  it('uses the latest full file content for review previews', () => {
    const change: TurnOutputFileChange = {
      path: 'report.html',
      status: 'modified',
      toolCallId: 'tool-1',
      isArtifact: false,
      diffs: [
        { oldText: 'old', newText: 'first', fullContent: true },
        { oldText: 'first', newText: 'partial' },
        { oldText: 'partial', newText: 'latest', fullContent: true },
      ],
    };

    expect(getFileChangePreviewContent(change)).toBe('latest');
  });

  it('limits rendered review previews to HTML and Markdown files', () => {
    expect(isRenderedFilePath('REPORT.HTML')).toBe(true);
    expect(isRenderedFilePath('notes.markdown')).toBe(true);
    expect(isRenderedFilePath('source.ts')).toBe(false);
  });
});
