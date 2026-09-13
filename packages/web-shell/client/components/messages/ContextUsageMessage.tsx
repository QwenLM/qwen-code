import type { ReactNode } from 'react';
import type {
  DaemonContextMemoryDetail,
  DaemonContextSkillDetail,
  DaemonContextToolDetail,
  DaemonSessionContextUsageStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { getContextUsageLevel } from '../../utils/contextUsage';
import { formatContextTokens as formatTokens } from '../../utils/formatTokenCount';
import styles from './ContextUsageMessage.module.css';

const SENTINEL = 'web-shell:context-usage:v1:';
const FILLED = '\u2588';
const BUFFER = '\u2592';
const EMPTY = '\u2591';

export function serializeContextUsageMessage(
  status: DaemonSessionContextUsageStatus,
): string {
  return `${SENTINEL}${JSON.stringify(status)}`;
}

export function parseContextUsageMessage(
  content: string,
): DaemonSessionContextUsageStatus | null {
  if (!content.startsWith(SENTINEL)) return null;
  try {
    const parsed = JSON.parse(content.slice(SENTINEL.length));
    if (!parsed?.usage || typeof parsed.usage.totalTokens !== 'number') {
      return null;
    }
    return parsed as DaemonSessionContextUsageStatus;
  } catch {
    return null;
  }
}

function formatPercentage(tokens: number, contextWindowSize: number): string {
  if (contextWindowSize <= 0) return '0.0';
  const percentage = (tokens / contextWindowSize) * 100;
  if (percentage > 100) return '>100';
  return percentage.toFixed(1);
}

function sortByTokens<T extends { tokens: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.tokens - a.tokens);
}

function ProgressBar({
  usedPercentage,
  bufferPercentage,
}: {
  usedPercentage: number;
  bufferPercentage: number;
}) {
  const usedLevel = getContextUsageLevel(usedPercentage);
  const usedCount = Math.min(usedPercentage, 100);
  const bufferCount = Math.min(
    bufferPercentage,
    Math.max(0, 100 - usedPercentage),
  );
  const freeCount = Math.max(0, 100 - usedCount - bufferCount);

  const usedColor =
    usedLevel === 'error'
      ? 'var(--error-color)'
      : usedLevel === 'warning'
        ? 'var(--warning-color)'
        : 'var(--agent-blue-500)';
  return (
    <div
      className={styles.progress}
      data-web-shell-context-meter
      aria-hidden="true"
    >
      <span style={{ width: `${usedCount}%`, background: usedColor }} />
      <span
        style={{
          width: `${freeCount}%`,
          background: 'var(--muted-foreground)',
          opacity: 0.25,
        }}
      />
      <span
        style={{
          width: `${bufferCount}%`,
          background: 'var(--warning-color)',
          opacity: 0.45,
        }}
      />
    </div>
  );
}

function CategoryRow({
  symbol,
  label,
  tokens,
  tokenLabel,
  contextWindowSize,
  symbolClassName = styles.secondary,
  isOverLimit,
}: {
  symbol: string;
  label: string;
  tokens: number;
  tokenLabel: string;
  contextWindowSize: number;
  symbolClassName?: string;
  isOverLimit?: boolean;
}) {
  return (
    <div className={styles.row}>
      <span className={`${styles.symbol} ${symbolClassName}`}>{symbol}</span>
      <span className={styles.label}>{label}</span>
      <span
        className={`${styles.value}${isOverLimit ? ` ${styles.error}` : ''}`}
      >
        {formatTokens(tokens)} {tokenLabel} (
        {formatPercentage(tokens, contextWindowSize)}%)
      </span>
    </div>
  );
}

function DetailHint({
  hint,
  onShowDetail,
}: {
  hint: string;
  onShowDetail?: () => void;
}) {
  const { t } = useI18n();
  return onShowDetail ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={styles.detailCommand}
      onClick={onShowDetail}
    >
      {t('contextUsage.viewDetails')}
    </Button>
  ) : (
    <div className={styles.hint}>{hint}</div>
  );
}

function DetailRow({
  name,
  tokens,
  tokenLabel,
}: {
  name: string;
  tokens: number;
  tokenLabel: string;
}) {
  return (
    <div className={styles.detailRow}>
      <span className={styles.secondary}>{'\u2514'} </span>
      <span className={styles.detailName} title={name}>
        {name}
      </span>
      <span className={styles.value}>
        {formatTokens(tokens)} {tokenLabel}
      </span>
    </div>
  );
}

function DetailGroup({
  title,
  count,
  compact,
  children,
}: {
  title: string;
  count: number;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <details className={styles.disclosure} open={!compact}>
      <summary className={styles.detailSummary}>
        {title} <span className={styles.secondary}>({count})</span>
      </summary>
      <div className={styles.detailSection}>{children}</div>
    </details>
  );
}

function DetailSection({
  title,
  items,
  getName,
  tokenLabel,
  compact,
}: {
  title: string;
  items: readonly (DaemonContextToolDetail | DaemonContextMemoryDetail)[];
  getName: (
    item: DaemonContextToolDetail | DaemonContextMemoryDetail,
  ) => string;
  tokenLabel: string;
  compact: boolean;
}) {
  const sorted = sortByTokens(items);
  if (sorted.length === 0) return null;
  return (
    <DetailGroup title={title} count={sorted.length} compact={compact}>
      {sorted.map((item) => (
        <DetailRow
          key={getName(item)}
          name={getName(item)}
          tokens={item.tokens}
          tokenLabel={tokenLabel}
        />
      ))}
    </DetailGroup>
  );
}

function SkillsSection({
  skills,
  labels,
  compact,
}: {
  skills: readonly DaemonContextSkillDetail[];
  labels: {
    active: string;
    bodyLoaded: string;
    skills: string;
    tokens: string;
  };
  compact: boolean;
}) {
  const sorted = [...skills].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return b.tokens + (b.bodyTokens ?? 0) - (a.tokens + (a.bodyTokens ?? 0));
  });
  if (sorted.length === 0) return null;

  return (
    <DetailGroup title={labels.skills} count={sorted.length} compact={compact}>
      {sorted.map((skill) => (
        <div key={skill.name} className={styles.skillBlock}>
          <div className={styles.detailRow}>
            <span className={styles.secondary}>{'\u2514'} </span>
            <span className={styles.detailName} title={skill.name}>
              {skill.name}
              {skill.loaded && (
                <span className={styles.success}> {labels.active}</span>
              )}
            </span>
            <span className={styles.value}>
              {formatTokens(skill.tokens)} {labels.tokens}
            </span>
          </div>
          {skill.loaded && skill.bodyTokens != null && skill.bodyTokens > 0 && (
            <div className={styles.subDetailRow}>
              <span className={styles.secondary}>{'  \u2514'} </span>
              <span className={styles.bodyLoaded}>{labels.bodyLoaded}</span>
              <span className={styles.success}>
                +{formatTokens(skill.bodyTokens)} {labels.tokens}
              </span>
            </div>
          )}
        </div>
      ))}
    </DetailGroup>
  );
}

export function ContextUsageMessage({
  status,
  onShowDetail,
  compact = false,
}: {
  status: DaemonSessionContextUsageStatus;
  /** Run /context detail, exactly like typing it. */
  onShowDetail?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { usage } = status;
  const { breakdown, contextWindowSize } = usage;
  const hasTokenCount = usage.totalTokens > 0;
  const percentage =
    contextWindowSize > 0 ? (usage.totalTokens / contextWindowSize) * 100 : 0;
  const isOverLimit = percentage > 100;
  const bufferPercentage =
    contextWindowSize > 0
      ? (breakdown.autocompactBuffer / contextWindowSize) * 100
      : 0;

  return (
    <section
      className={`${styles.panel}${compact ? ` ${styles.compact}` : ''}`}
      role={compact ? undefined : 'group'}
      aria-label={compact ? undefined : t('contextUsage.title')}
    >
      {!compact && (
        <div className={styles.header}>
          <div className={styles.title}>{t('contextUsage.title')}</div>
          {hasTokenCount && (
            <span
              className={styles.percentage}
              data-level={getContextUsageLevel(percentage)}
            >
              {percentage.toFixed(1)}%
            </span>
          )}
        </div>
      )}

      {!hasTokenCount ? (
        <>
          <div className={styles.estimateHint}>
            {t('contextUsage.noApiResponse')}
          </div>
          <div className={styles.sectionTitle}>
            {t('contextUsage.estimatedOverhead')}
          </div>
          <div className={styles.metaLine}>
            <span>
              {t('contextUsage.model')}: {usage.modelName}
            </span>
            <span>
              {t('contextUsage.contextWindow')}:{' '}
              {formatTokens(contextWindowSize)} {t('contextUsage.tokens')}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className={styles.metaLine}>
            <span>
              {t('contextUsage.model')}: {usage.modelName}
            </span>
            <span>
              {t('contextUsage.contextWindow')}:{' '}
              {formatTokens(contextWindowSize)} {t('contextUsage.tokens')}
            </span>
          </div>
          {usage.isEstimated && (
            <div className={styles.estimateHint}>
              {t('contextUsage.estimatedUntilProviderUsage')}
            </div>
          )}
          {isOverLimit && (
            <div className={styles.error}>{t('contextUsage.overLimit')}</div>
          )}

          <ProgressBar
            usedPercentage={Math.min(percentage, 100)}
            bufferPercentage={bufferPercentage}
          />
          <div className={styles.spacer} />
          <CategoryRow
            symbol={FILLED}
            label={t('contextUsage.used')}
            tokens={usage.totalTokens}
            tokenLabel={t('contextUsage.tokens')}
            contextWindowSize={contextWindowSize}
            symbolClassName={isOverLimit ? styles.error : styles.accent}
            isOverLimit={isOverLimit}
          />
          <CategoryRow
            symbol={EMPTY}
            label={t('contextUsage.free')}
            tokens={breakdown.freeSpace}
            tokenLabel={t('contextUsage.tokens')}
            contextWindowSize={contextWindowSize}
          />
          <CategoryRow
            symbol={BUFFER}
            label={t('contextUsage.autocompactBuffer')}
            tokens={breakdown.autocompactBuffer}
            tokenLabel={t('contextUsage.tokens')}
            contextWindowSize={contextWindowSize}
            symbolClassName={styles.warning}
          />
          <div className={styles.spacer} />
          <div className={styles.sectionTitle}>
            {t('contextUsage.usageByCategory')}
          </div>
        </>
      )}

      <CategoryRow
        symbol={FILLED}
        label={t('contextUsage.systemPrompt')}
        tokens={breakdown.systemPrompt}
        tokenLabel={t('contextUsage.tokens')}
        contextWindowSize={contextWindowSize}
        symbolClassName={styles.accent}
      />
      <CategoryRow
        symbol={FILLED}
        label={t('contextUsage.builtinTools')}
        tokens={breakdown.builtinTools}
        tokenLabel={t('contextUsage.tokens')}
        contextWindowSize={contextWindowSize}
        symbolClassName={styles.accent}
      />
      {breakdown.mcpTools > 0 && (
        <CategoryRow
          symbol={FILLED}
          label={t('contextUsage.mcpTools')}
          tokens={breakdown.mcpTools}
          tokenLabel={t('contextUsage.tokens')}
          contextWindowSize={contextWindowSize}
          symbolClassName={styles.accent}
        />
      )}
      <CategoryRow
        symbol={FILLED}
        label={t('contextUsage.memoryFiles')}
        tokens={breakdown.memoryFiles}
        tokenLabel={t('contextUsage.tokens')}
        contextWindowSize={contextWindowSize}
        symbolClassName={styles.accent}
      />
      <CategoryRow
        symbol={FILLED}
        label={t('contextUsage.skills')}
        tokens={breakdown.skills}
        tokenLabel={t('contextUsage.tokens')}
        contextWindowSize={contextWindowSize}
        symbolClassName={styles.accent}
      />
      {hasTokenCount && (
        <CategoryRow
          symbol={FILLED}
          label={t('contextUsage.messages')}
          tokens={breakdown.messages}
          tokenLabel={t('contextUsage.tokens')}
          contextWindowSize={contextWindowSize}
          symbolClassName={styles.accent}
        />
      )}

      {usage.showDetails ? (
        <>
          <DetailSection
            title={t('contextUsage.builtinTools')}
            items={usage.builtinTools}
            compact={compact}
            getName={(item) => ('name' in item ? item.name : item.path)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <DetailSection
            title={t('contextUsage.mcpTools')}
            items={usage.mcpTools}
            compact={compact}
            getName={(item) => ('name' in item ? item.name : item.path)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <DetailSection
            title={t('contextUsage.memoryFiles')}
            items={usage.memoryFiles}
            compact={compact}
            getName={(item) => ('path' in item ? item.path : item.name)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <SkillsSection
            skills={usage.skills}
            compact={compact}
            labels={{
              active: t('contextUsage.active'),
              bodyLoaded: t('contextUsage.bodyLoaded'),
              skills: t('contextUsage.skills'),
              tokens: t('contextUsage.tokens'),
            }}
          />
        </>
      ) : (
        <DetailHint
          hint={t('contextUsage.detailHint')}
          onShowDetail={onShowDetail}
        />
      )}
    </section>
  );
}
