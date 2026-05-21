import { useState } from 'react';
import type { ACPToolCall } from '../../../adapters/types';
import { ToolStatus } from './ToolStatus';
import { parseAnsi, hasAnsi } from '../../../utils/ansi';

interface BashToolProps {
  tool: ACPToolCall;
}

const MAX_LINES_COLLAPSED = 15;

export function BashTool({ tool }: BashToolProps) {
  const command = (tool.args?.command as string) || '';
  const description = (tool.args?.description as string) || '';
  const output = extractOutput(tool);
  const elapsed =
    tool.startTime && tool.endTime ? tool.endTime - tool.startTime : undefined;
  const lines = output.split('\n');
  const isLong = lines.length > MAX_LINES_COLLAPSED;
  const [expanded, setExpanded] = useState(false);

  const displayOutput =
    isLong && !expanded
      ? lines.slice(0, MAX_LINES_COLLAPSED).join('\n')
      : output;

  return (
    <div className="tool-bash">
      <ToolStatus status={tool.status} toolName="Bash" elapsed={elapsed} />
      {description && (
        <div className="tool-bash-description">{description}</div>
      )}
      {command && (
        <div className="tool-bash-command">
          <span className="tool-bash-prompt">$</span>
          <code>{command}</code>
        </div>
      )}
      {output && tool.status !== 'pending' && (
        <div className="tool-bash-output">
          <pre>
            {hasAnsi(displayOutput)
              ? parseAnsi(displayOutput).map((seg, i) => (
                  <span
                    key={i}
                    style={{
                      color: seg.color,
                      fontWeight: seg.bold ? 'bold' : undefined,
                      opacity: seg.dim ? 0.6 : undefined,
                    }}
                  >
                    {seg.text}
                  </span>
                ))
              : displayOutput}
          </pre>
          {isLong && (
            <button
              className="tool-expand-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '▲ Collapse' : `▼ Show all (${lines.length} lines)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function extractOutput(tool: ACPToolCall): string {
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.output === 'string') return raw.output;
    if (typeof raw.stdout === 'string') return raw.stdout;
  }
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
