import { useEffect, useMemo, useRef, useState } from 'react';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedTask,
  ManagedTaskEvent,
  ManagedTaskPage,
} from './managed-agent-provider';

export function isManagedTaskTerminal(task: ManagedTask): boolean {
  return ['completed', 'failed', 'cancelled'].includes(task.state);
}

function retainTerminalTask(
  previous: ManagedTask | undefined,
  task: ManagedTask,
): ManagedTask {
  return previous &&
    isManagedTaskTerminal(previous) &&
    !isManagedTaskTerminal(task)
    ? previous
    : task;
}

export function useManagedTasks(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
  open: boolean,
) {
  const owner = useMemo(() => ({ provider, sessionId }), [provider, sessionId]);
  const [state, setState] = useState<{
    owner: typeof owner;
    cursors: Array<string | undefined>;
    page: ManagedTaskPage;
    selectedId?: string;
    task?: ManagedTask;
    events: ManagedTaskEvent[];
    eventCursor?: string;
    moreEvents: boolean;
    historyGap: boolean;
    loading: boolean;
    error?: unknown;
  }>({
    owner,
    cursors: [undefined],
    page: { data: [], hasMore: false },
    events: [],
    moreEvents: false,
    historyGap: false,
    loading: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(() => !document.hidden);
  const generation = useRef(0);
  const ownsState = state.owner === owner;
  const selectedId = ownsState ? state.selectedId : undefined;
  const cursor = ownsState ? state.cursors.at(-1) : undefined;

  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    setState({
      owner,
      cursors: [undefined],
      page: { data: [], hasMore: false },
      events: [],
      moreEvents: false,
      historyGap: false,
      loading: false,
    });
  }, [owner]);

  useEffect(() => {
    const api = provider.tasks;
    if (!open || !visible || !sessionId || !api) return;
    const abort = new AbortController();
    const id = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !abort.signal.aborted && generation.current === id;
    const update = (patch: Partial<typeof state>) => {
      if (current())
        setState((value) =>
          value.owner === owner ? { ...value, ...patch } : value,
        );
    };
    async function poll(showLoading = false) {
      update(
        showLoading
          ? { loading: true, error: undefined }
          : { error: undefined },
      );
      const request = { clientId, signal: abort.signal };
      try {
        const page = await api!.list(sessionId!, {
          ...request,
          cursor,
          limit: 50,
        });
        if (page.data.some((task) => task.sessionId !== sessionId))
          throw new Error('Task page identity mismatch');
        if (current())
          setState((value) =>
            value.owner === owner
              ? {
                  ...value,
                  page: {
                    ...page,
                    data: page.data.map((task) =>
                      retainTerminalTask(
                        value.task?.taskId === task.taskId
                          ? value.task
                          : value.page.data.find(
                              (row) => row.taskId === task.taskId,
                            ),
                        task,
                      ),
                    ),
                  },
                }
              : value,
          );
        if (selectedId && current()) {
          const task = await api!.get(sessionId!, selectedId, request);
          if (task.sessionId !== sessionId || task.taskId !== selectedId)
            throw new Error('Task identity mismatch');
          if (current())
            setState((value) =>
              value.owner === owner && value.selectedId === selectedId
                ? {
                    ...value,
                    task: retainTerminalTask(
                      value.task ??
                        value.page.data.find(
                          (row) => row.taskId === task.taskId,
                        ),
                      task,
                    ),
                    page: {
                      ...value.page,
                      data: value.page.data.map((row) =>
                        row.taskId === task.taskId
                          ? retainTerminalTask(row, task)
                          : row,
                      ),
                    },
                  }
                : value,
            );
          const previous = stateRef.current;
          if (!previous.moreEvents && current()) {
            try {
              const page = await api!.listEvents(sessionId!, selectedId, {
                ...request,
                after: previous.eventCursor,
                limit: 50,
              });
              if (
                page.data.some(
                  (event) =>
                    event.sessionId !== sessionId ||
                    event.taskId !== selectedId,
                )
              )
                throw new Error('Task event identity mismatch');
              if (current())
                setState((value) => {
                  if (value.owner !== owner || value.selectedId !== selectedId)
                    return value;
                  const events = [
                    ...new Map(
                      [...value.events, ...page.data].map((event) => [
                        event.cursor,
                        event,
                      ]),
                    ).values(),
                  ];
                  return {
                    ...value,
                    events,
                    eventCursor: page.nextCursor,
                    moreEvents: page.hasMore,
                  };
                });
            } catch (error) {
              if (
                error instanceof JavaManagedAgentHttpError &&
                error.code === 'cursor_expired'
              )
                update({
                  events: [],
                  eventCursor: undefined,
                  moreEvents: false,
                  historyGap: true,
                });
              else throw error;
            }
          }
        }
      } catch (error) {
        update({ error });
      } finally {
        update({ loading: false });
        if (current()) timer = setTimeout(() => void poll(), 3_000);
      }
    }
    void poll(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    owner,
    provider,
    clientId,
    sessionId,
    open,
    visible,
    cursor,
    selectedId,
    revision,
  ]);

  return {
    page: ownsState ? state.page : { data: [], hasMore: false },
    task: ownsState ? state.task : undefined,
    selectedId,
    events: ownsState ? state.events : [],
    moreEvents: ownsState && state.moreEvents,
    historyGap: ownsState && state.historyGap,
    loading: ownsState && state.loading,
    error: ownsState ? state.error : undefined,
    hasPrevious: ownsState && state.cursors.length > 1,
    refresh: () => {
      ++generation.current;
      setRevision((value) => value + 1);
    },
    apply: (task: ManagedTask) => {
      setState((value) =>
        value.owner !== owner || task.sessionId !== sessionId
          ? value
          : {
              ...value,
              task:
                value.selectedId === task.taskId
                  ? retainTerminalTask(value.task, task)
                  : value.task,
              page: {
                ...value.page,
                data: value.page.data.map((row) =>
                  row.taskId === task.taskId
                    ? retainTerminalTask(row, task)
                    : row,
                ),
              },
            },
      );
    },
    select: (taskId?: string) => {
      ++generation.current;
      setRevision((value) => value + 1);
      setState((value) => ({
        ...value,
        selectedId: taskId,
        loading: true,
        task: undefined,
        events: [],
        eventCursor: undefined,
        moreEvents: false,
        historyGap: false,
        error: undefined,
      }));
    },
    next: () => {
      ++generation.current;
      setRevision((value) => value + 1);
      setState((value) =>
        value.page.hasMore && value.page.nextCursor
          ? {
              ...value,
              cursors: [...value.cursors, value.page.nextCursor],
              page: { data: [], hasMore: false },
              loading: true,
              error: undefined,
            }
          : value,
      );
    },
    previous: () => {
      ++generation.current;
      setRevision((value) => value + 1);
      setState((value) =>
        value.cursors.length > 1
          ? {
              ...value,
              cursors: value.cursors.slice(0, -1),
              page: { data: [], hasMore: false },
              loading: true,
              error: undefined,
            }
          : value,
      );
    },
    loadMoreEvents: () => {
      ++generation.current;
      setState((value) => ({ ...value, moreEvents: false }));
      setRevision((value) => value + 1);
    },
  };
}
