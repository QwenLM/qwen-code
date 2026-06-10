import type {
  DaemonContextMemoryDetail,
  DaemonContextSkillDetail,
  DaemonContextToolDetail,
  DaemonSessionContextUsageStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './ContextUsageMessage.module.css';

const SENTINEL = 'web-shell:context-usage:v1:';
const FILLED = '\u2588';
const BUFFER = '\u2592';
const EMPTY = '\u2591';
const DETAIL_NAME_MAX_LEN = 30;

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

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen - 1)}\u2026`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
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
  const width = 56;
  const usedCount = Math.round((Math.min(usedPercentage, 100) / 100) * width);
  const bufferCount = Math.round(
    (Math.min(bufferPercentage, Math.max(0, 100 - usedPercentage)) / 100) *
      width,
  );
  const freeCount = Math.max(0, width - usedCount - bufferCount);
  const usedClass =
    usedPercentage > 80
      ? styles.error
      : usedPercentage > 60
        ? styles.warning
        : styles.accent;

  return (
    <div className={styles.progress} aria-hidden="true">
      <span className={usedClass}>{FILLED.repeat(Math.max(0, usedCount))}</span>
      <span className={styles.secondary}>
        {EMPTY.repeat(Math.max(0, freeCount))}
      </span>
      <span className={styles.warning}>
        {BUFFER.repeat(Math.max(0, bufferCount))}
      </span>
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
      <span className={isOverLimit ? styles.error : styles.value}>
        {formatTokens(tokens)} {tokenLabel} (
        {formatPercentage(tokens, contextWindowSize)}%)
      </span>
    </div>
  );
}

const DETAIL_COMMAND = '/context detail';

function DetailHint({
  hint,
  onShowDetail,
}: {
  hint: string;
  onShowDetail?: () => void;
}) {
  // The clickable part is located by the literal command inside the
  // translated hint, so a translation that drops it (or a missing
  // callback) degrades to the plain text line.
  const idx = onShowDetail ? hint.indexOf(DETAIL_COMMAND) : -1;
  if (idx < 0) return <div className={styles.hint}>{hint}</div>;
  return (
    <div className={styles.hint}>
      {hint.slice(0, idx)}
      <button
        type="button"
        className={styles.detailCommand}
        onClick={onShowDetail}
      >
        {DETAIL_COMMAND}
      </button>
      {hint.slice(idx + DETAIL_COMMAND.length)}
    </div>
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
        {truncateName(name, DETAIL_NAME_MAX_LEN)}
      </span>
      <span className={styles.value}>
        {formatTokens(tokens)} {tokenLabel}
      </span>
    </div>
  );
}

function DetailSection({
  title,
  items,
  getName,
  tokenLabel,
}: {
  title: string;
  items: readonly (DaemonContextToolDetail | DaemonContextMemoryDetail)[];
  getName: (
    item: DaemonContextToolDetail | DaemonContextMemoryDetail,
  ) => string;
  tokenLabel: string;
}) {
  const sorted = sortByTokens(items);
  if (sorted.length === 0) return null;
  return (
    <section className={styles.detailSection}>
      <div className={styles.sectionTitle}>{title}</div>
      {sorted.map((item) => (
        <DetailRow
          key={getName(item)}
          name={getName(item)}
          tokens={item.tokens}
          tokenLabel={tokenLabel}
        />
      ))}
    </section>
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
    skills: string;
    tokens: string;
  };
}) {
  const sorted = [...skills].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return b.tokens + (b.bodyTokens ?? 0) - (a.tokens + (a.bodyTokens ?? 0));
  });
  if (sorted.length === 0) return null;

  return (
    <section className={styles.detailSection}>
      <div className={styles.sectionTitle}>{labels.skills}</div>
      {sorted.map((skill) => (
        <div key={skill.name} className={styles.skillBlock}>
          <div className={styles.detailRow}>
            <span className={styles.secondary}>{'\u2514'} </span>
            <span className={styles.detailName} title={skill.name}>
              {truncateName(skill.name, DETAIL_NAME_MAX_LEN)}
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
    </section>
  );
}

export function ContextUsageMessage({
  status,
  onShowDetail,
}: {
  status: DaemonSessionContextUsageStatus;
  /** Run /context detail, exactly like typing it. */
  onShowDetail?: () => void;
}) {
  const { t } = useI18n();
  const { usage } = status;
  const { breakdown, contextWindowSize } = usage;
  const percentage =
    contextWindowSize > 0 ? (usage.totalTokens / contextWindowSize) * 100 : 0;
  const isOverLimit = percentage > 100;
  const bufferPercentage =
    contextWindowSize > 0
      ? (breakdown.autocompactBuffer / contextWindowSize) * 100
      : 0;

  return (
    <div className={styles.panel}>
      <div className={styles.title}>{t('contextUsage.title')}</div>

      {usage.isEstimated ? (
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
          {isOverLimit && (
            <div className={styles.error}>{t('contextUsage.overLimit')}</div>
          )}
        </>
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
      {!usage.isEstimated && (
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
            getName={(item) => ('name' in item ? item.name : item.path)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <DetailSection
            title={t('contextUsage.mcpTools')}
            items={usage.mcpTools}
            getName={(item) => ('name' in item ? item.name : item.path)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <DetailSection
            title={t('contextUsage.memoryFiles')}
            items={usage.memoryFiles}
            getName={(item) => ('path' in item ? item.path : item.name)}
            tokenLabel={t('contextUsage.tokens')}
          />
          <SkillsSection
            skills={usage.skills}
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
    </div>
  );
}
