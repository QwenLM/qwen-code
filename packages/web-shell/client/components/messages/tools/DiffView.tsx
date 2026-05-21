import { memo } from 'react';

interface DiffViewProps {
  diff: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
}

function parseDiff(diff: string): {
  lines: DiffLine[];
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  const lines: DiffLine[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+')) {
      additions++;
      lines.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      deletions++;
      lines.push({ type: 'del', content: line.slice(1) });
    } else {
      lines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  }

  return { lines, additions, deletions };
}

export const DiffView = memo(function DiffView({ diff }: DiffViewProps) {
  if (!diff) return null;

  const { lines, additions, deletions } = parseDiff(diff);

  return (
    <div className="diff-view">
      <div className="diff-stats">
        {additions > 0 && <span className="diff-stat-add">+{additions}</span>}
        {deletions > 0 && <span className="diff-stat-del">-{deletions}</span>}
      </div>
      <div className="diff-lines">
        {lines.map((line, i) => (
          <div key={i} className={`diff-line diff-line-${line.type}`}>
            <span className="diff-line-marker">
              {line.type === 'add'
                ? '+'
                : line.type === 'del'
                  ? '-'
                  : line.type === 'header'
                    ? ''
                    : ' '}
            </span>
            <span className="diff-line-content">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
