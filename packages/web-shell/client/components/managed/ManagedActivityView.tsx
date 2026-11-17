import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import type { components } from './generated/managed-agent-api';
import type { ManagedDiagnosticsProvider } from './managed-agent-provider';
import { useManagedDiagnosticsText } from './managed-diagnostics-messages';

type Kind = 'tools' | 'files' | 'skills';
type Stats = components['schemas']['ManagedDiagnosticActivityStats'];
type Page = components['schemas']['ManagedDiagnosticActivityPage'];
type Metrics = components['schemas']['ManagedActivityMetrics'];

function durationMean(total: string, samples: string): string {
  const count = BigInt(samples);
  if (count === 0n) return '—';
  const tenths = (BigInt(total) * 10n) / count;
  return `${tenths / 10n}.${tenths % 10n} ms`;
}

function MeasurementTotals({
  value,
  requested,
}: {
  value?: Metrics['measurements'];
  requested: number;
}) {
  const t = useManagedDiagnosticsText();
  return (
    <div className="col-span-full space-y-2 border-t pt-2">
      <p className="text-muted-foreground">{t('measurementMeaning')}</p>
      <p>
        {t('measurementCoverage')} ·{' '}
        {value
          ? `${t(value.availability === 'partial' ? 'partialState' : value.availability)} (${value.recorded}/${requested})`
          : t('not_recorded')}
      </p>
      <p>
        {t('executionDuration')} ·{' '}
        {value && value.executionDurationSamples !== '0'
          ? `${value.executionDurationMs} ms / ${value.executionDurationSamples} ${t('samples')}`
          : t('unmeasured')}
      </p>
      {value && value.executionDurationSamples !== '0' && (
        <p>
          {t('meanDuration')} ·{' '}
          {durationMean(
            value.executionDurationMs,
            value.executionDurationSamples,
          )}
        </p>
      )}
      {value && value.fileSamples !== '0' && (
        <>
          <p>
            {t('modelLines')} ·{' '}
            {value.modelDiffSamples !== '0'
              ? `+${value.modelLinesAdded} / −${value.modelLinesRemoved} (${value.modelDiffSamples} ${t('samples')})`
              : t('unmeasured')}
          </p>
          <p>
            {t('appliedLines')} ·{' '}
            {value.appliedDiffSamples !== '0'
              ? `+${value.appliedLinesAdded} / −${value.appliedLinesRemoved} (${value.appliedDiffSamples} ${t('samples')})`
              : t('unmeasured')}
          </p>
        </>
      )}
    </div>
  );
}

function Counts({
  value,
  showMeasurements = false,
}: {
  value: Metrics;
  showMeasurements?: boolean;
}) {
  const t = useManagedDiagnosticsText();
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-muted-foreground">{t('requested')}</dt>
        <dd>{value.requested.toLocaleString()}</dd>
      </div>
      {(['allowed', 'denied', 'invalid', 'unknown'] as const).map((key) => (
        <div key={key}>
          <dt className="text-muted-foreground">
            {t('admission')} · {t(key)}
          </dt>
          <dd>{value.admission[key].toLocaleString()}</dd>
        </div>
      ))}
      {(
        [
          'not_started',
          'running',
          'success',
          'error',
          'cancelled',
          'unknown',
        ] as const
      ).map((key) => (
        <div key={key}>
          <dt className="text-muted-foreground">
            {t('execution')} · {t(key)}
          </dt>
          <dd>{value.execution[key].toLocaleString()}</dd>
        </div>
      ))}
      {showMeasurements && (
        <MeasurementTotals
          value={value.measurements}
          requested={value.requested}
        />
      )}
    </dl>
  );
}

export function ManagedActivityView({
  provider,
  sessionId,
  clientId,
  kind,
  running,
}: {
  provider: ManagedDiagnosticsProvider;
  sessionId: string;
  clientId: string;
  kind: Kind;
  running: boolean;
}) {
  const t = useManagedDiagnosticsText();
  const owner = useMemo(
    () => ({ provider, sessionId, clientId, kind }),
    [provider, sessionId, clientId, kind],
  );
  const [paging, setPaging] = useState<{
    owner: object;
    cursors: Array<string | undefined>;
  }>();
  const cursors = paging?.owner === owner ? paging.cursors : [undefined];
  const cursor = cursors.at(-1);
  const [refresh, setRefresh] = useState(0);
  const [frame, setFrame] = useState<{
    owner: object;
    stats?: Stats;
    page?: Page;
    error?: boolean;
    loading?: boolean;
  }>();
  const current = frame?.owner === owner ? frame : undefined;
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const read = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      setFrame((old) => ({
        ...(old?.owner === owner ? old : {}),
        owner,
        loading: true,
        error: false,
      }));
      try {
        if (!provider.getActivityStatistics || !provider.listActivity)
          throw new Error('Activity diagnostics unavailable');
        const options = { clientId, signal: abort.signal };
        const [stats, page] = await Promise.all([
          provider.getActivityStatistics(sessionId, options),
          provider.listActivity(sessionId, {
            ...options,
            kind,
            cursor,
            limit: 50,
          }),
        ]);
        if (
          stats.schemaVersion !== 1 ||
          page.schemaVersion !== 1 ||
          stats.sessionId !== sessionId ||
          page.sessionId !== sessionId ||
          page.kind !== kind
        )
          throw new Error('Activity identity mismatch');
        if (!abort.signal.aborted) setFrame({ owner, stats, page });
      } catch {
        if (!abort.signal.aborted) setFrame({ owner, error: true });
      } finally {
        inFlight = false;
      }
    };
    void read();
    const visibleRead = () => {
      if (document.visibilityState === 'visible') void read();
    };
    const timer = window.setInterval(visibleRead, 5_000);
    document.addEventListener('visibilitychange', visibleRead);
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibleRead);
    };
  }, [owner, provider, sessionId, clientId, kind, cursor, running, refresh]);
  const metrics = current?.stats?.statistics?.[kind];
  const statistics = current?.stats?.statistics;
  const reasons = [
    ...new Set([
      ...(current?.stats?.coverageReasons ?? []),
      ...(current?.page?.coverageReasons ?? []),
    ]),
  ];
  const reasonText = (reason: string) => {
    switch (reason) {
      case 'history_before_collection':
      case 'collection_start_missing':
      case 'request_outside_coverage':
        return t('sourceMissing');
      case 'file_path_unavailable':
        return t('pathMissing');
      case 'rebuilding':
        return t('rebuilding');
      case 'observations_omitted':
      case 'page_budget_exhausted':
        return t('detailPartial');
      case 'receipt_binding_missing':
      case 'conflicting_evidence':
        return t('outcomeUnknown');
      default:
        return t('partial');
    }
  };
  return (
    <section className="space-y-4" aria-busy={current?.loading ?? !current}>
      <p className="text-sm text-muted-foreground">{t('ownOnly')}</p>
      {kind === 'files' && (
        <p className="text-sm text-muted-foreground">{t('noImplicitFiles')}</p>
      )}
      {kind === 'skills' && (
        <p className="text-sm text-muted-foreground">{t('skillMeaning')}</p>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => setRefresh((n) => n + 1)}
      >
        {t('refresh')}
      </Button>
      {!current && <p role="status">{t('loading')}</p>}
      {current?.error && <p role="alert">{t('failed')}</p>}
      {current?.stats?.startedAt != null && (
        <p className="text-sm">
          {t('collectionStart')} ·{' '}
          {new Date(current.stats.startedAt).toLocaleString()}
        </p>
      )}
      {(current?.stats?.availability === 'partial' ||
        current?.page?.availability === 'partial') && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('partial')}
        </p>
      )}
      {current?.stats?.availability === 'not_recorded' && (
        <p>{t('not_recorded')}</p>
      )}
      {reasons
        .filter((reason) => reason !== 'not_recorded')
        .map((reason) => (
          <p key={reason} className="text-sm text-muted-foreground">
            {reasonText(reason)}
          </p>
        ))}
      {metrics && kind !== 'skills' && (
        <Counts value={metrics} showMeasurements />
      )}
      {kind !== 'skills' && statistics?.measurementStartSequence && (
        <p className="text-sm text-muted-foreground">
          {t('measurementStart')} · {statistics.measurementStartSequence}
        </p>
      )}
      {kind === 'files' && statistics && (
        <div className="space-y-2">
          {(['read', 'write', 'edit'] as const).map((operation) => (
            <details key={operation} className="rounded-md border p-3">
              <summary>
                {t(operation)} ·{' '}
                {statistics.fileOperations[operation].requested}
              </summary>
              <Counts
                value={statistics.fileOperations[operation]}
                showMeasurements
              />
            </details>
          ))}
        </div>
      )}
      {kind === 'skills' && statistics && (
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 font-medium">{t('skillLoads')}</h3>
            <Counts value={statistics.skillLoads} />
          </div>
          <div>
            <h3 className="mb-2 font-medium">{t('extension_command')}</h3>
            <Counts value={statistics.extensionCommands} />
          </div>
        </div>
      )}
      {statistics && (kind === 'tools' || kind === 'skills') && (
        <div className="space-y-2">
          {(kind === 'tools'
            ? statistics.toolBuckets
            : statistics.skillBuckets
          ).map((bucket) => (
            <details key={bucket.key} className="rounded-md border p-3">
              <summary className="cursor-pointer break-all">
                {bucket.name} · {bucket.metrics.requested}
                {bucket.resource && (
                  <>
                    {' '}
                    · {t(bucket.resource.resourceKind)} ·{' '}
                    {bucket.resource.pin.slice(0, 12)}
                  </>
                )}
              </summary>
              <div className="pt-3">
                <Counts value={bucket.metrics} />
              </div>
            </details>
          ))}
          {(kind === 'tools' ? statistics.otherTools : statistics.otherSkills)
            .requested > 0 && (
            <details className="rounded-md border p-3">
              <summary>
                {t(kind === 'tools' ? 'otherTools' : 'otherSkills')}
              </summary>
              <Counts
                value={
                  kind === 'tools'
                    ? statistics.otherTools
                    : statistics.otherSkills
                }
              />
            </details>
          )}
        </div>
      )}
      {current?.page?.items.map((item) => (
        <details
          key={item.invocationId}
          className="rounded-md border p-3 text-sm"
        >
          <summary className="cursor-pointer space-x-2 break-all">
            <span>
              {kind === 'files'
                ? (item.file?.path ?? t('pathMissing'))
                : kind === 'skills'
                  ? item.skill?.name
                  : item.toolName}
            </span>
            <Badge variant="secondary">{t(item.execution)}</Badge>
            {item.file && <span>{t(item.file.operation)}</span>}
            <span className="text-muted-foreground">
              {new Date(item.requestedAt).toLocaleString()}
            </span>
          </summary>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-all">
            <dt>{t('admission')}</dt>
            <dd>{t(item.admission)}</dd>
            <dt>{t('execution')}</dt>
            <dd>{t(item.execution)}</dd>
            <dt>{t('delivery')}</dt>
            <dd>
              {t(item.delivery === 'partial' ? 'partialState' : item.delivery)}
            </dd>
            <dt>{t('capture')}</dt>
            <dd>
              {t(item.capture === 'partial' ? 'partialState' : item.capture)}
            </dd>
            {kind !== 'skills' && (
              <>
                <dt>{t('measurementCoverage')}</dt>
                <dd>
                  {item.measurements
                    ? t(
                        item.measurements.availability === 'partial'
                          ? 'partialState'
                          : item.measurements.availability,
                      )
                    : t('not_recorded')}
                </dd>
                <dt>{t('executionDuration')}</dt>
                <dd>
                  {item.measurements?.executionDurationMs != null
                    ? `${item.measurements.executionDurationMs} ms`
                    : t('unmeasured')}
                </dd>
                {item.measurements?.file &&
                  item.measurements.file.operation !== 'read' && (
                    <>
                      <dt>{t('fileChanges')}</dt>
                      <dd>{t(item.measurements.file.status)}</dd>
                      <dt>{t('modelLines')}</dt>
                      <dd>
                        {item.measurements.file.modelLinesAdded != null
                          ? `+${item.measurements.file.modelLinesAdded} / −${item.measurements.file.modelLinesRemoved}`
                          : t('unmeasured')}
                      </dd>
                      <dt>{t('appliedLines')}</dt>
                      <dd>
                        {item.measurements.file.appliedLinesAdded != null
                          ? `+${item.measurements.file.appliedLinesAdded} / −${item.measurements.file.appliedLinesRemoved}`
                          : t('unmeasured')}
                      </dd>
                    </>
                  )}
              </>
            )}
            {item.skill && (
              <>
                <dt>{t(item.skill.resourceKind)}</dt>
                <dd>
                  {item.skill.pin} · {t(item.skill.origin)} ·{' '}
                  {t(
                    item.skill.delivery === 'partial'
                      ? 'partialState'
                      : item.skill.delivery,
                  )}
                </dd>
              </>
            )}
            <dt>{t('sourceMessage')}</dt>
            <dd>{item.assistantMessageId}</dd>
            <dt>{t('invocation')}</dt>
            <dd>{item.invocationId}</dd>
            {item.taskId && (
              <>
                <dt>{t('task')}</dt>
                <dd>{item.taskId}</dd>
                {item.taskState && (
                  <>
                    <dt>{t('taskState')}</dt>
                    <dd>
                      {item.taskState} {item.taskRuntimeState}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
        </details>
      ))}
      {current?.page &&
        current.page.availability !== 'not_recorded' &&
        current.page.items.length === 0 && <p>{t('empty')}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={cursors.length <= 1 || current?.loading}
          onClick={() => setPaging({ owner, cursors: cursors.slice(0, -1) })}
        >
          {t('previous')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!current?.page?.hasMore || current.loading}
          onClick={() => {
            const next = current?.page?.nextCursor;
            if (next) setPaging({ owner, cursors: [...cursors, next] });
          }}
        >
          {t('next')}
        </Button>
      </div>
    </section>
  );
}
