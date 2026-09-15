import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { ChatEditor } from '../ChatEditor';
import type { WebShellAtProvider } from '../../customization';
import { createThreadsHttpApi } from './ThreadsRoute';

type Submit = ComponentProps<typeof ChatEditor>['onSubmit'];

export function useAgentChatEntry({
  enabled,
  cwd,
  baseUrl,
  token,
  onSubmit,
  onOpen,
  onError,
}: {
  enabled: boolean;
  cwd?: string;
  baseUrl: string;
  token?: string;
  onSubmit: Submit;
  onOpen: (id: string, cwd: string) => void;
  onError: (message: string) => void;
}) {
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
  const providers = useMemo<WebShellAtProvider[]>(
    () =>
      api
        ? [
            {
              id: 'workspace-collaborators',
              label: '协作智能体',
              search: async ({ query }) => {
                const result = await api.listAgents();
                return result.agents
                  .filter(
                    (agent) =>
                      agent.enabled &&
                      !agent.retiredAt &&
                      agent.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((agent) => ({
                    id: agent.id,
                    label: agent.name,
                    insertText: `@${agent.name} `,
                  }));
              },
            },
          ]
        : [],
    [api],
  );
  const submit = useCallback<Submit>(
    (text, images, files, commit, metadata) => {
      const mentions = [
        ...text.matchAll(
          /(?<![\p{L}\p{N}_])@([\p{L}\p{N}][\p{L}\p{N}_-]{0,47})/gu,
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
          const { agents } = await api.listAgents();
          if (
            !agents.some((agent) => mentions.includes(agent.name.toLowerCase()))
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
          if (images?.length || files?.length)
            throw new Error('协作对话暂不支持附件，请先使用文字发起任务。');
          let id =
            retry.current?.api === api && retry.current.text === text
              ? retry.current.id
              : undefined;
          if (!id) {
            const created = await api.createThread({
              title: text.trim().slice(0, 80),
              body: '',
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
    [api, cwd, onSubmit, onOpen, onError],
  );
  return { providers, submit, pending };
}
