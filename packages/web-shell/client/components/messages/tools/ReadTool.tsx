import type { ACPToolCall } from '../../../adapters/types';
import { ToolStatus } from './ToolStatus';

interface ReadToolProps {
  tool: ACPToolCall;
}

export function ReadTool({ tool }: ReadToolProps) {
  const filePath = (tool.args?.file_path as string) || '';
  const elapsed =
    tool.startTime && tool.endTime ? tool.endTime - tool.startTime : undefined;
  const content = extractContent(tool);

  return (
    <div className="tool-read">
      <ToolStatus status={tool.status} toolName="Read" elapsed={elapsed} />
      {filePath && (
        <div className="tool-read-file">
          <span className="tool-read-file-icon">📖</span>
          <code>{filePath}</code>
        </div>
      )}
      {content && (
        <div className="tool-read-content">
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
