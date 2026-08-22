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
  AgentViewPanel,
  AgentViewSessionPanel,
} from './AgentViewRoster.js';
import {
  filterAgentRosterRows,
  isAgentRosterBlockingWait,
  orderAgentRosterRows,
  type AgentRosterGroupMode,
  type AgentRosterRow,
} from './roster-model.js';

export interface AgentViewAppActions {
  dispatchPrompt(prompt: string, attach: boolean): Promise<unknown>;
  peekSelected(sessionId: string): Promise<AgentViewSessionPanel>;
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
  initialPeekPanel?: AgentViewPanel;
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
  const [peekPanel, setPeekPanel] = useState<AgentViewPanel | undefined>(
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
  const lastInterruptAtRef = useRef(0);
  const dispatchInFlightRef = useRef(false);
  const peekSubmitInFlightRef = useRef(false);
  const pinInFlightRef = useRef(false);
  const promptRevisionRef = useRef(0);
  // Invalidates in-flight peek loads on every open/close so a stale response
  // can never overwrite a newer panel or resurrect a closed one.
  const peekGenerationRef = useRef(0);
  const displayFilter =
    peekPanel?.kind === 'filter'
      ? peekPanel.query
      : peekPanel
        ? undefined
        : getDisplayFilter(prompt);
  const visibleRows = useMemo(
    () =>
      orderAgentRosterRows(
        filterAgentRosterRows(currentRows, displayFilter),
        groupMode,
      ),
    [currentRows, displayFilter, groupMode],
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
    if (peekPanel.kind !== 'session') return;
    const row = currentRows.find(
      (item) => item.sessionId === peekPanel.sessionId,
    );
    if (!row) {
      setPeekReplyTarget(undefined);
      setPeekPrompt('');
      setPeekSubmittedPreview(undefined);
      if (peekPanel.tone !== 'error') {
        peekGenerationRef.current += 1;
        setPeekPanel(undefined);
      }
      return;
    }
    setPeekReplyTarget(getReplyTarget(row));
  }, [currentRows, peekPanel]);

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
      setSelectedSessionId((currentSessionId) => {
        const currentIndex = getSelectedIndex(visibleRows, currentSessionId);
        const nextIndex = Math.min(
          visibleRows.length - 1,
          Math.max(0, currentIndex + delta),
        );
        return visibleRows[nextIndex]?.sessionId;
      });
    },
    [visibleRows],
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
          kind: 'filter',
          query: promptToSubmit,
          lines: [`Showing ${matchingRows.length} matching session(s).`],
        });
        setPeekReplyTarget(undefined);
        setPeekPrompt('');
        return false;
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
    (promptOverride?: string): boolean => {
      const promptToSubmit = promptOverride ?? peekPrompt;
      if (!peekReplyTarget || !promptToSubmit.trim()) return false;
      if (peekSubmitInFlightRef.current) {
        setNotice({ lines: ['Reply is still being sent.'] });
        return false;
      }

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
      setPeekPanel((current) => {
        if (
          current?.kind === 'session' &&
          current.sessionId === target.sessionId &&
          current.tone !== 'error'
        ) {
          return current;
        }
        return {
          kind: 'session',
          sessionId: target.sessionId,
          content: 'activity',
          lines: [],
        };
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
          setPeekSubmittedPreview(undefined);
        } catch (error) {
          // Restore the undelivered reply for retry, but never resurrect a
          // panel the user closed (or overwrite a newer one) while the send
          // was in flight.
          setPeekSubmittedPreview(undefined);
          if (peekGenerationRef.current === generation) {
            peekGenerationRef.current += 1;
            setPeekPrompt((current) => current || submitted);
            setPeekPanel({
              kind: 'session',
              sessionId: target.sessionId,
              content: 'message',
              lines: [
                `Prompt: ${submitted}`,
                error instanceof Error ? error.message : String(error),
              ],
              tone: 'error',
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
      return true;
    },
    [actions, currentRows, peekPrompt, peekReplyTarget, refreshRows],
  );

  const attachSession = useCallback(
    (sessionId: string) => {
      const row = visibleRows.find((item) => item.sessionId === sessionId);
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
    [onAttachRequested, visibleRows],
  );

  const peekSession = useCallback(
    (sessionId: string) => {
      const row = visibleRows.find((item) => item.sessionId === sessionId);
      if (!row) return;
      setSelectedSessionId(row.sessionId);
      setNotice(undefined);
      setPeekSubmittedPreview(undefined);
      setPeekReplyTarget(getReplyTarget(row));
      setPeekPrompt('');
      const generation = ++peekGenerationRef.current;
      setPeekPanel({
        kind: 'session',
        sessionId: row.sessionId,
        content: 'message',
        lines: ['Loading...'],
      });
      void Promise.resolve(actions.peekSelected(row.sessionId)).then(
        (panel) => {
          if (peekGenerationRef.current === generation) {
            setPeekPanel(panel);
          }
        },
        (error) => {
          if (peekGenerationRef.current !== generation) return;
          setPeekPanel({
            kind: 'session',
            sessionId: row.sessionId,
            content: 'message',
            lines: [error instanceof Error ? error.message : String(error)],
            tone: 'error',
          });
        },
      );
    },
    [actions, visibleRows],
  );

  const togglePinSession = useCallback(
    (sessionId: string) => {
      const row = visibleRows.find((item) => item.sessionId === sessionId);
      if (!row || pinInFlightRef.current) return;
      pinInFlightRef.current = true;
      void (async () => {
        try {
          await actions.pinSession(row.sessionId);
          await refreshRows().catch(() => {});
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
    },
    [actions, refreshRows, visibleRows],
  );

  const renameSession = useCallback(
    (sessionId: string, displayName: string) => {
      const row = visibleRows.find((item) => item.sessionId === sessionId);
      if (!row) return;
      const previousPrompt = displayName;
      const restoreRevision = promptRevisionRef.current;
      setPrompt('');
      void (async () => {
        try {
          await actions.renameSession(row.sessionId, displayName);
          await refreshRows().catch(() => {});
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
    [actions, refreshRows, visibleRows],
  );

  const stopOrRemoveSession = useCallback(
    (sessionId: string) => {
      const row = visibleRows.find((item) => item.sessionId === sessionId);
      if (!row) return;
      const now = Date.now();
      const pendingStop = lastStopRequestRef.current;
      const remove =
        pendingStop?.sessionId === row.sessionId &&
        now - pendingStop.at <= STOP_REMOVE_CONFIRM_MS;
      const showRemoveHint = (message: string) => {
        const hintAt = Date.now();
        const hint: AgentViewNotice = { lines: [message] };
        lastStopRequestRef.current = { sessionId: row.sessionId, at: hintAt };
        if (stopRemoveTimerRef.current) {
          clearTimeout(stopRemoveTimerRef.current);
        }
        stopRemoveTimerRef.current = setTimeout(() => {
          const current = lastStopRequestRef.current;
          if (current?.sessionId === row.sessionId && current.at === hintAt) {
            lastStopRequestRef.current = undefined;
            setNotice((currentNotice) =>
              currentNotice === hint ? undefined : currentNotice,
            );
          }
        }, STOP_REMOVE_CONFIRM_MS);
        setNotice(hint);
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
          await refreshRows().catch(() => {});
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
          setNotice({
            lines: [error instanceof Error ? error.message : String(error)],
          });
        }
      })();
    },
    [actions, refreshRows, visibleRows],
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

  const interrupt = useCallback(
    (clearedDraft: boolean) => {
      const now = Date.now();
      if (clearedDraft) {
        lastInterruptAtRef.current = now;
        return;
      }
      if (now - lastInterruptAtRef.current <= 2000) {
        onExit();
        return;
      }
      lastInterruptAtRef.current = now;
      setNotice({
        lines: ['Press Ctrl+C again to exit.'],
      });
    },
    [onExit],
  );

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
      onAttachSession={attachSession}
      onPeekSession={peekSession}
      onTogglePinSession={togglePinSession}
      onRenameSession={renameSession}
      onStopOrRemoveSession={stopOrRemoveSession}
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
  if ((row.queuedPromptCount ?? 0) > 0 && !isAgentRosterBlockingWait(row)) {
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
  panel: AgentViewPanel | undefined,
): string[] | undefined {
  const sessionId = panel?.kind === 'session' ? panel.sessionId : undefined;
  const row = rows.find((item) => item.sessionId === sessionId);
  if (preview && preview.sessionId === sessionId) {
    return [preview.prompt];
  }
  if (!row || (row.queuedPromptCount ?? 0) <= 0) {
    return undefined;
  }
  const prompt = row.queuedPromptPreview?.trim();
  return prompt ? [prompt] : undefined;
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
  const command = prompt.trim().toLowerCase().split(/\s+/, 1)[0];
  return command === '/quit' || command === '/exit';
}

function isRosterResumeCommand(prompt: string): boolean {
  const command = prompt.trim().toLowerCase().split(/\s+/, 1)[0];
  return command === '/resume' || command === '/continue';
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
  initialPeekPanel?: AgentViewPanel,
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
