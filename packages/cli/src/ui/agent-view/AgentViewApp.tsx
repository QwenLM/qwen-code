/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render } from 'ink';
import { clearScreen } from '../../utils/stdioHelpers.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { AgentViewRoster } from './AgentViewRoster.js';
import type {
  AgentViewHeaderInfo,
  AgentViewNotice,
  AgentViewPeekPanel,
} from './AgentViewRoster.js';
import { filterAgentRosterRows } from './roster-model.js';
import type { AgentRosterGroupMode, AgentRosterRow } from './roster-model.js';

export interface AgentViewAppActions {
  dispatchPrompt(prompt: string, attach: boolean): Promise<unknown>;
  peekSelected(sessionId: string): Promise<AgentViewPeekPanel>;
  sendToSession(sessionId: string, text: string): Promise<unknown>;
  answerSession(sessionId: string, text: string): Promise<unknown>;
  pinSession(sessionId: string): Promise<unknown>;
  renameSession(sessionId: string, displayName: string): Promise<unknown>;
  stopSession(sessionId: string): Promise<unknown>;
  removeSession(sessionId: string): Promise<unknown>;
  loadRows(): Promise<AgentRosterRow[]>;
  subscribeToChanges?(onChange: () => void): { dispose(): void };
}

export type AgentViewRosterResult =
  | { type: 'exit' }
  | { type: 'attach'; sessionId: string }
  | { type: 'resume' };

export interface AgentViewAppProps {
  rows: AgentRosterRow[];
  actions: AgentViewAppActions;
  onExit: () => void;
  onAttachRequested?: (sessionId: string) => void;
  onResumeRequested?: () => void;
  header?: AgentViewHeaderInfo;
  initialPeekPanel?: AgentViewPeekPanel;
  refreshIntervalMs?: number;
}

interface ReplyTarget {
  sessionId: string;
  mode: 'answer' | 'send';
}

interface PeekSubmittedPreview {
  sessionId: string;
  prompt: string;
}

const STOP_REMOVE_CONFIRM_MS = 2000;

export function AgentViewApp({
  rows,
  actions,
  onExit,
  onAttachRequested,
  onResumeRequested,
  header,
  initialPeekPanel,
  refreshIntervalMs,
}: AgentViewAppProps) {
  const [currentRows, setCurrentRows] = useState(rows);
  const [prompt, setPrompt] = useState('');
  const [promptVersion, setPromptVersion] = useState(0);
  const [peekPrompt, setPeekPrompt] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | undefined
  >(rows[0]?.sessionId);
  const [peekPanel, setPeekPanel] = useState<AgentViewPeekPanel | undefined>(
    initialPeekPanel,
  );
  const [notice, setNotice] = useState<AgentViewNotice>();
  const [peekReplyTarget, setPeekReplyTarget] = useState<ReplyTarget>();
  const [peekSubmittedPreview, setPeekSubmittedPreview] =
    useState<PeekSubmittedPreview>();
  const [groupMode, setGroupMode] = useState<AgentRosterGroupMode>('state');
  const rowsPropRef = useRef(rows);
  const lastStopRequestRef = useRef<
    | {
        sessionId: string;
        at: number;
      }
    | undefined
  >(undefined);
  const stopRemoveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const [lastInterruptAt, setLastInterruptAt] = useState(0);
  const dispatchInFlightRef = useRef(false);
  const peekSubmitInFlightRef = useRef(false);
  const pinInFlightRef = useRef(false);
  const promptRevisionRef = useRef(0);
  // Invalidates in-flight peek loads on every open/close so a stale response
  // can never overwrite a newer panel or resurrect a closed one.
  const peekGenerationRef = useRef(0);
  const displayFilter =
    peekPanel && peekPanel.title !== 'Filter'
      ? undefined
      : getDisplayFilter(prompt);
  const visibleRows = useMemo(
    () => filterAgentRosterRows(currentRows, displayFilter),
    [currentRows, displayFilter],
  );
  const selectedIndex = getSelectedIndex(visibleRows, selectedSessionId);

  useEffect(() => {
    if (rowsPropRef.current === rows) {
      return;
    }
    rowsPropRef.current = rows;
    setCurrentRows(rows);
  }, [rows]);

  useEffect(() => {
    if (visibleRows.length === 0) {
      setSelectedSessionId(undefined);
      return;
    }
    if (!visibleRows.some((row) => row.sessionId === selectedSessionId)) {
      setSelectedSessionId(visibleRows[0]?.sessionId);
    }
  }, [selectedSessionId, visibleRows]);

  useEffect(() => {
    if (!peekPanel) return;
    const row = currentRows.find((item) => item.sessionId === peekPanel.title);
    if (!row) {
      if (peekPanel.title !== 'Filter') {
        if (peekPanel.error) return;
        // The peeked session disappeared; close the stale panel instead of
        // leaving a reply input aimed at a removed session.
        peekGenerationRef.current += 1;
        setPeekReplyTarget(undefined);
        setPeekSubmittedPreview(undefined);
        setPeekPanel(undefined);
      }
      return;
    }
    setPeekReplyTarget(getReplyTarget(row));
    if (peekSubmittedPreview?.sessionId === row.sessionId && !isPending(row)) {
      setPeekSubmittedPreview(undefined);
    }
  }, [currentRows, peekPanel, peekSubmittedPreview]);

  const refreshRows = useCallback(async () => {
    const rows = await actions.loadRows();
    setCurrentRows(rows);
    return rows;
  }, [actions]);

  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return undefined;
    const interval = setInterval(() => {
      void refreshRows().catch(() => {});
    }, refreshIntervalMs);
    return () => {
      clearInterval(interval);
    };
  }, [refreshIntervalMs, refreshRows]);

  useEffect(() => {
    const subscription = actions.subscribeToChanges?.(() => {
      void refreshRows().catch(() => {});
    });
    return () => {
      subscription?.dispose();
    };
  }, [actions, refreshRows]);

  useEffect(
    () => () => {
      if (stopRemoveTimerRef.current) {
        clearTimeout(stopRemoveTimerRef.current);
      }
    },
    [],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (visibleRows.length === 0) {
        setSelectedSessionId(undefined);
        return;
      }
      const nextIndex = Math.min(
        visibleRows.length - 1,
        Math.max(0, selectedIndex + delta),
      );
      setSelectedSessionId(visibleRows[nextIndex]?.sessionId);
    },
    [selectedIndex, visibleRows],
  );

  const dispatch = useCallback(
    (attach: boolean, promptOverride?: string): boolean => {
      if (dispatchInFlightRef.current) {
        setNotice({
          lines: ['Starting session...'],
        });
        setPeekReplyTarget(undefined);
        setPeekPrompt('');
        return false;
      }
      const promptToSubmit = promptOverride ?? prompt;

      if (isRosterExitCommand(promptToSubmit)) {
        onExit();
        return true;
      }

      if (isRosterResumeCommand(promptToSubmit)) {
        setPrompt('');
        onResumeRequested?.();
        return true;
      }

      if (isBlockingFilterPrompt(promptToSubmit)) {
        const matchingRows = filterAgentRosterRows(currentRows, promptToSubmit);
        setPeekPanel({
          title: 'Filter',
          lines: [`Showing ${matchingRows.length} matching session(s).`],
        });
        setPeekReplyTarget(undefined);
        setPeekPrompt('');
        return true;
      }

      const submitted = promptToSubmit;
      const restoreRevision = promptRevisionRef.current;
      dispatchInFlightRef.current = true;
      setPrompt('');
      setNotice({
        lines: [`Starting session: ${submitted}`],
      });
      peekGenerationRef.current += 1;
      setPeekPanel(undefined);
      setPeekReplyTarget(undefined);
      setPeekPrompt('');

      void (async () => {
        try {
          const result = await actions.dispatchPrompt(submitted, attach);
          dispatchInFlightRef.current = false;
          if (attach) {
            const sessionId = getDispatchedSessionId(result);
            if (!sessionId) {
              if (promptRevisionRef.current === restoreRevision) {
                setPrompt(submitted);
                setPromptVersion((current) => current + 1);
              }
              setNotice({
                lines: ['Agent dispatch did not return a session id.'],
              });
              setPeekReplyTarget(undefined);
              setPeekPrompt('');
              return;
            }
            onAttachRequested?.(sessionId);
            return;
          }
          // The dispatch itself succeeded; a refresh failure must not present
          // it as a failed dispatch (a re-Enter would duplicate the session).
          try {
            await refreshRows();
          } catch {
            // Rows catch up on the next poll tick.
          }
          setNotice({
            lines: ['Dispatched.'],
          });
          setPeekReplyTarget(undefined);
          setPeekPrompt('');
        } catch (error) {
          dispatchInFlightRef.current = false;
          if (promptRevisionRef.current === restoreRevision) {
            setPrompt(submitted);
            setPromptVersion((current) => current + 1);
          }
          setNotice({
            lines: [error instanceof Error ? error.message : String(error)],
          });
          setPeekReplyTarget(undefined);
          setPeekPrompt('');
        }
      })();
      return true;
    },
    [
      actions,
      currentRows,
      onAttachRequested,
      onExit,
      onResumeRequested,
      prompt,
      refreshRows,
    ],
  );

  const submitPeekPrompt = useCallback(
    (promptOverride?: string) => {
      const promptToSubmit = promptOverride ?? peekPrompt;
      if (!peekReplyTarget || !promptToSubmit.trim()) return;
      if (peekSubmitInFlightRef.current) return;

      const currentRow = currentRows.find(
        (row) => row.sessionId === peekReplyTarget.sessionId,
      );
      const target = currentRow
        ? (getReplyTarget(currentRow) ?? peekReplyTarget)
        : peekReplyTarget;
      const submitted = promptToSubmit;
      const generation = peekGenerationRef.current;
      setPeekPrompt('');
      setPeekSubmittedPreview({
        sessionId: target.sessionId,
        prompt: submitted,
      });
      setPeekReplyTarget(undefined);
      setPeekPanel((current) => {
        if (current?.title === target.sessionId) return current;
        return { title: target.sessionId, lines: [] };
      });
      peekSubmitInFlightRef.current = true;
      void (async () => {
        try {
          if (target.mode === 'answer') {
            await actions.answerSession(target.sessionId, submitted);
          } else {
            await actions.sendToSession(target.sessionId, submitted);
          }
          // The reply was delivered; only restore it if the send itself
          // failed, never on a post-success refresh failure.
          try {
            const rows = await refreshRows();
            const row = rows.find(
              (item) => item.sessionId === target.sessionId,
            );
            setPeekReplyTarget(row ? getReplyTarget(row) : undefined);
          } catch {
            setPeekReplyTarget(undefined);
          }
        } catch (error) {
          // Restore the undelivered reply for retry, but never resurrect a
          // panel the user closed (or overwrite a newer one) while the send
          // was in flight.
          setPeekSubmittedPreview(undefined);
          if (peekGenerationRef.current === generation) {
            setPeekPrompt(submitted);
            setPeekPanel({
              title: target.sessionId,
              lines: [
                `Prompt: ${submitted}`,
                error instanceof Error ? error.message : String(error),
              ],
              error: true,
            });
          } else {
            setNotice({
              lines: [
                `Reply was not sent: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ],
            });
          }
        } finally {
          peekSubmitInFlightRef.current = false;
        }
      })();
    },
    [actions, currentRows, peekPrompt, peekReplyTarget, refreshRows],
  );

  const attachSelected = useCallback(
    (sessionId?: string) => {
      const row = sessionId
        ? visibleRows.find((item) => item.sessionId === sessionId)
        : visibleRows[selectedIndex];
      if (!row) return;
      if (!row.actions.canAttach) {
        setNotice({
          lines: ['This session is not attachable right now.'],
        });
        return;
      }
      setSelectedSessionId(row.sessionId);
      onAttachRequested?.(row.sessionId);
    },
    [onAttachRequested, selectedIndex, visibleRows],
  );

  const peekSelected = useCallback(() => {
    const row = visibleRows[selectedIndex];
    if (!row) return;
    setSelectedSessionId(row.sessionId);
    setNotice(undefined);
    setPeekSubmittedPreview(undefined);
    setPeekReplyTarget(getReplyTarget(row));
    setPeekPrompt('');
    const generation = ++peekGenerationRef.current;
    setPeekPanel({ title: row.sessionId, lines: ['Loading...'] });
    void Promise.resolve(actions.peekSelected(row.sessionId)).then(
      (panel) => {
        if (peekGenerationRef.current === generation) {
          setPeekPanel(panel);
        }
      },
      (error) => {
        if (peekGenerationRef.current !== generation) return;
        setPeekPanel({
          title: row.sessionId,
          lines: [error instanceof Error ? error.message : String(error)],
          error: true,
        });
      },
    );
  }, [actions, selectedIndex, visibleRows]);

  const togglePinSelected = useCallback(() => {
    const row = visibleRows[selectedIndex];
    if (!row || pinInFlightRef.current) return;
    pinInFlightRef.current = true;
    void (async () => {
      try {
        await actions.pinSession(row.sessionId);
        await refreshRows();
        setNotice({
          lines: [row.pinned ? 'Unpinned.' : 'Pinned.'],
        });
      } catch (error) {
        setNotice({
          lines: [error instanceof Error ? error.message : String(error)],
        });
      } finally {
        pinInFlightRef.current = false;
      }
    })();
  }, [actions, refreshRows, selectedIndex, visibleRows]);

  const renameSelected = useCallback(
    (displayName: string) => {
      const row = visibleRows[selectedIndex];
      if (!row) return;
      const previousPrompt = displayName;
      const restoreRevision = promptRevisionRef.current;
      setPrompt('');
      void (async () => {
        try {
          await actions.renameSession(row.sessionId, displayName);
          await refreshRows();
          setNotice({
            lines: [
              displayName ? `Renamed to ${displayName}.` : 'Name cleared.',
            ],
          });
        } catch (error) {
          if (promptRevisionRef.current === restoreRevision) {
            setPrompt(previousPrompt);
            setPromptVersion((current) => current + 1);
          }
          setNotice({
            lines: [error instanceof Error ? error.message : String(error)],
          });
        }
      })();
    },
    [actions, refreshRows, selectedIndex, visibleRows],
  );

  const stopOrRemoveSelected = useCallback(
    (sessionId?: string) => {
      const row = sessionId
        ? visibleRows.find((item) => item.sessionId === sessionId)
        : visibleRows[selectedIndex];
      if (!row) return;
      const now = Date.now();
      const pendingStop = lastStopRequestRef.current;
      const remove =
        pendingStop?.sessionId === row.sessionId &&
        now - pendingStop.at <= STOP_REMOVE_CONFIRM_MS;
      const showRemoveHint = (message: string) => {
        const hintAt = Date.now();
        lastStopRequestRef.current = { sessionId: row.sessionId, at: hintAt };
        if (stopRemoveTimerRef.current) {
          clearTimeout(stopRemoveTimerRef.current);
        }
        stopRemoveTimerRef.current = setTimeout(() => {
          const current = lastStopRequestRef.current;
          if (current?.sessionId === row.sessionId && current.at === hintAt) {
            lastStopRequestRef.current = undefined;
            setNotice(undefined);
          }
        }, STOP_REMOVE_CONFIRM_MS);
        setNotice({ lines: [message] });
      };
      lastStopRequestRef.current = remove
        ? undefined
        : { sessionId: row.sessionId, at: now };
      if (remove && stopRemoveTimerRef.current) {
        clearTimeout(stopRemoveTimerRef.current);
        stopRemoveTimerRef.current = undefined;
      }
      if (!remove) {
        showRemoveHint('Stopped. Press Ctrl+X again to remove.');
      }
      const stopRequest = remove ? undefined : lastStopRequestRef.current;
      void (async () => {
        try {
          if (remove) {
            await actions.removeSession(row.sessionId);
          } else {
            await actions.stopSession(row.sessionId);
          }
          await refreshRows();
          if (remove) {
            setNotice({ lines: ['Removed.'] });
          }
        } catch (error) {
          const ownsStopRequest =
            remove || lastStopRequestRef.current === stopRequest;
          if (!remove && ownsStopRequest) {
            lastStopRequestRef.current = undefined;
            if (stopRemoveTimerRef.current) {
              clearTimeout(stopRemoveTimerRef.current);
              stopRemoveTimerRef.current = undefined;
            }
          }
          if (ownsStopRequest) {
            setNotice({
              lines: [error instanceof Error ? error.message : String(error)],
            });
          }
        }
      })();
    },
    [actions, refreshRows, selectedIndex, visibleRows],
  );

  const toggleGroupMode = useCallback(() => {
    setGroupMode((current) => (current === 'state' ? 'directory' : 'state'));
    setNotice({
      lines: [
        groupMode === 'state' ? 'Grouped by directory.' : 'Grouped by state.',
      ],
    });
  }, [groupMode]);

  const showHelp = useCallback(() => {
    setNotice({
      title: 'Shortcuts',
      lines: [
        'Enter/Right: attach',
        'Prompt + Enter: dispatch',
        'Shift+Enter: dispatch and attach',
        'Space: peek',
        'Ctrl+S: toggle grouping',
        'Ctrl+T: pin/unpin',
        'Ctrl+R: rename using prompt',
        'Ctrl+X: stop; press again to remove',
        'Esc: close, clear, or exit',
        'Ctrl+C: clear; press again to exit',
      ],
    });
  }, []);

  const interrupt = useCallback(() => {
    if (peekReplyTarget && peekPrompt) {
      setPeekPrompt('');
      setLastInterruptAt(Date.now());
      return;
    }
    if (prompt) {
      promptRevisionRef.current += 1;
      setPrompt('');
      setLastInterruptAt(Date.now());
      return;
    }
    const now = Date.now();
    if (now - lastInterruptAt <= 2000) {
      onExit();
      return;
    }
    setLastInterruptAt(now);
    setNotice({
      lines: ['Press Ctrl+C again to exit.'],
    });
  }, [lastInterruptAt, onExit, peekPrompt, peekReplyTarget, prompt]);

  const cancel = useCallback(() => {
    if (peekPanel) {
      peekGenerationRef.current += 1;
      setPeekReplyTarget(undefined);
      setPeekSubmittedPreview(undefined);
      setPeekPrompt('');
      setPeekPanel(undefined);
      return;
    }
    if (notice) {
      setNotice(undefined);
      return;
    }
    if (prompt) {
      promptRevisionRef.current += 1;
      setPrompt('');
      return;
    }
    onExit();
  }, [notice, onExit, peekPanel, prompt]);

  return (
    <AgentViewRoster
      rows={visibleRows}
      prompt={prompt}
      promptVersion={promptVersion}
      selectedIndex={selectedIndex}
      groupMode={groupMode}
      header={header}
      notice={notice}
      peekPanel={peekPanel}
      peekPrompt={peekPrompt}
      peekInputMode={peekReplyTarget?.mode}
      peekInputTarget={peekReplyTarget?.sessionId}
      peekQueuedPrompts={getPeekQueuedPrompts(
        peekSubmittedPreview,
        visibleRows,
        peekPanel,
      )}
      onPromptChange={setPrompt}
      onPromptEdit={() => {
        promptRevisionRef.current += 1;
      }}
      onPeekPromptChange={setPeekPrompt}
      onDispatch={dispatch}
      onSubmitPeekPrompt={submitPeekPrompt}
      onAttachSelected={attachSelected}
      onPeekSelected={peekSelected}
      onTogglePinSelected={togglePinSelected}
      onRenameSelected={renameSelected}
      onStopOrRemoveSelected={stopOrRemoveSelected}
      onToggleGroupMode={toggleGroupMode}
      onShowHelp={showHelp}
      onInterrupt={interrupt}
      onMoveSelection={moveSelection}
      onCancel={cancel}
    />
  );
}

function getReplyTarget(row: AgentRosterRow): ReplyTarget | undefined {
  // canReply and needsBlockingAnswer are mutually exclusive in deriveActions;
  // a blocking approval (e.g. 'Waiting: Edit') is only reachable through the
  // answer path, so it must not be gated out by canReply.
  if (!row.actions.canReply && !row.actions.needsBlockingAnswer) {
    return undefined;
  }
  if (
    (row.queuedPromptCount ?? 0) > 0 &&
    !(row.waitingFor && row.waitingFor !== 'response')
  ) {
    return undefined;
  }
  return {
    sessionId: row.sessionId,
    mode: row.actions.needsBlockingAnswer ? 'answer' : 'send',
  };
}

function getPeekQueuedPrompts(
  preview: PeekSubmittedPreview | undefined,
  rows: AgentRosterRow[],
  panel: AgentViewPeekPanel | undefined,
): string[] | undefined {
  const row = rows.find((item) => item.sessionId === panel?.title);
  if (
    preview &&
    preview.sessionId === panel?.title &&
    (!row || isPending(row))
  ) {
    return [preview.prompt];
  }
  if (!row || (row.queuedPromptCount ?? 0) <= 0) {
    return undefined;
  }
  const prompt = row.queuedPromptPreview?.trim();
  return prompt ? [prompt] : undefined;
}

function isPending(row: AgentRosterRow): boolean {
  return (row.queuedPromptCount ?? 0) > 0 || row.taskState === 'running';
}

function getSelectedIndex(
  rows: AgentRosterRow[],
  selectedSessionId: string | undefined,
): number {
  if (rows.length === 0) {
    return 0;
  }
  const index = rows.findIndex((row) => row.sessionId === selectedSessionId);
  return index >= 0 ? index : 0;
}

function getDisplayFilter(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  if (isBlockingFilterPrompt(trimmed)) return trimmed;
  return undefined;
}

function isBlockingFilterPrompt(prompt: string): boolean {
  return prompt
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some((term) => term.startsWith('s:'));
}

function isRosterExitCommand(prompt: string): boolean {
  return ['/quit', '/exit'].includes(prompt.trim().toLowerCase());
}

function isRosterResumeCommand(prompt: string): boolean {
  return ['/resume', '/continue'].includes(prompt.trim().toLowerCase());
}

function getDispatchedSessionId(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    typeof value.sessionId === 'string'
  ) {
    return value.sessionId;
  }
  return undefined;
}

export async function runAgentViewRosterApp(
  rows: AgentRosterRow[],
  actions: AgentViewAppActions,
  header?: AgentViewHeaderInfo,
  initialPeekPanel?: AgentViewPeekPanel,
): Promise<AgentViewRosterResult> {
  clearScreen();

  return new Promise<AgentViewRosterResult>((resolve) => {
    let settled = false;
    let resultToResolve: AgentViewRosterResult = { type: 'exit' };
    const cleanup: { unmount?: () => void } = {};
    const finish = (result: AgentViewRosterResult = { type: 'exit' }) => {
      if (settled) return;
      settled = true;
      resultToResolve = result;
      cleanup.unmount?.();
    };
    const instance = render(
      <KeypressProvider
        kittyProtocolEnabled={false}
        pasteWorkaround={
          process.platform === 'win32' ||
          Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) < 20
        }
      >
        <AgentViewApp
          rows={rows}
          actions={actions}
          header={header}
          initialPeekPanel={initialPeekPanel}
          onExit={finish}
          onAttachRequested={(sessionId) =>
            finish({ type: 'attach', sessionId })
          }
          onResumeRequested={() => finish({ type: 'resume' })}
          refreshIntervalMs={1000}
        />
      </KeypressProvider>,
      { exitOnCtrlC: false },
    );
    cleanup.unmount = instance.unmount;

    void instance.waitUntilExit().then(() => {
      clearScreen();
      resolve(resultToResolve);
    });
  });
}
