/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ThreadsPage } from './ThreadsPage';
import { ThreadView, type ThreadDetailView } from './ThreadView';
import type {
  RoutingPreviewTarget,
  ThreadSummaryView,
} from './mesh-view-logic';

/** Injected so the container is testable without a daemon. */
export interface ThreadsApi {
  listThreads(): Promise<{ threads: ThreadSummaryView[] }>;
  getThread(id: string): Promise<ThreadDetailView>;
  previewReply(
    id: string,
    text: string,
  ): Promise<{ targets: RoutingPreviewTarget[] }>;
  postReply(id: string, text: string): Promise<unknown>;
}

export const threadsHttpApi: ThreadsApi = {
  async listThreads() {
    const response = await fetch('/mesh/threads');
    if (!response.ok) throw new Error(`threads: ${response.status}`);
    return response.json() as Promise<{ threads: ThreadSummaryView[] }>;
  },
  async getThread(id) {
    const response = await fetch(`/mesh/threads/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`thread: ${response.status}`);
    return response.json() as Promise<ThreadDetailView>;
  },
  async previewReply(id, text) {
    const response = await fetch(
      `/mesh/threads/${encodeURIComponent(id)}/preview`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
    if (!response.ok) throw new Error(`preview: ${response.status}`);
    return response.json() as Promise<{ targets: RoutingPreviewTarget[] }>;
  },
  async postReply(id, text) {
    const response = await fetch(
      `/mesh/threads/${encodeURIComponent(id)}/posts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
    if (!response.ok) throw new Error(`post: ${response.status}`);
    return response.json();
  },
};

/** How long a pause in typing means "they want to know what this will do". */
const PREVIEW_DEBOUNCE_MS = 250;

export interface ThreadsRouteProps {
  api?: ThreadsApi;
  onOpenTranscript?: (runId: string) => void;
}

/**
 * Loads the threads surface and keeps the routing preview honest.
 *
 * The preview is debounced and every response is stamped with the draft it
 * answered: a slow reply to an older draft must never overwrite the answer to
 * what is on screen now, because the whole value of the preview is that it
 * describes the post about to be sent.
 */
export function ThreadsRoute({ api, onOpenTranscript }: ThreadsRouteProps) {
  const client = api ?? threadsHttpApi;
  const [threads, setThreads] = useState<ThreadSummaryView[]>([]);
  const [openId, setOpenId] = useState<string | undefined>();
  const [detail, setDetail] = useState<ThreadDetailView | undefined>();
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<RoutingPreviewTarget[] | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const refreshList = useCallback(async () => {
    try {
      const result = await client.listThreads();
      setThreads(result.threads);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  const refreshDetail = useCallback(
    async (id: string) => {
      try {
        setDetail(await client.getThread(id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client],
  );

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!openId) {
      setDetail(undefined);
      return;
    }
    void refreshDetail(openId);
  }, [openId, refreshDetail]);

  useEffect(() => {
    if (!openId || !draft.trim()) {
      setPreview(undefined);
      return;
    }
    const asked = draft;
    const timer = setTimeout(() => {
      void client
        .previewReply(openId, asked)
        .then((result) => {
          // Only answer the draft that is still on screen.
          if (draftRef.current === asked) setPreview(result.targets);
        })
        .catch(() => setPreview(undefined));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, draft, openId]);

  const onReply = useCallback(async () => {
    if (!openId || !draft.trim()) return;
    setPending(true);
    try {
      await client.postReply(openId, draft);
      setDraft('');
      setPreview(undefined);
      await Promise.all([refreshDetail(openId), refreshList()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [client, draft, openId, refreshDetail, refreshList]);

  const openTranscript = useMemo(
    () => onOpenTranscript ?? (() => {}),
    [onOpenTranscript],
  );

  if (openId && detail) {
    return (
      <ThreadView
        thread={detail}
        draft={draft}
        onDraftChange={setDraft}
        onReply={onReply}
        onBack={() => setOpenId(undefined)}
        onOpenTranscript={openTranscript}
        replyPending={pending}
        {...(preview ? { preview } : {})}
      />
    );
  }

  return (
    <>
      {error ? (
        // Say what failed and what to do, in the interface's voice.
        <p role="alert">
          Could not reach the daemon: {error}. Check that `qwen serve` is
          running, then reopen this page.
        </p>
      ) : null}
      <ThreadsPage threads={threads} onOpenThread={setOpenId} />
    </>
  );
}
