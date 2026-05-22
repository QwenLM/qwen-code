import type { ACPToolCall } from '../../../adapters/types';
import { ToolStatus } from './ToolStatus';
import styles from './LegacyTool.module.css';

interface ReadToolProps {
  tool: ACPToolCall;
}

export function ReadTool({ tool }: ReadToolProps) {
  const filePath = (tool.args?.file_path as string) || '';
  const elapsed =
    tool.startTime && tool.endTime ? tool.endTime - tool.startTime : undefined;
  const content = extractContent(tool);

  return (
    <div className={styles.tool}>
      <ToolStatus status={tool.status} toolName="Read" elapsed={elapsed} />
      {filePath && (
        <div className={styles.file}>
          <span className={styles.fileIcon}>📖</span>
          <code>{filePath}</code>
        </div>
      )}
      {content && (
        <div className={styles.content}>
          <pre>{truncate(content, 30)}</pre>
        </div>
      )}
    </div>
  );
}

function extractContent(tool: ACPToolCall): string {
  if (tool.content) {
    return tool.content
      .map((b) => {
        if (b.type === 'content') return b.content?.text || '';
        if (b.type === 'terminal') return `[terminal: ${b.terminalId}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n... (${lines.length - maxLines} more lines)`
  );
}
