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
import type { SessionAgentsApi } from './session-agents-api';
import type { WorkspaceAgentSummaryView } from './ThreadsPage';

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
  ensureSession,
  onSubmit,
  onError,
  onCreateAgent,
  t,
}: {
  enabled: boolean;
  cwd?: string;
  baseUrl: string;
  token?: string;
  /** The session routes of the same workspace (`cwd`). */
  sessionApi?: SessionAgentsApi;
  /**
   * The current chat session's id, creating the session first when this is a
   * new chat (the same lazy creation an ordinary first prompt goes through).
   */
  ensureSession: () => Promise<string | undefined>;
  onSubmit: Submit;
  onError: (message: string) => void;
  /** Offered as the picker's last item: open the New agent page. */
  onCreateAgent?: () => void;
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
  const api = useMemo(
    () =>
      enabled && cwd ? createThreadsHttpApi(baseUrl, token, cwd) : undefined,
    [enabled, cwd, baseUrl, token],
  );
  const activeApi = useRef(api);
  activeApi.current = api;
  // Names known so far, so a typed @query can be claimed without waiting.
  const agentNames = useRef<string[]>([]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const submission = useRef(0);
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
  // Load the roster up front so the first typed @name already resolves.
  useEffect(() => {
    submission.current += 1;
    busy.current = false;
    setPending(false);
    agentNames.current = [];
    listAgents().catch(() => {});
  }, [listAgents]);
  const providers = useMemo<WebShellAtProvider[]>(
    () =>
      api
        ? [
            {
              id: 'workspace-collaborators',
              label: t('collab.mention.provider'),
              claimsTypedQuery: (query) => {
                const lower = query.toLowerCase();
                return agentNames.current.some((name) =>
                  name.startsWith(lower),
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
                    subtitle: `${programLabel(
                      agent.execution?.mode === 'managed-host'
                        ? agent.execution.provider
                        : undefined,
                    )} · ${
                      // An older daemon sends no runtime: it runs here.
                      !agent.runtime || agent.runtime.kind === 'local'
                        ? t('collab.agent.thisComputer')
                        : agent.runtime.label
                    }`,
                    description: t(`collab.agentStatus.${agent.status}`),
                    ...(agent.color ? { iconColor: agent.color } : {}),
                    insertText: `@${agent.name} `,
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
    [api, listAgents, canCreateAgent, t],
  );
  // Read through refs so a new callback each render keeps `submit` stable.
  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
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
          const agents = await listAgents().catch(
            (): WorkspaceAgentSummaryView[] => [],
          );
          if (activeApi.current !== api || submission.current !== submissionId)
            return;
          if (resolveMentionedAgents(tokens, agents).length === 0) {
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
          // TODO(multi-agent): a session created here is assumed to live in
          // `cwd`; if the new-chat workspace picker targets another
          // workspace, the mention goes to the wrong workspace's route.
          // Creating the session can re-key this hook (the composer's
          // workspace settles on the new session's), so no staleness check
          // from here on: the message belongs to the session just created.
          const sessionId = await ensureSessionRef.current();
          if (!sessionId) throw new Error(t('collab.mention.noSession'));
          // No local echo: the daemon records the @-mention and streams it
          // back as a user message, live and on replay alike.
          // TODO(multi-agent): a 202 with `deferred: true` (a main-model turn
          // is running) clears the composer, but the @ message only appears
          // once that turn settles and the record is written; until then only
          // the agents' run cards show. A local echo would double it.
          await sessionApi.mention(sessionId, {
            text,
            clientMessageId: newClientMessageId(),
          });
          commit?.();
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
    [api, sessionApi, cwd, onSubmit, listAgents, t],
  );
  return { providers, submit, pending };
}
