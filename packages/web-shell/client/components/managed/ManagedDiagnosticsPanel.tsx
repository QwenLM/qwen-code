import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { McpDetailField, McpResourceDetail } from '../mcp/McpDetails';
import { formatDuration } from '../messages/StatsMessage';
import type {
  ManagedDiagnosticContextUsage,
  ManagedDiagnosticResources,
  ManagedDiagnosticStats,
  ManagedDiagnosticsProvider,
} from './managed-agent-provider';
import { useManagedDiagnosticsText } from './managed-diagnostics-messages';
import {
  useManagedDiagnostics,
  type ManagedDiagnosticsTab,
} from './use-managed-diagnostics';

type ModelBucket = NonNullable<ManagedDiagnosticStats['statistics']>['totals'];
type ContextCategory = keyof NonNullable<
  ManagedDiagnosticContextUsage['context']
>['breakdown'];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-right tabular-nums">{children}</span>
    </div>
  );
}

function CoverageReasons({ reasons }: { reasons: string[] }) {
  const t = useManagedDiagnosticsText();
  const labels = {
    legacy_history: 'legacyHistory',
    unclosed_turn: 'unclosedTurn',
    unclosed_model_attempt: 'unclosedModel',
    unclosed_maintenance: 'unclosedMaintenance',
    observation_error: 'observationError',
    missing_usage: 'missingUsage',
    interrupted_observation: 'interruptedObservation',
    counter_overflow: 'counterOverflow',
    attribution_incomplete: 'attributionIncomplete',
    details_truncated: 'detailsTruncated',
    resource_read_limit: 'resourceReadLimit',
    configuration_history_limit: 'configurationHistoryLimit',
    mcp_history_limit: 'mcpHistoryLimit',
    extension_attribution_unavailable: 'extensionAttributionUnavailable',
    invalid_resource: 'invalidResource',
    resource_unavailable: 'resourceUnavailable',
    public_output_limit: 'publicOutputLimit',
    child_unavailable: 'childUnavailable',
    description_unavailable: 'descriptionUnavailable',
    invocation_unavailable: 'invocationUnavailable',
  } as const;
  if (reasons.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm text-muted-foreground">
      {[...new Set(reasons)].map((reason) => (
        <li key={reason}>
          {t(labels[reason as keyof typeof labels] ?? 'unknownCoverage')}
        </li>
      ))}
    </ul>
  );
}

function ContextSnapshot({ value }: { value: ManagedDiagnosticContextUsage }) {
  const t = useManagedDiagnosticsText();
  const context = value.context;
  if (!context) return <p>{t('not_recorded')}</p>;
  return (
    <div className="space-y-4">
      {value.stale && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('stale')}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t('estimated')}</p>
      <div>
        <Field label={t('model')}>{context.model}</Field>
        <Field label={t('observedAt')}>
          {context.observedAt > 0
            ? new Date(context.observedAt).toLocaleString()
            : t('unknown')}
        </Field>
        <Field label={t('input')}>
          {context.inputTokens?.toLocaleString() ?? t('unknown')}
        </Field>
        <Field label={t('cached')}>
          {context.cachedTokens?.toLocaleString() ?? t('unknown')}
        </Field>
        <Field label={t('window')}>
          {context.contextWindowSize?.toLocaleString() ?? t('unknown')}
        </Field>
      </div>
      <div>
        {Object.entries(context.breakdown).map(([category, tokens]) => (
          <Field key={category} label={t(category as ContextCategory)}>
            {tokens.toLocaleString()}
          </Field>
        ))}
      </div>
      {context.details.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t('details')}
          </summary>
          {context.details.map((entry, index) => (
            <Field
              key={`${entry.category}:${entry.name}:${index}`}
              label={`${t(entry.category)} · ${entry.name}`}
            >
              {entry.tokens.toLocaleString()}
            </Field>
          ))}
        </details>
      )}
      {context.detailsTruncated && (
        <p className="text-sm text-muted-foreground">{t('truncated')}</p>
      )}
    </div>
  );
}

function ModelMetrics({ metrics }: { metrics: ModelBucket }) {
  const t = useManagedDiagnosticsText();
  const token = (key: keyof ModelBucket['tokens']) => {
    const known = metrics.usageKnown[key];
    if (metrics.requests.total > 0 && known === 0) return t('unknown');
    const value = metrics.tokens[key].toLocaleString();
    return known < metrics.requests.total
      ? `${value} (${t('knownUsage')}: ${known}/${metrics.requests.total})`
      : value;
  };
  return (
    <div>
      <Field label={t('requests')}>
        {metrics.requests.total.toLocaleString()}
      </Field>
      {(['success', 'error', 'cancelled', 'interrupted'] as const).map(
        (outcome) => (
          <Field key={outcome} label={t(outcome)}>
            {metrics.requests[outcome].toLocaleString()}
          </Field>
        ),
      )}
      <Field label={t('input')}>{token('prompt')}</Field>
      <Field label={t('output')}>{token('candidates')}</Field>
      <Field label={t('cached')}>{token('cached')}</Field>
      <Field label={t('thoughts')}>{token('thoughts')}</Field>
      <Field label={t('totalTokens')}>{token('total')}</Field>
      <Field label={t('latency')}>{formatDuration(metrics.latencyMs)}</Field>
      <Field label={t('ttft')}>
        {metrics.timing.ttftCount
          ? formatDuration(
              metrics.timing.totalTtftMs / metrics.timing.ttftCount,
            )
          : t('unknown')}
      </Field>
      <Field label={t('speed')}>
        {metrics.timing.totalGenerationMs > 0
          ? (
              (metrics.timing.throughputOutputTokens * 1000) /
              metrics.timing.totalGenerationMs
            ).toFixed(1)
          : t('unknown')}
      </Field>
      <Field label={t('retries')}>
        {metrics.backoffRetries.toLocaleString()}
      </Field>
      {(['http', 'transport', 'timeout', 'other'] as const).map((kind) => (
        <Field key={kind} label={t(kind)}>
          {metrics.failures[kind].toLocaleString()}
        </Field>
      ))}
    </div>
  );
}

function StatisticsSnapshot({ value }: { value: ManagedDiagnosticStats }) {
  const t = useManagedDiagnosticsText();
  const statistics = value.statistics;
  if (!statistics) return <p>{t('not_recorded')}</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('ownOnly')}</p>
      <Field label={t('observedAt')}>
        {statistics.observedAt > 0
          ? new Date(statistics.observedAt).toLocaleString()
          : t('unknown')}
      </Field>
      <ModelMetrics metrics={statistics.totals} />
      {(['main', 'hook', 'compression'] as const).map((source) => (
        <details key={source}>
          <summary className="cursor-pointer font-medium">
            {t(source)} · {statistics.sources[source].requests.total}
          </summary>
          <ModelMetrics metrics={statistics.sources[source]} />
        </details>
      ))}
      {statistics.models.map((model) => (
        <details key={model.key}>
          <summary className="cursor-pointer font-medium">
            {model.name ?? model.key.slice(0, 12)}
            {model.nameTruncated ? '…' : ''}
          </summary>
          <ModelMetrics metrics={model.metrics} />
        </details>
      ))}
      {statistics.overflow.requests.total > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            {t('otherModels')}
          </summary>
          <ModelMetrics metrics={statistics.overflow} />
        </details>
      )}
      {statistics.recent.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            {t('recent')}
          </summary>
          {statistics.recent.map((call) => (
            <Field
              key={call.executionId}
              label={`${t(call.source)} · ${t(call.outcome)} · ${new Date(call.at).toLocaleTimeString()}`}
            >
              {formatDuration(call.durationMs)}
            </Field>
          ))}
        </details>
      )}
      {(statistics.modelBreakdownOmitted || statistics.samplesTruncated) && (
        <p className="text-sm text-muted-foreground">{t('truncated')}</p>
      )}
    </div>
  );
}

function ResourcesSnapshot({ value }: { value: ManagedDiagnosticResources }) {
  const t = useManagedDiagnosticsText();
  return (
    <div className="space-y-5">
      {value.outputTruncated && (
        <p className="text-sm text-muted-foreground">
          {t('resourceTruncated')}
        </p>
      )}
      {value.activeConfigRevision !== null && (
        <Field label={t('activeConfig')}>{value.activeConfigRevision}</Field>
      )}
      {value.activeOperationPhase &&
        value.activeOperationPhase !== 'active' && (
          <p className="text-sm text-muted-foreground">{t('pendingConfig')}</p>
        )}
      <section className="space-y-3">
        <h3 className="font-medium">{t('skills')}</h3>
        {value.skills.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
        {value.skills.map((skill) => (
          <details
            key={`${skill.origin}:${skill.extensionId}:${skill.kind}:${skill.name}`}
            className="rounded-md border p-3"
          >
            <summary className="cursor-pointer">
              {skill.name} <Badge variant="secondary">{t(skill.kind)}</Badge>
            </summary>
            <div className="space-y-2 pt-3">
              <McpDetailField
                label={t(skill.origin)}
                value={skill.extensionId ?? skill.description}
              />
              {skill.extensionId && (
                <p className="text-sm text-muted-foreground">
                  {skill.description}
                </p>
              )}
              <Field label={t('modelInvocable')}>
                {t(skill.modelInvocable ? 'yes' : 'no')}
              </Field>
              <Field label={t('userInvocable')}>
                {t(skill.userInvocable ? 'yes' : 'no')}
              </Field>
            </div>
          </details>
        ))}
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">MCP</h3>
        <p className="text-sm text-muted-foreground">{t('offlineRead')}</p>
        {value.servers.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
        {value.servers.map((server) => (
          <details key={server.serverId} className="rounded-md border p-3">
            <summary className="cursor-pointer">
              {server.serverId}{' '}
              <Badge variant="secondary">{t(server.selectionState)}</Badge>
            </summary>
            <div className="space-y-3 pt-3">
              <p className="text-sm text-muted-foreground">
                {t(server.origin)}
                {server.extensionId ? ` · ${server.extensionId}` : ''}
              </p>
              <Field label={t('selectedRevision')}>
                {server.serverRevision}
              </Field>
              <Field label={t('catalogServerRevision')}>
                {server.catalogServerRevision ?? t('unknown')}
              </Field>
              <Field label={t('lastAttempt')}>
                {server.lastAttemptState ?? t('unknown')}
              </Field>
              <Field label={t('attemptServerRevision')}>
                {server.attemptServerRevision ?? t('unknown')}
              </Field>
              <Field label={t('lastExecution')}>
                {server.lastExecutionState ?? t('unknown')}
              </Field>
              <Field label={t('release')}>
                {server.releaseState ?? t('unknown')}
              </Field>
              {server.historical && (
                <p className="text-sm text-muted-foreground">
                  {t('historical')}
                </p>
              )}
              {(['tools', 'resources', 'prompts'] as const).map((kind) => {
                const state = server.discovery[kind];
                return (
                  <details key={kind}>
                    <summary className="cursor-pointer text-sm">
                      {t(kind)} ·{' '}
                      {t(
                        state === 'failed'
                          ? 'discoveryFailed'
                          : state === 'stale'
                            ? 'discoveryStale'
                            : state === 'partial'
                              ? 'discoveryPartial'
                              : state,
                      )}
                    </summary>
                    <div className="space-y-3 py-2">
                      {server[kind].map((item, index) => (
                        <div
                          key={`${item.name}:${index}`}
                          className="rounded-md bg-muted p-3"
                        >
                          <h4 className="mb-2 break-all font-medium">
                            {item.name}
                          </h4>
                          {kind === 'resources' && item.uri ? (
                            <McpResourceDetail
                              resource={{ ...item, uri: item.uri }}
                            />
                          ) : (
                            <McpDetailField
                              label={t('details')}
                              value={item.description ?? ''}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}

export function ManagedDiagnosticsPanel({
  provider,
  sessionId,
  clientId,
  running,
  revision,
  onClose,
  restoreFocus,
  onOpenChild,
}: {
  provider: ManagedDiagnosticsProvider;
  sessionId: string;
  clientId: string;
  running: boolean;
  revision?: string;
  onClose(): void;
  restoreFocus(): void;
  onOpenChild?(sessionId: string): void;
}) {
  const t = useManagedDiagnosticsText();
  const [tab, setTab] = useState<ManagedDiagnosticsTab>('context');
  const read = useManagedDiagnostics({
    provider,
    sessionId,
    clientId,
    tab,
    running,
    revision,
  });
  const snapshot = read.snapshot;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-w-3xl flex-col sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <Tabs
          className="min-h-0 min-w-0 flex-1"
          value={tab}
          onValueChange={(value) => setTab(value as ManagedDiagnosticsTab)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList className="max-w-full flex-wrap group-data-horizontal/tabs:h-auto">
              {(['context', 'statistics', 'resources', 'agents'] as const).map(
                (kind) => (
                  <TabsTrigger key={kind} value={kind} className="h-8">
                    {t(kind)}
                  </TabsTrigger>
                ),
              )}
            </TabsList>
            <Button
              variant="outline"
              size="sm"
              disabled={read.loading}
              onClick={read.refresh}
            >
              {t('refresh')}
            </Button>
          </div>
          <TabsContent
            value={tab}
            className="min-h-0 flex-1 space-y-4 overflow-auto"
            aria-busy={read.loading}
          >
            {read.error && <p role="alert">{t('failed')}</p>}
            {read.loading && !snapshot && <p role="status">{t('loading')}</p>}
            {snapshot?.value.availability === 'partial' && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('partial')}
              </p>
            )}
            {snapshot && (
              <CoverageReasons
                reasons={[
                  ...snapshot.value.coverageReasons,
                  ...(snapshot.kind === 'statistics'
                    ? (snapshot.value.statistics?.coverage.gaps ?? [])
                    : []),
                  ...(snapshot.kind === 'context' &&
                  snapshot.value.context?.attributionComplete === false
                    ? ['attribution_incomplete']
                    : []),
                ]}
              />
            )}
            {snapshot?.value.availability === 'unsupported' ? (
              <p>{t('unsupported')}</p>
            ) : snapshot?.value.availability === 'not_recorded' ? (
              <p>{t('not_recorded')}</p>
            ) : snapshot?.kind === 'context' ? (
              <ContextSnapshot value={snapshot.value} />
            ) : snapshot?.kind === 'statistics' ? (
              <StatisticsSnapshot value={snapshot.value} />
            ) : snapshot?.kind === 'resources' ? (
              <ResourcesSnapshot value={snapshot.value} />
            ) : snapshot?.kind === 'agents' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('directOnly')}
                </p>
                {snapshot.value.items.length === 0 && <p>{t('empty')}</p>}
                {snapshot.value.items.map((task) => (
                  <div
                    key={task.taskId}
                    className="space-y-2 rounded-md border p-3"
                  >
                    <p className="break-words font-medium">
                      {task.description ?? task.taskId}
                    </p>
                    <Field label={t('state')}>{task.state}</Field>
                    <Field label={t('createdAt')}>
                      {new Date(task.createdAt).toLocaleString()}
                    </Field>
                    {task.childSessionId && onOpenChild && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpenChild(task.childSessionId!)}
                      >
                        {t('openChild')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            {tab === 'agents' && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={read.loading || !read.hasPrevious}
                  onClick={read.previous}
                >
                  {t('previous')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    read.loading ||
                    snapshot?.kind !== 'agents' ||
                    !snapshot.value.hasMore
                  }
                  onClick={read.next}
                >
                  {t('next')}
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
