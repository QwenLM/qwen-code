import { describe, expect, it } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  canOpenWorkspaceArtifact,
  getArtifactFormatIcon,
  getArtifactPreviewContent,
  getFileChangePreviewContent,
  getWorkspaceArtifactOpenBlockReason,
  isDownloadableReviewFilePath,
  isRenderedFilePath,
  TURN_OUTPUT_VISIBLE_LIMIT,
  visibleTurnOutputs,
  type TurnOutputFileChange,
} from './TurnOutputs';
import {
  FileAudioIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  LinkIcon,
  NotebookTabsIcon,
} from 'lucide-react';

describe('TurnOutputs helpers', () => {
  it('caps collapsed turn outputs at three items', () => {
    const items = [1, 2, 3, 4, 5];
    expect(visibleTurnOutputs(items, false)).toEqual([1, 2, 3]);
    expect(visibleTurnOutputs(items, true)).toEqual(items);
    expect(TURN_OUTPUT_VISIBLE_LIMIT).toBe(3);
    expect(items.length - TURN_OUTPUT_VISIBLE_LIMIT).toBe(2);
  });

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

  it('enables review previews for rendered documents and raster images', () => {
    expect(isRenderedFilePath('REPORT.HTML')).toBe(true);
    expect(isRenderedFilePath('notes.markdown')).toBe(true);
    expect(isRenderedFilePath('screenshots/result.PNG')).toBe(true);
    expect(isRenderedFilePath('diagram.svg')).toBe(false);
    expect(isRenderedFilePath('source.ts')).toBe(false);
  });

  it('enables review downloads for HTML and Markdown files', () => {
    expect(isDownloadableReviewFilePath('REPORT.HTML')).toBe(true);
    expect(isDownloadableReviewFilePath('notes.markdown')).toBe(true);
    expect(isDownloadableReviewFilePath('screenshots/result.PNG')).toBe(false);
    expect(isDownloadableReviewFilePath('source.ts')).toBe(false);
  });

  it.each([
    ['file', FileIcon],
    ['link', LinkIcon],
    ['html', FileCode2Icon],
    ['image', FileImageIcon],
    ['video', FileVideoIcon],
    ['audio', FileAudioIcon],
    ['pdf', FileTextIcon],
    ['notebook', NotebookTabsIcon],
    ['document', FileTextIcon],
  ])('selects the Lucide icon for %s artifacts', (kind, icon) => {
    expect(getArtifactFormatIcon(kind)).toBe(icon);
  });

  it('uses the existing document icon for unsupported artifact kinds', () => {
    expect(getArtifactFormatIcon('other')).toBeUndefined();
    expect(getArtifactFormatIcon('future-format')).toBeUndefined();
  });

  it('disables opening missing workspace artifacts and names the recorded path', () => {
    const missing = {
      id: 'missing-1',
      kind: 'file',
      storage: 'workspace',
      status: 'missing',
      title: 'Missing report',
      workspacePath: 'w/agent/report.csv',
    } as DaemonSessionArtifact;
    const available = {
      ...missing,
      id: 'available-1',
      status: 'available',
      workspacePath: 'report.csv',
    } as DaemonSessionArtifact;
    const t = (key: string, vars?: Record<string, string | number>) =>
      key === 'turnOutputs.artifactUnavailable' && vars?.path
        ? `File not found in the workspace · ${vars.path}`
        : key;

    expect(canOpenWorkspaceArtifact(missing)).toBe(false);
    expect(canOpenWorkspaceArtifact(available)).toBe(true);
    expect(
      canOpenWorkspaceArtifact({
        ...missing,
        status: 'blocked',
      } as DaemonSessionArtifact),
    ).toBe(false);
    expect(getWorkspaceArtifactOpenBlockReason(missing, t)).toBe(
      'File not found in the workspace · w/agent/report.csv',
    );
    expect(getWorkspaceArtifactOpenBlockReason(available, t)).toBeUndefined();
  });

  it('names a missing workspace artifact even without a recorded path', () => {
    const missing = {
      id: 'missing-2',
      kind: 'file',
      storage: 'workspace',
      status: 'missing',
      title: 'Legacy missing',
    } as DaemonSessionArtifact;
    const t = (key: string) =>
      key === 'turnOutputs.artifactMissing'
        ? 'File not found in the workspace'
        : key;

    expect(canOpenWorkspaceArtifact(missing)).toBe(false);
    expect(getWorkspaceArtifactOpenBlockReason(missing, t)).toBe(
      'File not found in the workspace',
    );
  });
});
