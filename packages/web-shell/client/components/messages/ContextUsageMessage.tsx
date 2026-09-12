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
  label,
  tokens,
  contextWindowSize,
  symbolClassName = styles.secondary,
  isOverLimit,
  children,
  compact = false,
}: {
  label: string;
  tokens: number;
  contextWindowSize: number;
  symbolClassName?: string;
  isOverLimit?: boolean;
  children?: ReactNode;
  compact?: boolean;
}) {
  const row = (
    <span className={styles.row}>
      <span
        className={`${styles.symbol} ${symbolClassName}`}
        aria-hidden="true"
      />
      <span className={styles.label}>{label}</span>{' '}
      <span
        className={`${styles.value}${isOverLimit ? ` ${styles.error}` : ''}`}
      >
        {formatTokens(tokens)}{' '}
        <span className={styles.ratio}>
          ({formatPercentage(tokens, contextWindowSize)}%)
        </span>
      </span>
    </span>
  );
  return children ? (
    <details className={styles.disclosure} open={!compact}>
      <summary className={styles.detailSummary}>{row}</summary>
      <div className={styles.detailSection}>{children}</div>
    </details>
  ) : (
    row
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

function DetailSection({
  items,
  getName,
  tokenLabel,
}: {
  items: readonly (DaemonContextToolDetail | DaemonContextMemoryDetail)[];
  getName: (
    item: DaemonContextToolDetail | DaemonContextMemoryDetail,
  ) => string;
  tokenLabel: string;
}) {
  const sorted = sortByTokens(items);
  if (sorted.length === 0) return null;
  return (
    <>
      {sorted.map((item) => (
        <DetailRow
          key={getName(item)}
          name={getName(item)}
          tokens={item.tokens}
          tokenLabel={tokenLabel}
        />
      ))}
    </>
  );
}

function SkillsSection({
  skills,
  labels,
}: {
  skills: readonly DaemonContextSkillDetail[];
  labels: {
    active: string;
    bodyLoaded: string;
    tokens: string;
  };
}) {
  const sorted = [...skills].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return b.tokens + (b.bodyTokens ?? 0) - (a.tokens + (a.bodyTokens ?? 0));
  });
  if (sorted.length === 0) return null;

  return (
    <>
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
    </>
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

  const categoryProps = {
    contextWindowSize,
    compact,
    symbolClassName: styles.accent,
  };
  const hasDetails = usage.showDetails;

  return (
    <section
      className={`${styles.panel}${compact ? ` ${styles.compact}` : ''}`}
      role={compact ? undefined : 'group'}
      aria-label={compact ? undefined : t('contextUsage.title')}
    >
      {!compact && (
        <div className={styles.header}>
          <div className={styles.title}>{t('contextUsage.title')}</div>
          <span className={styles.secondary}>{t('contextUsage.snapshot')}</span>
        </div>
      )}
      <div className={styles.metaLine}>
        <span>
          {t('contextUsage.model')}: {usage.modelName}
        </span>
      </div>
      {!hasTokenCount ? (
        <>
          <div className={styles.estimateHint}>
            {t('contextUsage.noApiResponse')}
          </div>
          <div className={styles.sectionTitle}>
            {t('contextUsage.estimatedOverhead')}
          </div>
          <div className={styles.metaLine}>
            {t('contextUsage.contextWindow')}: {formatTokens(contextWindowSize)}{' '}
            {t('contextUsage.tokens')}
          </div>
        </>
      ) : (
        <>
          <div className={styles.overview}>
            <span className={styles.total}>
              <strong>{formatTokens(usage.totalTokens)}</strong>
              <span className={styles.secondary}>
                {' '}
                / {formatTokens(contextWindowSize)} {t('contextUsage.tokens')}
              </span>
            </span>
            <span
              className={styles.percentage}
              data-level={getContextUsageLevel(percentage)}
            >
              {percentage.toFixed(1)}%
            </span>
            <span className={styles.remaining}>
              {t('contextUsage.remaining')}{' '}
              <strong>
                {formatTokens(
                  Math.max(0, contextWindowSize - usage.totalTokens),
                )}
              </strong>
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
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.used')}
            tokens={usage.totalTokens}
            symbolClassName={isOverLimit ? styles.error : styles.accent}
            isOverLimit={isOverLimit}
          />
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.free')}
            tokens={breakdown.freeSpace}
            symbolClassName={styles.secondary}
          />
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.autocompactBuffer')}
            tokens={breakdown.autocompactBuffer}
            symbolClassName={styles.warning}
          />
        </>
      )}
      <details className={styles.advanced} open={!compact || !hasTokenCount}>
        <summary className={styles.advancedSummary}>
          {t('contextUsage.advanced')}
        </summary>
        <div className={styles.categories}>
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.systemPrompt')}
            tokens={breakdown.systemPrompt}
          />
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.builtinTools')}
            tokens={breakdown.builtinTools}
          >
            {hasDetails && usage.builtinTools.length > 0 ? (
              <DetailSection
                items={usage.builtinTools}
                getName={(item) => ('name' in item ? item.name : item.path)}
                tokenLabel={t('contextUsage.tokens')}
              />
            ) : undefined}
          </CategoryRow>
          {breakdown.mcpTools > 0 && (
            <CategoryRow
              {...categoryProps}
              label={t('contextUsage.mcpTools')}
              tokens={breakdown.mcpTools}
            >
              {hasDetails && usage.mcpTools.length > 0 ? (
                <DetailSection
                  items={usage.mcpTools}
                  getName={(item) => ('name' in item ? item.name : item.path)}
                  tokenLabel={t('contextUsage.tokens')}
                />
              ) : undefined}
            </CategoryRow>
          )}
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.memoryFiles')}
            tokens={breakdown.memoryFiles}
          >
            {hasDetails && usage.memoryFiles.length > 0 ? (
              <DetailSection
                items={usage.memoryFiles}
                getName={(item) => ('path' in item ? item.path : item.name)}
                tokenLabel={t('contextUsage.tokens')}
              />
            ) : undefined}
          </CategoryRow>
          <CategoryRow
            {...categoryProps}
            label={t('contextUsage.skills')}
            tokens={breakdown.skills}
          >
            {hasDetails && usage.skills.length > 0 ? (
              <SkillsSection
                skills={usage.skills}
                labels={{
                  active: t('contextUsage.active'),
                  bodyLoaded: t('contextUsage.bodyLoaded'),
                  tokens: t('contextUsage.tokens'),
                }}
              />
            ) : undefined}
          </CategoryRow>
          {hasTokenCount && (
            <CategoryRow
              {...categoryProps}
              label={t('contextUsage.messages')}
              tokens={breakdown.messages}
            />
          )}
        </div>
      </details>
      {!hasDetails ? (
        <DetailHint
          hint={t('contextUsage.detailHint')}
          onShowDetail={onShowDetail}
        />
      ) : onShowDetail ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={styles.detailCommand}
          onClick={onShowDetail}
        >
          {t('contextUsage.viewCurrent')}
        </Button>
      ) : null}
    </section>
  );
}
