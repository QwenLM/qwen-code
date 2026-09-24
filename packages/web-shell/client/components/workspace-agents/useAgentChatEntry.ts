import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { ChatEditor } from '../ChatEditor';
import type { WebShellAtProvider } from '../../customization';
import type { useI18n } from '../../i18n';
import { createThreadsHttpApi } from './ThreadsRoute';
import { CONVERSATION_CONTEXT_PREFIX } from './agents-view-logic';
import type { WorkspaceAgentSummaryView } from './ThreadsPage';

type Submit = ComponentProps<typeof ChatEditor>['onSubmit'];

/** The mention picker reuses one roster read for this long. */
const ROSTER_TTL_MS = 5_000;
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 4_000;

/**
 * The tail of the conversation an agent was mentioned from, so a thread
 * started mid-conversation does not begin blind.
 */
export function conversationContext(
  messages: readonly { role: string; content?: unknown }[],
): string {
  const text = messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim(),
    )
    .slice(-CONTEXT_MESSAGES)
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'Assistant'}: ${(message.content as string).trim()}`,
    )
    .join('\n\n');
  return text.length > CONTEXT_CHARS ? `…${text.slice(-CONTEXT_CHARS)}` : text;
}

export function useAgentChatEntry({
  enabled,
  cwd,
  baseUrl,
  token,
  onSubmit,
  onOpen,
  onError,
  getContext,
  onCreateAgent,
  t,
}: {
  enabled: boolean;
  cwd?: string;
  baseUrl: string;
  token?: string;
  onSubmit: Submit;
  onOpen: (id: string, cwd: string) => void;
  onError: (message: string) => void;
  /** The conversation so far, when mentioning from a chat that has one. */
  getContext?: () => string;
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
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const retry = useRef<
    { api: typeof api; text: string; id: string } | undefined
  >(undefined);
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
    agents.catch(() => {
      if (roster.current?.agents === agents) roster.current = undefined;
    });
    return agents;
  }, [api]);
  const providers = useMemo<WebShellAtProvider[]>(
    () =>
      api
        ? [
            {
              id: 'workspace-collaborators',
              label: t('collab.mention.provider'),
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
  const submit = useCallback<Submit>(
    (text, images, files, commit, metadata) => {
      // Same rules as core's parseMentions: no ASCII word character before
      // `@`, so "请@迁移助手" counts and "a@b.dev" does not.
      const mentions = [
        ...text.matchAll(
          /(?<![A-Za-z0-9_.])@([\p{L}\p{N}][\p{L}\p{N}_-]{0,47})/gu,
        ),
      ]
        .filter((match) => text[(match.index ?? 0) + match[0].length] !== '/')
        .map((match) => match[1].toLowerCase());
      if (!api || !cwd || mentions.length === 0)
        return onSubmit(text, images, files, commit, metadata);
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      void (async () => {
        try {
          const agents = await listAgents();
          // The first agent addressed leads the thread: a follow-up without an
          // @ goes to it, and sub-thread reports wake it.
          // A name may run into the next word in scripts without spaces
          // ("@迁移助手看一下"); the longest name the token starts with wins.
          const lead = mentions
            .map(
              (token) =>
                agents
                  .filter(
                    (agent) =>
                      token.startsWith(agent.name.toLowerCase()) &&
                      !/^[a-z0-9_-]/.test(token.slice(agent.name.length)),
                  )
                  .sort((a, b) => b.name.length - a.name.length)[0],
            )
            .find((agent) => agent !== undefined);
          if (!lead) {
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
          if (images?.length || files?.length)
            throw new Error(t('collab.mention.noAttachments'));
          let id =
            retry.current?.api === api && retry.current.text === text
              ? retry.current.id
              : undefined;
          if (!id) {
            const context = getContext?.() ?? '';
            const created = await api.createThread({
              title: text.trim().slice(0, 80),
              body: context ? `${CONVERSATION_CONTEXT_PREFIX}${context}` : '',
              assignee: lead.name,
            });
            id = created.id;
            retry.current = { api, text, id };
          }
          await api.postReply(id, text);
          retry.current = undefined;
          commit?.();
          onOpen(id, cwd);
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        } finally {
          busy.current = false;
          setPending(false);
        }
      })();
      return false;
    },
    [api, cwd, onSubmit, onOpen, onError, getContext, listAgents, t],
  );
  return { providers, submit, pending };
}
