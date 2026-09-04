import { memo } from 'react';
import { parseUnifiedDiff } from '../../../utils/unifiedDiff';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
}

export const DiffView = memo(function DiffView({ diff }: DiffViewProps) {
  if (!diff) return null;

  const { lines, additions, deletions } = parseUnifiedDiff(diff);

  return (
    <div className={styles.view}>
      <div className={styles.stats}>
        {additions > 0 && <span className={styles.statAdd}>+{additions}</span>}
        {deletions > 0 && <span className={styles.statDel}>-{deletions}</span>}
      </div>
      <div className={styles.lines}>
        {lines.map((line, i) => (
          <div
            key={i}
            className={`${styles.line} ${styles[`line${line.type[0].toUpperCase()}${line.type.slice(1)}`]}`}
          >
            <span className={styles.lineNo}>
              {line.type === 'header' ? '' : (line.oldLine ?? line.newLine)}
            </span>
            <span className={styles.marker}>
              {line.type === 'add'
                ? '+'
                : line.type === 'del'
                  ? '-'
                  : line.type === 'header'
                    ? ''
                    : ' '}
            </span>
            <span className={styles.content}>{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
