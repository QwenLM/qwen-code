import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { sanitizeControlChars } from '../messages/toolFormatting';
import { ManagedArtifactContent } from './ManagedToolResultPanel';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedArtifact,
  ManagedToolResultReader,
} from './managed-tool-result-types';
import type { ManagedTask } from './managed-agent-provider';
import type { useManagedTasks } from './use-managed-tasks';
import type {
  ManagedTaskCancelState,
  useManagedTaskCancel,
} from './use-managed-task-cancel';

export function taskCancelMessage(state: ManagedTaskCancelState): string {
  return `managed.tasks.cancel.${state.status}`;
}

function taskErrorKey(code?: string): string {
  switch (code) {
    case 'task_forbidden':
    case 'actor_required':
    case 'actor_scope_mismatch':
      return 'managed.tasks.forbidden';
    case 'session_operation_active':
      return 'managed.tasks.operationBusy';
    case 'session_not_active':
      return 'managed.tasks.sessionInactive';
    case 'task_action_unavailable':
    case 'task_already_settled':
      return 'managed.tasks.actionUnavailable';
    case 'workspace_unavailable':
      return 'managed.tasks.workspaceUnavailable';
    case 'task_not_found':
    case 'session_not_found':
      return 'managed.tasks.notFound';
    case 'storage_unavailable':
      return 'managed.tasks.storage';
    default:
      return 'managed.tasks.readFailed';
  }
}

// Typed by the generated union, so a label for a kind the contract does
// not name fails the type check; a newer server's kind still reads as other.
const TASK_KINDS = new Set<ManagedTask['kind']>([
  'child_agent',
  'workflow',
  'background_shell',
  'monitor',
  'automation_run',
  'channel_delivery',
]);

function taskKindKey(kind: ManagedTask['kind']): string {
  return `managed.tasks.kind.${TASK_KINDS.has(kind) ? kind : 'other'}`;
}

export function ManagedTaskPanel({
  wide,
  tasks,
  cancel,
  canCancel,
  reader,
  clientId,
  sessionId,
  onClose,
  restoreFocus,
}: {
  wide: boolean;
  tasks: ReturnType<typeof useManagedTasks>;
  cancel: ReturnType<typeof useManagedTaskCancel>;
  canCancel: boolean;
  reader?: ManagedToolResultReader;
  clientId: string;
  sessionId: string;
  onClose: () => void;
  restoreFocus: () => void;
}) {
  const { t, language } = useI18n();
  const heading = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  const [confirm, setConfirm] = useState<string>();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [artifactId, setArtifactId] = useState<string>();
  useEffect(() => {
    setConfirm(undefined);
    setArtifactId(undefined);
  }, [tasks.selectedId]);
  useLayoutEffect(() => {
    if (!tasks.selectedId && listRef.current)
      listRef.current.scrollTop = scroll.current;
    bodyRef.current?.focus();
  }, [tasks.selectedId]);
  useLayoutEffect(() => {
    if (confirm) confirmRef.current?.focus();
    else bodyRef.current?.focus();
  }, [confirm]);
  const time = (value?: number) =>
    value === undefined
      ? t('managed.tasks.notStarted')
      : new Date(value).toLocaleString(language);
  const task = tasks.task;
  const close = () => {
    onClose();
    if (wide) restoreFocus();
  };
  const status = (taskId: string) => {
    const state = cancel.states[taskId];
    if (!state) return null;
    return (
      <div className="space-y-1" data-task-cancel-status={taskId}>
        <p role="status">{t(taskCancelMessage(state))}</p>
        {state.code && (
          <p className="text-muted-foreground">{t(taskErrorKey(state.code))}</p>
        )}
        {cancel.pendingTaskIds.includes(taskId) && !state.busy && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void cancel.resume(taskId)}
          >
            {t('managed.tasks.continue')}
          </Button>
        )}
      </div>
    );
  };
  const cancelControl = (task: ManagedTask) => {
    const state = cancel.states[task.taskId];
    if (cancel.pendingTaskIds.includes(task.taskId)) return status(task.taskId);
    return (
      <div className="space-y-2">
        {status(task.taskId)}
        {canCancel &&
          task.actionCapabilities.includes('cancel') &&
          (confirm === task.taskId ? (
            <div className="space-y-2">
              <p>{t('managed.tasks.confirmDescription')}</p>
              <div className="flex gap-2">
                <Button
                  ref={confirmRef}
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setConfirm(undefined);
                    void cancel.submit(task);
                  }}
                >
                  {t('managed.tasks.confirmCancel')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirm(undefined)}
                >
                  {t('managed.tasks.keepRunning')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={state?.busy}
              onClick={() => setConfirm(task.taskId)}
            >
              {t('managed.tasks.requestCancel')}
            </Button>
          ))}
      </div>
    );
  };

  const body = (
    <div
      ref={bodyRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col gap-3 outline-none"
    >
      <div className="flex shrink-0 flex-wrap gap-2">
        {tasks.selectedId && (
          <Button variant="ghost" size="sm" onClick={() => tasks.select()}>
            {t('managed.tasks.back')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={tasks.refresh}
          disabled={tasks.loading}
        >
          {t('managed.refresh')}
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          {t('managed.tasks.close')}
        </Button>
      </div>
      {tasks.error !== undefined && (
        <p role="alert" className="text-destructive">
          {t(
            taskErrorKey(
              tasks.error instanceof JavaManagedAgentHttpError
                ? tasks.error.code
                : undefined,
            ),
          )}
        </p>
      )}
      {tasks.loading && <p role="status">{t('managed.loading')}</p>}
      {!tasks.selectedId ? (
        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto"
          onScroll={(event) => {
            scroll.current = event.currentTarget.scrollTop;
          }}
        >
          {tasks.page.data.map((task) => (
            <div key={task.taskId} className="space-y-2 rounded-md border p-3">
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal text-left"
                onClick={() => tasks.select(task.taskId)}
              >
                {t(taskKindKey(task.kind))} ·{' '}
                {task.taskId.replace(/^task_/, '').slice(0, 8)}
              </Button>
              <Badge variant="secondary">
                {t(`managed.tasks.state.${task.state}`)}
              </Badge>
              <p className="text-muted-foreground">{time(task.createdAt)}</p>
              {cancelControl(task)}
            </div>
          ))}
          {!tasks.loading &&
            tasks.error === undefined &&
            !tasks.page.data.length && (
              <p className="text-muted-foreground">
                {t(
                  tasks.page.hasMore || tasks.hasPrevious
                    ? 'managed.tasks.emptyPage'
                    : 'managed.tasks.empty',
                )}
              </p>
            )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!tasks.hasPrevious || tasks.loading}
              onClick={tasks.previous}
            >
              {t('managed.tasks.previous')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!tasks.page.hasMore || tasks.loading}
              onClick={tasks.next}
            >
              {t('managed.tasks.next')}
            </Button>
          </div>
          {cancel.pendingTaskIds
            .filter((id) => !tasks.page.data.some((task) => task.taskId === id))
            .map((id) => (
              <div key={id} className="rounded-md border p-3">
                <p className="break-all">{id}</p>
                {status(id)}
              </div>
            ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {!task && !tasks.loading && tasks.error === undefined && (
            <p role="status">{t('managed.loading')}</p>
          )}
          {task && (
            <>
              <p className="font-medium">{t(taskKindKey(task.kind))}</p>
              <p className="break-all">{task.taskId}</p>
              <Badge variant="secondary">
                {t(`managed.tasks.state.${task.state}`)}
              </Badge>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 [&>dt]:text-muted-foreground [&>dd]:break-all">
                <dt>{t('managed.tasks.created')}</dt>
                <dd>{time(task.createdAt)}</dd>
                <dt>{t('managed.tasks.started')}</dt>
                <dd>{time(task.startedAt)}</dd>
                <dt>{t('managed.tasks.settled')}</dt>
                <dd>
                  {task.settledAt
                    ? time(task.settledAt)
                    : t('managed.tasks.unsettled')}
                </dd>
                {task.startedAt !== undefined && (
                  <>
                    <dt>{t('managed.tasks.elapsed')}</dt>
                    <dd>
                      {t('managed.tasks.seconds', {
                        seconds: Math.max(
                          0,
                          Math.floor(
                            ((task.settledAt ?? Date.now()) - task.startedAt) /
                              1000,
                          ),
                        ),
                      })}
                    </dd>
                  </>
                )}
                {task.runtimeState && (
                  <>
                    <dt>{t('managed.runtime')}</dt>
                    <dd>{t(`managed.tasks.runtime.${task.runtimeState}`)}</dd>
                  </>
                )}
              </dl>
              {cancelControl(task)}
            </>
          )}
          <h3 className="font-medium">{t('managed.tasks.events')}</h3>
          {tasks.historyGap && (
            <p role="status">{t('managed.tasks.historyGap')}</p>
          )}
          <ol className="space-y-2">
            {tasks.events.flatMap((event) => {
              if (
                event.type !== 'state_changed' &&
                event.type !== 'output' &&
                event.type !== 'artifact'
              )
                return [];
              return (
                <li key={event.cursor} className="rounded-md border p-2">
                  <p className="text-muted-foreground">
                    {time(event.createdAt)}
                  </p>
                  {event.type === 'state_changed' && event.state && (
                    <p>{t(`managed.tasks.state.${event.state}`)}</p>
                  )}
                  {event.type === 'state_changed' && event.runtimeState && (
                    <p>
                      {t('managed.runtime')}:{' '}
                      {t(`managed.tasks.runtime.${event.runtimeState}`)}
                    </p>
                  )}
                  {event.type === 'output' && (
                    <pre className="whitespace-pre-wrap break-words">
                      {sanitizeControlChars(event.text ?? '')}
                    </pre>
                  )}
                  {event.truncated && (
                    <p>{t('managed.result.previewTruncated')}</p>
                  )}
                  {event.type === 'artifact' && (
                    <p className="break-all">{event.artifactId}</p>
                  )}
                </li>
              );
            })}
          </ol>
          {!tasks.events.length &&
            !tasks.loading &&
            tasks.error === undefined && <p>{t('managed.tasks.noEvents')}</p>}
          {tasks.moreEvents && (
            <Button
              variant="outline"
              size="sm"
              disabled={tasks.loading}
              onClick={tasks.loadMoreEvents}
            >
              {t('managed.more')}
            </Button>
          )}
          <h3 className="font-medium">{t('managed.result.outputs')}</h3>
          {task && !task.artifactRefs.length && (
            <p>{t('managed.tasks.noArtifacts')}</p>
          )}
          {task?.artifactRefs.map((id) => (
            <Button
              key={id}
              variant="outline"
              size="sm"
              className="max-w-full"
              disabled={!reader}
              onClick={() => setArtifactId(id)}
            >
              <span className="truncate">{id}</span>
            </Button>
          ))}
          {artifactId && reader && (
            <TaskArtifact
              key={`${sessionId}:${artifactId}`}
              sessionId={sessionId}
              artifactId={artifactId}
              reader={reader}
              clientId={clientId}
            />
          )}
        </div>
      )}
    </div>
  );

  if (wide)
    return (
      <aside
        className="flex w-[360px] min-h-0 flex-col gap-3 rounded-md border p-3"
        aria-labelledby={heading}
        data-managed-task-panel="side"
      >
        <h2 id={heading} className="font-medium">
          {t('managed.tasks.title')}
        </h2>
        {body}
      </aside>
    );
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="flex h-[90vh] flex-col sm:max-w-lg"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('managed.tasks.title')}</DialogTitle>
          <DialogDescription>
            {t('managed.tasks.description')}
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-managed-task-panel="dialog"
        >
          {body}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TaskArtifact({
  sessionId,
  artifactId,
  reader,
  clientId,
}: {
  sessionId: string;
  artifactId: string;
  reader: ManagedToolResultReader;
  clientId: string;
}) {
  const { t } = useI18n();
  const [artifact, setArtifact] = useState<ManagedArtifact>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void reader
      .getArtifact(sessionId, artifactId, { clientId, signal: abort.signal })
      .then((response) => {
        if (abort.signal.aborted) return;
        if (
          response.artifact.session_id !== sessionId ||
          response.artifact.id !== artifactId
        )
          throw new Error('Task artifact identity mismatch');
        setArtifact(response.artifact);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [sessionId, artifactId, reader, clientId]);
  if (error) return <p role="alert">{t('managed.tasks.readFailed')}</p>;
  return artifact ? (
    <ManagedArtifactContent
      artifact={artifact}
      reader={reader}
      clientId={clientId}
    />
  ) : (
    <p role="status">{t('managed.loading')}</p>
  );
}
