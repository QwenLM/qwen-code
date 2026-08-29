import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { isSafeHref, Markdown } from '../messages/Markdown';
import {
  getImageMimeTypeFromPath,
  readWorkspaceFileAsBlob,
} from './artifactUtils';
import styles from './CodeReviewArtifactDetail.module.css';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';

// Hand-duplicated from the CLI's canonical lists in
// packages/cli/src/commands/review/findings.ts. The parser below fails closed
// on any value missing here, so when the CLI adds one, update this copy and
// the contract fixture (__fixtures__/code-review-artifact-v1.json) with it.
// The CLI-side vocabulary snapshot (packages/cli/src/commands/review/findings.test.ts)
// turns red on that change and names this file.
const SEVERITIES = ['Critical', 'Suggestion', 'Nice to have'] as const;
const CONFIDENCES = ['high', 'low'] as const;
const SOURCES = ['review', 'build', 'test', 'probe', 'lint'] as const;
const OUTCOMES = ['fixed', 'skipped', 'no_change_needed'] as const;

type Severity = (typeof SEVERITIES)[number];
type Confidence = (typeof CONFIDENCES)[number];
type Source = (typeof SOURCES)[number];
type Outcome = (typeof OUTCOMES)[number];

interface FindingLocation {
  file: string;
  line?: number;
  anchor?: string;
}

interface ReviewFinding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  source: Source;
  summary: string;
  shortSummary: string;
  failureScenario: string;
  /** The executed evidence that settled the verdict, or its `not run` line. */
  witness?: string;
  suggestedFix?: string;
  category?: string;
  locations: FindingLocation[];
  /** Local evidence paths; rendered as workspace images where possible. */
  assetFiles?: string[];
  assets?: string[];
  outcome?: Outcome;
  outcomeNote?: string;
  heldByMeasurement?: { file: string };
}

interface ReviewCounts {
  total: number;
  bySeverity: Record<Severity, number>;
  byConfidence: Record<Confidence, number>;
  held: number;
}

// Only fields the renderer displays are validated: every required field here
// can fail the whole document, so the fail-closed surface stays no larger
// than the visible one. Fields the CLI persists but this view ignores
// (verdict.downgraded, verdict.body, remediation, outcomesRecorded,
// counts.byOutcome, ...) are deliberately absent and pass through unchecked.
interface CodeReviewDocument {
  schemaVersion: 1;
  target: string;
  effort: string;
  verdict: {
    event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    verdictLine: string;
    baseEvent: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
    cappedBy: string[];
  };
  findings: ReviewFinding[];
  counts: ReviewCounts;
  markdownReportPath: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, label);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function lineNumber(value: unknown, label: string): number {
  const line = integer(value, label);
  if (line === 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return line;
}

// The one field that becomes a file read. The daemon enforces workspace
// containment, but the document's own contract is checked here like every
// other field: relative, no traversal, the durable report's extension, and
// the directory the writer guarantees — save-artifact confines its report to
// .qwen/reviews/, so the renderer never follows a report the CLI would not
// have written.
function markdownReportPath(value: unknown): string {
  const path = string(value, 'markdownReportPath');
  if (
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    !path.endsWith('.md')
  ) {
    throw new Error(
      'markdownReportPath must be a relative .md path without ".." segments.',
    );
  }
  if (!path.startsWith('.qwen/reviews/')) {
    throw new Error('markdownReportPath must be a file under .qwen/reviews/.');
  }
  return path;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value.`);
  }
  return value as T;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function countRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
  label: string,
): Record<T, number> {
  const source = object(value, label);
  return Object.fromEntries(
    keys.map((key) => [key, integer(source[key], `${label}.${key}`)]),
  ) as Record<T, number>;
}

function parseFinding(value: unknown, index: number): ReviewFinding {
  const label = `findings[${index}]`;
  const source = object(value, label);
  if (!Array.isArray(source['locations']) || source['locations'].length === 0) {
    throw new Error(`${label}.locations must be a non-empty array.`);
  }
  const locations = source['locations'].map((entry, locationIndex) => {
    const location = object(entry, `${label}.locations[${locationIndex}]`);
    return {
      file: string(
        location['file'],
        `${label}.locations[${locationIndex}].file`,
      ),
      ...(location['line'] === undefined
        ? {}
        : {
            line: lineNumber(
              location['line'],
              `${label}.locations[${locationIndex}].line`,
            ),
          }),
      ...(optionalString(
        location['anchor'],
        `${label}.locations[${locationIndex}].anchor`,
      )
        ? { anchor: location['anchor'] as string }
        : {}),
    };
  });
  const outcome =
    source['outcome'] === undefined
      ? undefined
      : enumValue(source['outcome'], OUTCOMES, `${label}.outcome`);
  return {
    id: string(source['id'], `${label}.id`),
    severity: enumValue(source['severity'], SEVERITIES, `${label}.severity`),
    confidence: enumValue(
      source['confidence'],
      CONFIDENCES,
      `${label}.confidence`,
    ),
    source: enumValue(source['source'], SOURCES, `${label}.source`),
    summary: string(source['summary'], `${label}.summary`),
    shortSummary: string(source['shortSummary'], `${label}.shortSummary`),
    failureScenario: string(
      source['failureScenario'],
      `${label}.failureScenario`,
    ),
    ...(optionalString(source['witness'], `${label}.witness`)
      ? { witness: source['witness'] as string }
      : {}),
    ...(optionalString(source['suggestedFix'], `${label}.suggestedFix`)
      ? { suggestedFix: source['suggestedFix'] as string }
      : {}),
    ...(optionalString(source['category'], `${label}.category`)
      ? { category: source['category'] as string }
      : {}),
    locations,
    ...(source['assetFiles'] === undefined
      ? {}
      : {
          assetFiles: stringArray(source['assetFiles'], `${label}.assetFiles`),
        }),
    ...(source['assets'] === undefined
      ? {}
      : { assets: stringArray(source['assets'], `${label}.assets`) }),
    ...(outcome ? { outcome } : {}),
    ...(optionalString(source['outcomeNote'], `${label}.outcomeNote`)
      ? { outcomeNote: source['outcomeNote'] as string }
      : {}),
    ...(source['heldByMeasurement'] === undefined
      ? {}
      : {
          heldByMeasurement: {
            file: string(
              object(source['heldByMeasurement'], `${label}.heldByMeasurement`)[
                'file'
              ],
              `${label}.heldByMeasurement.file`,
            ),
          },
        }),
  };
}

export function parseCodeReviewDocument(content: string): CodeReviewDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Malformed code review JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = object(parsed, 'Code review document');
  if (root['schemaVersion'] !== 1) {
    throw new Error(
      `Unsupported code review schemaVersion: ${JSON.stringify(root['schemaVersion'])}. Expected 1.`,
    );
  }
  if (!Array.isArray(root['findings'])) {
    throw new Error('findings must be an array.');
  }
  const verdict = object(root['verdict'], 'verdict');
  const counts = object(root['counts'], 'counts');
  return {
    schemaVersion: 1,
    target: string(root['target'], 'target'),
    effort: string(root['effort'], 'effort'),
    verdict: {
      event: enumValue(
        verdict['event'],
        ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'],
        'verdict.event',
      ),
      verdictLine: string(verdict['verdictLine'], 'verdict.verdictLine'),
      baseEvent: enumValue(
        verdict['baseEvent'],
        ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'],
        'verdict.baseEvent',
      ),
      cappedBy: stringArray(verdict['cappedBy'], 'verdict.cappedBy'),
    },
    findings: root['findings'].map(parseFinding),
    counts: {
      total: integer(counts['total'], 'counts.total'),
      bySeverity: countRecord(
        counts['bySeverity'],
        SEVERITIES,
        'counts.bySeverity',
      ),
      byConfidence: countRecord(
        counts['byConfidence'],
        CONFIDENCES,
        'counts.byConfidence',
      ),
      held: integer(counts['held'], 'counts.held'),
    },
    markdownReportPath: markdownReportPath(root['markdownReportPath']),
  };
}

export function CodeReviewArtifactDetail({
  workspacePath,
  artifactVersion,
  workspaceActions,
}: {
  workspacePath: string;
  artifactVersion?: string;
  workspaceActions: ArtifactWorkspaceActions;
}) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [artifactTruncated, setArtifactTruncated] = useState(false);
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [confidence, setConfidence] = useState<'all' | Confidence>('all');
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [reportContent, setReportContent] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const reportRequest = useRef(0);

  // `t` is deliberately NOT a dependency: i18n memoizes it per language, and
  // including it would re-read the artifact and reset every filter on a
  // language switch. The truncated message is resolved at render time.
  useEffect(() => {
    let cancelled = false;
    reportRequest.current += 1;
    setContent(null);
    setLoadError(null);
    setArtifactTruncated(false);
    setSeverity('all');
    setConfidence('all');
    setReportPath(null);
    setReportContent(null);
    setReportError(null);
    setReportLoading(false);
    workspaceActions
      .readWorkspaceFile(workspacePath)
      .then((file) => {
        if (cancelled) return;
        if (file.truncated) {
          setArtifactTruncated(true);
          return;
        }
        setContent(file.content);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      reportRequest.current += 1;
    };
  }, [artifactVersion, workspaceActions, workspacePath]);

  const parsed = useMemo(() => {
    if (content === null) return null;
    try {
      return { document: parseCodeReviewDocument(content), error: null };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [content]);

  const openReport = (path: string) => {
    const request = ++reportRequest.current;
    setReportPath(path);
    setReportContent(null);
    setReportError(null);
    setReportLoading(true);
    workspaceActions
      .readWorkspaceFile(path)
      .then((file) => {
        if (request !== reportRequest.current) return;
        if (file.truncated) {
          setReportError(t('codeReview.reportTruncated'));
        } else {
          setReportContent(file.content);
        }
      })
      .catch((error: unknown) => {
        if (request !== reportRequest.current) return;
        setReportError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (request === reportRequest.current) setReportLoading(false);
      });
  };

  if (reportContent !== null || reportError) {
    return (
      <div className={styles.report}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            reportRequest.current += 1;
            setReportPath(null);
            setReportContent(null);
            setReportError(null);
            setReportLoading(false);
          }}
        >
          {t('codeReview.back')}
        </button>
        <div className={styles.path}>{reportPath}</div>
        {reportError ? (
          <div className={styles.error} role="alert">
            {reportError}
          </div>
        ) : (
          <Markdown content={reportContent ?? ''} />
        )}
      </div>
    );
  }

  const loadFailure = artifactTruncated
    ? t('codeReview.artifactTruncated')
    : loadError;
  if (loadFailure || parsed?.error) {
    // The document that names the durable report failed to load, so derive
    // the report from the artifact path by the same-stem convention
    // save-artifact is invoked with: a truncated or unparsable artifact must
    // not become a dead end when its Markdown report is still readable.
    const fallbackReport = workspacePath.endsWith('.json')
      ? `${workspacePath.slice(0, -'.json'.length)}.md`
      : null;
    return (
      <div className={styles.errorFallback}>
        <div className={styles.error} role="alert">
          <strong>{t('codeReview.loadErrorTitle')}</strong>
          <span>{loadFailure ?? parsed?.error}</span>
        </div>
        {fallbackReport && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => openReport(fallbackReport)}
            disabled={reportLoading}
          >
            {reportLoading
              ? t('codeReview.loadingReport')
              : t('codeReview.openReport')}
          </button>
        )}
      </div>
    );
  }
  if (!parsed?.document) {
    return <div className={styles.empty}>{t('codeReview.loading')}</div>;
  }

  const reviewDocument = parsed.document;
  const findings = reviewDocument.findings.filter(
    (finding) =>
      (severity === 'all' || finding.severity === severity) &&
      (confidence === 'all' || finding.confidence === confidence),
  );

  return (
    <div className={styles.root}>
      <section className={styles.summary}>
        <div>
          <div className={styles.eyebrow}>
            {t('codeReview.authoritativeVerdict')}
          </div>
          <h2 className={styles.verdict}>
            {reviewDocument.verdict.verdictLine}
          </h2>
          <div className={styles.meta}>
            {t('codeReview.targetEffort', {
              target: reviewDocument.target,
              effort: reviewDocument.effort,
            })}
          </div>
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => openReport(reviewDocument.markdownReportPath)}
          disabled={reportLoading}
        >
          {reportLoading
            ? t('codeReview.loadingReport')
            : t('codeReview.openReport')}
        </button>
      </section>

      <section
        className={styles.metrics}
        aria-label={t('codeReview.reviewCounts')}
      >
        <Metric
          label={t('codeReview.total')}
          value={reviewDocument.counts.total}
        />
        {SEVERITIES.map((value) => (
          <Metric
            key={value}
            label={value}
            value={reviewDocument.counts.bySeverity[value]}
          />
        ))}
        {CONFIDENCES.map((value) => (
          <Metric
            key={value}
            label={t('codeReview.confidence', { value })}
            value={reviewDocument.counts.byConfidence[value]}
          />
        ))}
        <Metric
          label={t('codeReview.held')}
          value={reviewDocument.counts.held}
        />
      </section>

      <section className={styles.caps}>
        <span className={styles.eyebrow}>{t('codeReview.caps')}</span>
        <span>
          {reviewDocument.verdict.cappedBy.length > 0
            ? reviewDocument.verdict.cappedBy.join(', ')
            : t('codeReview.none')}
        </span>
      </section>

      <div className={styles.filters}>
        <label>
          {t('codeReview.severity')}
          <select
            aria-label={t('codeReview.severity')}
            value={severity}
            onChange={(event) =>
              setSeverity(event.target.value as 'all' | Severity)
            }
          >
            <option value="all">{t('codeReview.all')}</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {value} ({reviewDocument.counts.bySeverity[value]})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('codeReview.confidenceLabel')}
          <select
            aria-label={t('codeReview.confidenceLabel')}
            value={confidence}
            onChange={(event) =>
              setConfidence(event.target.value as 'all' | Confidence)
            }
          >
            <option value="all">{t('codeReview.all')}</option>
            {CONFIDENCES.map((value) => (
              <option key={value} value={value}>
                {value} ({reviewDocument.counts.byConfidence[value]})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.findings}>
        {findings.length === 0 ? (
          <div className={styles.empty}>{t('codeReview.noMatches')}</div>
        ) : (
          findings.map((finding) => (
            <article key={finding.id} className={styles.finding}>
              <div className={styles.findingHeader}>
                <span className={styles.severity}>{finding.severity}</span>
                <span>
                  {t('codeReview.confidence', {
                    value: finding.confidence,
                  })}
                </span>
                <span>{t('codeReview.source', { value: finding.source })}</span>
                {finding.category && <span>{finding.category}</span>}
              </div>
              <h3>{finding.summary}</h3>
              <Detail
                label={t('codeReview.failureScenario')}
                value={finding.failureScenario}
              />
              {finding.witness && (
                <Detail
                  label={t('codeReview.witness')}
                  value={finding.witness}
                />
              )}
              {finding.suggestedFix && (
                <Detail
                  label={t('codeReview.suggestedFix')}
                  value={finding.suggestedFix}
                />
              )}
              {finding.outcome && (
                <Detail
                  label={t('codeReview.outcome')}
                  value={`${finding.outcome}${finding.outcomeNote ? ` — ${finding.outcomeNote}` : ''}`}
                />
              )}
              {finding.heldByMeasurement && (
                <Detail
                  label={t('codeReview.heldByMeasurement')}
                  value={finding.heldByMeasurement.file}
                />
              )}
              <div className={styles.detailBlock}>
                <strong>{t('codeReview.locations')}</strong>
                <ul>
                  {finding.locations.map((location, index) => (
                    <li
                      key={`${location.file}:${location.line ?? ''}:${index}`}
                    >
                      <code>
                        {location.file}
                        {location.line === undefined ? '' : `:${location.line}`}
                      </code>
                      {location.anchor && <span> — {location.anchor}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              {((finding.assets && finding.assets.length > 0) ||
                (finding.assetFiles && finding.assetFiles.length > 0)) && (
                <div className={styles.detailBlock}>
                  <strong>{t('codeReview.evidence')}</strong>
                  <ul>
                    {(finding.assets ?? []).map((asset, index) => (
                      <li key={`${asset}-${index}`}>
                        {isSafeHref(asset) ? (
                          <a
                            href={asset}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => openExternalLink(event, asset)}
                          >
                            {asset}
                          </a>
                        ) : (
                          <span className={styles.notLinked}>
                            {asset} ({t('codeReview.notLinked')})
                          </span>
                        )}
                      </li>
                    ))}
                    {(finding.assetFiles ?? []).map((file, index) => (
                      <EvidenceFile
                        key={`${file}-${index}`}
                        path={file}
                        workspaceActions={workspaceActions}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

// A local evidence file (`assetFiles`): an inline image when the workspace
// file is readable, the bare path when it is not. Local evidence usually
// lives under `.qwen/tmp/`, which review cleanup removes, so a path that no
// longer resolves is an ordinary state — the caption stays either way.
function EvidenceFile({
  path,
  workspaceActions,
}: {
  path: string;
  workspaceActions: ArtifactWorkspaceActions;
}) {
  const mimeType = getImageMimeTypeFromPath(path);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!mimeType) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    readWorkspaceFileAsBlob(
      (filePath, opts) => workspaceActions.readFileBytes(filePath, opts),
      path,
      mimeType,
      {
        statFile: (filePath) => workspaceActions.stat(filePath),
        isCancelled: () => cancelled,
      },
    )
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mimeType, path, workspaceActions]);

  return (
    <li>
      {src && <img className={styles.evidenceImage} src={src} alt={path} />}
      <code>{path}</code>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.metric}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailBlock}>
      <strong>{label}</strong>
      <p>{value}</p>
    </div>
  );
}
