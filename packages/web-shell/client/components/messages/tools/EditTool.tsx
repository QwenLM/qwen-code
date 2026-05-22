import { useState } from 'react';
import type { ACPToolCall } from '../../../adapters/types';
import { ToolStatus } from './ToolStatus';
import { DiffView } from './DiffView';
import styles from './LegacyTool.module.css';

interface EditToolProps {
  tool: ACPToolCall;
}

export function EditTool({ tool }: EditToolProps) {
  const filePath = (tool.args?.file_path as string) || '';
  const elapsed =
    tool.startTime && tool.endTime ? tool.endTime - tool.startTime : undefined;
  const diff = extractDiff(tool);
  const [expanded, setExpanded] = useState(true);

  const location = tool.locations?.[0];
  const locationStr = location
    ? `${location.file}${location.line ? `:${location.line}` : ''}`
    : filePath;

  return (
    <div className={styles.tool}>
      <div className={styles.editHeader} onClick={() => setExpanded(!expanded)}>
        <ToolStatus status={tool.status} toolName="Edit" elapsed={elapsed} />
        {locationStr && (
          <div className={styles.editFile}>
            <code>{locationStr}</code>
          </div>
        )}
        {diff && (
          <span className={styles.editToggle}>{expanded ? '▼' : '▶'}</span>
        )}
      </div>
      {diff && expanded && <DiffView diff={diff} />}
    </div>
  );
}

function extractDiff(tool: ACPToolCall): string {
  // Check for diff content blocks first (ACP ToolCallContent type: 'diff')
  if (tool.content) {
    const diffBlock = tool.content.find((b) => b.type === 'diff');
    if (diffBlock && diffBlock.type === 'diff') {
      return buildUnifiedDiff(diffBlock.oldText || '', diffBlock.newText);
    }
    // Fallback: text content
    const text = tool.content
      .filter((b) => b.type === 'content')
      .map((b) => b.content?.text || '')
      .join('\n');
    if (text) return text;
  }
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.fileDiff === 'string') return raw.fileDiff;
  }
  return '';
}

function buildUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [];

  let i = 0,
    j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      result.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (
      j < newLines.length &&
      (i >= oldLines.length || oldLines[i] !== newLines[j])
    ) {
      result.push(`+${newLines[j]}`);
      j++;
    } else {
      result.push(`-${oldLines[i]}`);
      i++;
    }
  }

  return result.join('\n');
}
