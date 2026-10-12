import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { ChatEditor } from '../ChatEditor';
import type { WebShellAtProvider } from '../../customization';
import type { useI18n } from '../../i18n';
import { createThreadsHttpApi } from './threads-api';
import { programLabel } from './agents-view-logic';
import {
  createSessionAgentsHttpApi,
  type SessionAgentsApi,
} from './session-agents-api';
import type { WorkspaceAgentSummaryView } from './ThreadsPage';
import {
  parseQwenAgentMessageMeta,
  QWEN_AGENT_MESSAGE_META_KEY,
  type DaemonTranscriptBlock,
  type SessionSquadView,
} from '@qwen-code/sdk/daemon';

type Submit = ComponentProps<typeof ChatEditor>['onSubmit'];

/** The mention picker reuses one roster read for this long. */
const ROSTER_TTL_MS = 5_000;

/**
 * The @tokens of a message, lowercased. Same rules as core's parseMentions: no
 * ASCII word character before `@`, so "请@迁移助手" counts and "a@b.dev" does
 * not; a token followed by `/` is a path, not a mention.
 */
export function mentionTokens(text: string): string[] {
  const pattern = /(?<![A-Za-z0-9_.])@([\p{L}\p{N}][\p{L}\p{N}_-]{0,47})/gu;
  return [...text.matchAll(pattern)]
    .filter((match) => text[(match.index ?? 0) + match[0].length] !== '/')
    .map((match) => match[1].toLowerCase());
}

/**
 * The agents a message addresses, in mention order. A name may run into the
 * next word in scripts without spaces ("@迁移助手看一下"); the longest name the
 * token starts with wins. Same addressability predicate as the picker: an
 * agent the server would skip must not divert the message.
 */
export function resolveMentionedAgents(
  tokens: readonly string[],
  agents: readonly WorkspaceAgentSummaryView[],
): WorkspaceAgentSummaryView[] {
  const resolved: WorkspaceAgentSummaryView[] = [];
  for (const token of tokens) {
    const agent = agents
      .filter((candidate) => {
        const lowerName = candidate.name.toLowerCase();
        const rest = token.slice(lowerName.length);
        return (
          candidate.enabled &&
          !candidate.retiredAt &&
          token.startsWith(lowerName) &&
          !/^[a-z0-9_-]/.test(rest) &&
          // Core's `agentForToken` refuses a longer Latin word too: "@maría"
          // is not "mar", "@alice２" is not "alice". A Han or kana
          // continuation is still its own word, so it keeps resolving.
          !/^[\p{Script=Latin}\p{Nd}]/u.test(rest)
        );
      })
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (agent && !resolved.includes(agent)) resolved.push(agent);
  }
  return resolved;
}

/** A 32px "people" mask: squads get an icon in the picker, agents none. */
export const SQUAD_PICKER_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVklEQVR42u2TMQ4AIAgD+f+ncXXRgKFWTC/pai8CZkKIJvgi1PKdRKlgRgDyU20ETkb1lwD0WqIPU88VdoaCOlsPhlo+S5QJOijU8rAEXeDGrggh3mEAQPbbJbEAqj0AAAAASUVORK5CYII=';

/** Squads that can take a mention: not retired, leader able to run. */
function engageableSquads(
  squads: readonly SessionSquadView[],
): SessionSquadView[] {
  return squads.filter((squad) => !squad.retiredAt && !squad.leaderIssue);
}

/**
 * The squads a message addresses, by the same token rules as
 * {@link resolveMentionedAgents}. A token that names an agent exactly is the
 * agent's, as on the daemon.
 */
export function resolveMentionedSquads(
  tokens: readonly string[],
  squads: readonly SessionSquadView[],
): SessionSquadView[] {
  const resolved: SessionSquadView[] = [];
  for (const token of tokens) {
    const squad = engageableSquads(squads)
      .filter((candidate) => {
        const lowerName = candidate.name.toLowerCase();
        const rest = token.slice(lowerName.length);
        return (
          token.startsWith(lowerName) &&
          !/^[a-z0-9_-]/.test(rest) &&
          !/^[\p{Script=Latin}\p{Nd}]/u.test(rest)
        );
      })
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (squad && !resolved.includes(squad)) resolved.push(squad);
  }
  return resolved;
}

/** The chat session an @-mention goes to, and the workspace it lives in. */
export interface AgentMentionSession {
  sessionId: string;
  /** Unset: the hook's own `cwd`. */
  workspaceCwd?: string;
}

/**
 * An @-mention the daemon accepted but deferred behind a running main-model
 * turn (`deferred: true`): its record, and so the user's message, only lands
 * once that turn settles. Shown as the user's message until then.
 */
export interface PendingAgentMention {
  /** The post's `clientMessageId`. */
  id: string;
  sessionId: string;
  text: string;
  /**
   * Recorded mentions with this text the session already had, plus earlier
   * pending ones, when it was posted: the record that settles this one is
   * the next.
   */
  recordedBefore: number;
}

/**
 * The text of each recorded @-mention (`agent_mention` user message) in the
 * transcript, in order. Compare with {@link isPendingMentionRecorded}.
 */
export function recordedAgentMentionTexts(
  blocks: readonly DaemonTranscriptBlock[],
): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'user') continue;
    const meta = (block as { meta?: Record<string, unknown> }).meta;
    const value = meta?.[QWEN_AGENT_MESSAGE_META_KEY];
    if (value === undefined) continue;
    if (parseQwenAgentMessageMeta(value)?.kind === 'agent_mention') {
      texts.push((block as { text: string }).text);
    }
  }
  return texts;
}

function countMentionText(texts: readonly string[], text: string): number {
  const wanted = text.trim();
  return texts.reduce(
    (count, entry) => count + Number(entry.trim() === wanted),
    0,
  );
}

/** True once the record of `mention` is among the recorded mention texts. */
export function isPendingMentionRecorded(
  mention: PendingAgentMention,
  recordedTexts: readonly string[],
): boolean {
  return countMentionText(recordedTexts, mention.text) > mention.recordedBefore;
}

const NO_MENTION_TEXTS: readonly string[] = [];

/** Idempotency key for one @-mention post (`[A-Za-z0-9_.:-]{1,128}`). */
function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return `mention:${crypto.randomUUID()}`;
  const random = Math.random().toString(36).slice(2);
  return `mention:${Date.now().toString(36)}-${random}`;
}

export function useAgentChatEntry({
  enabled,
  cwd,
  baseUrl,
  token,
  sessionApi,
  sessionApiFor,
  ensureSession,
  onSubmit,
  onError,
  onCreateAgent,
  sessionId,
  recordedMentionTexts = NO_MENTION_TEXTS,
  t,
}: {
  enabled: boolean;
  cwd?: string;
  baseUrl: string;
  token?: string;
  /** The session routes of the same workspace (`cwd`). */
  sessionApi?: SessionAgentsApi;
  /**
   * The session routes of another workspace, for a session that lives
   * elsewhere. Defaults to the HTTP routes of that workspace.
   */
  sessionApiFor?: (workspaceCwd: string) => SessionAgentsApi;
  /**
   * The current chat session, creating it first when this is a new chat (the
   * same lazy creation an ordinary first prompt goes through), with the
   * workspace it was created in.
   */
  ensureSession: () => Promise<AgentMentionSession | string | undefined>;
  onSubmit: Submit;
  onError: (message: string) => void;
  /** Offered as the picker's last item: open the New agent page. */
  onCreateAgent?: () => void;
  /** The session the chat shows; only its pending @-mentions are returned. */
  sessionId?: string;
  /**
   * {@link recordedAgentMentionTexts} of that session's transcript, memoized:
   * a pending @-mention is dropped once its record shows up here.
   */
  recordedMentionTexts?: readonly string[];
  /**
   * The caller's translator. App calls this hook above its I18nProvider, where
   * useI18n() would hand back the default that echoes keys.
   */
  t: ReturnType<typeof useI18n>['t'];
}) {
  // Read through a ref so a new handler each render keeps `providers` stable.
  const createAgentRef = useRef(onCreateAgent);
  createAgentRef.current = onCreateAgent;
  const canCreateAgent = onCreateAgent !== undefined;
  const roster = useRef<
    | { api: unknown; at: number; agents: Promise<WorkspaceAgentSummaryView[]> }
    | undefined
  >(undefined);
  const squadRoster = useRef<
    | { api: unknown; at: number; squads: Promise<SessionSquadView[]> }
    | undefined
  >(undefined);
  const api = useMemo(
    () =>
      enabled && cwd ? createThreadsHttpApi(baseUrl, token, cwd) : undefined,
    [enabled, cwd, baseUrl, token],
  );
  const activeApi = useRef(api);
  activeApi.current = api;
  // Names known so far, so a typed @query can be claimed without waiting.
  const agentNames = useRef<string[]>([]);
  const squadNames = useRef<string[]>([]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const submission = useRef(0);
  const [pendingMentions, setPendingMentions] = useState<PendingAgentMention[]>(
    [],
  );
  const pendingMentionsRef = useRef(pendingMentions);
  pendingMentionsRef.current = pendingMentions;
  const recordedMentions = useRef({ sessionId, texts: recordedMentionTexts });
  recordedMentions.current = { sessionId, texts: recordedMentionTexts };
  // A record landed: its echo goes, so the message is never shown twice.
  useEffect(() => {
    setPendingMentions((current) => {
      const next = current.filter(
        (mention) =>
          mention.sessionId !== sessionId ||
          !isPendingMentionRecorded(mention, recordedMentionTexts),
      );
      return next.length === current.length ? current : next;
    });
  }, [sessionId, recordedMentionTexts]);
  const visiblePendingMentions = useMemo(
    () =>
      pendingMentions.filter(
        (mention) =>
          mention.sessionId === sessionId &&
          !isPendingMentionRecorded(mention, recordedMentionTexts),
      ),
    [pendingMentions, sessionId, recordedMentionTexts],
  );
  // The composer receives these straight as props, so both identities have to
  // survive re-renders: `atProviders` feeds a memoized ChatEditor comparison
  // and `submit` a memoized onSubmit prop.
  const listAgents = useCallback(() => {
    if (!api) return Promise.resolve([]);
    const cached = roster.current;
    if (cached?.api === api && Date.now() - cached.at < ROSTER_TTL_MS)
      return cached.agents;
    const agents = api.listAgents().then((result) => result.agents);
    roster.current = { api, at: Date.now(), agents };
    void agents.then(
      (list) => {
        if (roster.current?.agents !== agents) return;
        agentNames.current = list
          .filter((agent) => agent.enabled && !agent.retiredAt)
          .map((agent) => agent.name.toLowerCase());
      },
      () => {},
    );
    agents.catch(() => {
      if (roster.current?.agents === agents) roster.current = undefined;
    });
    return agents;
  }, [api]);
  // Squads, cached like the roster. A daemon without squad routes has none.
  const listSquads = useCallback((): Promise<SessionSquadView[]> => {
    if (!api?.listSquads) return Promise.resolve([]);
    const cached = squadRoster.current;
    if (cached?.api === api && Date.now() - cached.at < ROSTER_TTL_MS)
      return cached.squads;
    const squads = api.listSquads().then(
      (result) => result.squads,
      (): SessionSquadView[] => [],
    );
    squadRoster.current = { api, at: Date.now(), squads };
    void squads.then((list) => {
      if (squadRoster.current?.squads !== squads) return;
      squadNames.current = engageableSquads(list).map((squad) =>
        squad.name.toLowerCase(),
      );
    });
    return squads;
  }, [api]);
  // Load the roster up front so the first typed @name already resolves.
  useEffect(() => {
    submission.current += 1;
    busy.current = false;
    setPending(false);
    agentNames.current = [];
    squadNames.current = [];
    listAgents().catch(() => {});
    void listSquads();
  }, [listAgents, listSquads]);
  const providers = useMemo<WebShellAtProvider[]>(
    () =>
      api
        ? [
            {
              id: 'workspace-collaborators',
              label: t('collab.mention.provider'),
              claimsTypedQuery: (query) => {
                const lower = query.toLowerCase();
                return [...agentNames.current, ...squadNames.current].some(
                  (name) => name.startsWith(lower),
                );
              },
              search: async ({ query }) => [
                ...(await listAgents())
                  .filter(
                    (agent) =>
                      agent.enabled &&
                      !agent.retiredAt &&
                      agent.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((agent) => ({
                    id: agent.id,
                    label: agent.name,
                    // "Program · Runtime", as on the Agents page.
                    // A local agent can run Claude Code or Codex too.
                    subtitle: `${programLabel(agent.execution?.provider)} · ${
                      // An older daemon sends no runtime: it runs here.
                      !agent.runtime || agent.runtime.kind === 'local'
                        ? t('collab.agent.thisComputer')
                        : agent.runtime.label
                    }`,
                    description: t(`collab.agentStatus.${agent.status}`),
                    ...(agent.color ? { iconColor: agent.color } : {}),
                    insertText: `@${agent.name} `,
                  })),
                ...engageableSquads(await listSquads())
                  .filter((squad) =>
                    squad.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((squad) => ({
                    id: `squad:${squad.id}`,
                    label: squad.name,
                    // "Leader alice · 2 member(s)".
                    subtitle: t('collab.squad.summary', {
                      leader: squad.leaderName ?? '—',
                      count: squad.members.length,
                    }),
                    description: t('collab.mention.squad'),
                    icon: SQUAD_PICKER_ICON,
                    iconMode: 'mask' as const,
                    insertText: `@${squad.name} `,
                  })),
                ...(canCreateAgent
                  ? [
                      {
                        id: 'collab:new-agent',
                        label: t('collab.mention.newAgent'),
                        onSelect: () => createAgentRef.current?.(),
                      },
                    ]
                  : []),
              ],
            },
          ]
        : [],
    [api, listAgents, listSquads, canCreateAgent, t],
  );
  // Read through refs so a new callback each render keeps `submit` stable.
  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;
  const sessionApiForRef = useRef(sessionApiFor);
  sessionApiForRef.current = sessionApiFor;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // The last post whose outcome is unknown (it threw). A retry of the same
  // text in the same session reuses its clientMessageId, so the daemon
  // replays the record instead of writing and running it twice.
  const unsettledMention = useRef<
    { sessionId: string; text: string; clientMessageId: string } | undefined
  >(undefined);
  const submit = useCallback<Submit>(
    (text, images, files, commit, metadata) => {
      const tokens = mentionTokens(text);
      if (!api || !sessionApi || !cwd || tokens.length === 0)
        return onSubmit(text, images, files, commit, metadata);
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      const submissionId = ++submission.current;
      void (async () => {
        try {
          // No roster (collaboration off here, or the daemon unreachable)
          // means no agent can be addressed: send it as an ordinary message.
          const [agents, squads] = await Promise.all([
            listAgents().catch((): WorkspaceAgentSummaryView[] => []),
            listSquads(),
          ]);
          if (activeApi.current !== api || submission.current !== submissionId)
            return;
          if (
            resolveMentionedAgents(tokens, agents).length === 0 &&
            resolveMentionedSquads(tokens, squads).length === 0
          ) {
            let committed = false;
            const accepted = onSubmit(
              text,
              images,
              files,
              () => {
                committed = true;
                commit?.();
              },
              metadata,
            );
            if (accepted !== false && !committed) commit?.();
            return;
          }
          // TODO(multi-agent): the mention route carries text only (plan
          // §8-6); attachments on an @-mention are refused until it does.
          if (images?.length || files?.length)
            throw new Error(t('collab.mention.noAttachments'));
          // The agents answer inside this chat session, so a new chat gets
          // its session first, exactly as its first prompt would.
          // Creating the session can re-key this hook (the composer's
          // workspace settles on the new session's), so no staleness check
          // from here on: the message belongs to the session just created.
          const ensured = await ensureSessionRef.current();
          const target: AgentMentionSession | undefined =
            typeof ensured === 'string' ? { sessionId: ensured } : ensured;
          if (!target?.sessionId)
            throw new Error(t('collab.mention.noSession'));
          // A new chat whose workspace picker pointed elsewhere created its
          // session in that workspace: its routes are the ones that know it.
          // The server re-resolves the names against that workspace's roster
          // and refuses a message that names none of its agents.
          const otherWorkspace =
            target.workspaceCwd && target.workspaceCwd !== cwd
              ? target.workspaceCwd
              : undefined;
          const routes = otherWorkspace
            ? (sessionApiForRef.current?.(otherWorkspace) ??
              createSessionAgentsHttpApi(baseUrl, token, otherWorkspace))
            : sessionApi;
          const targetSessionId = target.sessionId;
          // Counted before posting, so a record that lands quickly is still
          // the one that settles this message.
          const shown = recordedMentions.current;
          const recordedBefore =
            (shown.sessionId === targetSessionId
              ? countMentionText(shown.texts, text)
              : 0) +
            pendingMentionsRef.current.filter(
              (mention) =>
                mention.sessionId === targetSessionId &&
                mention.text.trim() === text.trim(),
            ).length;
          const retry = unsettledMention.current;
          const clientMessageId =
            retry?.sessionId === targetSessionId && retry.text === text
              ? retry.clientMessageId
              : newClientMessageId();
          unsettledMention.current = {
            sessionId: targetSessionId,
            text,
            clientMessageId,
          };
          // The daemon records the @-mention and streams it back as a user
          // message, live and on replay alike, so there is no local echo...
          const result = await routes.mention(targetSessionId, {
            text,
            clientMessageId,
          });
          unsettledMention.current = undefined;
          commit?.();
          // ...unless a main-model turn is running: the record waits for it
          // to settle, and the message is shown as pending until it lands.
          // TODO(multi-agent): matched by text; the live record does not
          // carry the post's clientMessageId to match on.
          if (result?.deferred) {
            setPendingMentions((current) => [
              ...current,
              {
                id: clientMessageId,
                sessionId: targetSessionId,
                text,
                recordedBefore,
              },
            ]);
          }
          // Posted, but a squad in it could not start (its leader cannot run).
          if (result?.squadError) onErrorRef.current(result.squadError);
        } catch (error) {
          onErrorRef.current(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          if (submission.current === submissionId) {
            busy.current = false;
            setPending(false);
          }
        }
      })();
      return false;
    },
    [api, sessionApi, cwd, baseUrl, token, onSubmit, listAgents, listSquads, t],
  );
  return {
    providers,
    submit,
    pending,
    pendingMentions: visiblePendingMentions,
  };
}
