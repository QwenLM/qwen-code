import type { ACPToolCall } from '../../../adapters/types';
import { ToolStatus } from './ToolStatus';

interface GenericToolProps {
  tool: ACPToolCall;
}

export function GenericTool({ tool }: GenericToolProps) {
  const elapsed =
    tool.startTime && tool.endTime ? tool.endTime - tool.startTime : undefined;
  const output = extractOutput(tool);

  return (
    <div className="tool-generic">
      <ToolStatus
        status={tool.status}
        toolName={tool.toolName}
        elapsed={elapsed}
      />
      {tool.args &&
        Object.keys(tool.args).length > 0 &&
        tool.status !== 'completed' && (
          <div className="tool-generic-args">
            <pre>{JSON.stringify(tool.args, null, 2)}</pre>
          </div>
        )}
      {output && (
        <div className="tool-generic-output">
          <pre>{output}</pre>
        </div>
      )}
    </div>
  );
}

function extractOutput(tool: ACPToolCall): string {
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
