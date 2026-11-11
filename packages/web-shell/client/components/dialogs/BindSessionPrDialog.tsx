/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonGitHubPullRequestList } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { DialogShell } from './DialogShell';

export interface BindSessionPrPayload {
  number: number;
  url: string;
  state?: 'open' | 'merged' | 'closed';
}

interface BindSessionPrDialogProps {
  workspaceCwd: string;
  busy: boolean;
  /** Daemon-side failure surfaced by the panel; resolution errors are internal. */
  error?: string;
  onSubmit: (pr: BindSessionPrPayload) => void;
  onClose: () => void;
}

// Same shape GitWorktreeService.parsePRReference accepts on the CLI side:
// any host, optional subpath/query/fragment after /pull/<N>. The number
// bound mirrors the CLI's bare-number pattern so an over-long number cannot
// parse into an unsafe integer. Group 1 captures the canonical
// /pull/<N> prefix so a /files or query spelling stores the same sidecar
// key as a later canonical re-bind (mirrors pullRequestViewUrl).
const PR_URL_PATTERN =
  /^(https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/([1-9]\d{0,8}))(?:\/[^?#]*)?(?:[?#].*)?$/i;
const BARE_NUMBER_PATTERN = /^[1-9]\d{0,8}$/;

/**
 * Supplementary PR registration: binds an existing PR the automatic paths
 * missed. A URL binds normalized to its canonical /pull/<N> spelling (the
 * daemon's refresh sweep resolves its state); a bare number or #N resolves
 * through the workspace's open-PR list, so a number outside that list
 * (merged/closed or beyond the list cap) asks for the URL.
 */
export function BindSessionPrDialog({
  workspaceCwd,
  busy,
  error,
  onSubmit,
  onClose,
}: BindSessionPrDialogProps) {
  const { client } = useWorkspace();
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const [resolving, setResolving] = useState(false);
  const [prList, setPrList] = useState<DaemonGitHubPullRequestList | null>(
    null,
  );
  // A cancelled dialog must not submit the in-flight resolution: the
  // parent's guard reads a closure-captured target and runs unconditionally,
  // so the liveness check lives here, after every await.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const submit = async () => {
    const input = value.trim().replace(/^#/, '');
    setLocalError(undefined);

    const urlMatch = PR_URL_PATTERN.exec(input);
    if (urlMatch?.[1] && urlMatch[2]) {
      onSubmit({ number: Number(urlMatch[2]), url: urlMatch[1] });
      return;
    }

    if (!BARE_NUMBER_PATTERN.test(input)) {
      setLocalError(t('sessionsOverview.bindPrInvalid'));
      return;
    }
    const number = Number(input);

    let list = prList;
    if (!list) {
      // A cwd-less legacy session has no workspace PR list to resolve
      // against; asking for the URL beats a request no route resolves.
      if (!workspaceCwd) {
        setLocalError(t('sessionsOverview.bindPrListFailed'));
        return;
      }
      setResolving(true);
      try {
        list = await client
          .workspaceByCwd(workspaceCwd)
          .workspaceGitHubPullRequests();
        if (!aliveRef.current) return;
        setPrList(list);
      } catch {
        if (aliveRef.current) {
          setLocalError(t('sessionsOverview.bindPrListFailed'));
        }
        return;
      } finally {
        if (aliveRef.current) setResolving(false);
      }
    }
    if (!aliveRef.current) return;
    if (!list.available) {
      setLocalError(t('sessionsOverview.bindPrUnavailable'));
      return;
    }
    const match = list.pullRequests.find((pr) => pr.number === number);
    if (!match) {
      setLocalError(
        t('sessionsOverview.bindPrNotInList', { number: String(number) }),
      );
      return;
    }
    // The list only carries open/draft PRs; draft records as open.
    onSubmit({ number: match.number, url: match.url, state: 'open' });
  };

  // A fresh local validation message outranks the host's stale daemon
  // error; editing clears the local one so it never describes input the
  // user already replaced.
  const shownError = localError ?? error;
  const disabled = busy || resolving || !value.trim();

  return (
    <DialogShell
      title={t('sessionsOverview.bindPr')}
      size="sm"
      dismissible={!resolving}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) void submit();
        }}
      >
        <Input
          autoFocus
          aria-label={t('sessionsOverview.bindPr')}
          placeholder={t('sessionsOverview.bindPrPlaceholder')}
          maxLength={2048}
          value={value}
          disabled={busy || resolving}
          onChange={(event) => {
            setValue(event.target.value);
            if (localError) setLocalError(undefined);
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229)
            ) {
              event.preventDefault();
            }
          }}
        />
        {shownError && (
          <p role="alert" className="text-sm text-destructive">
            {shownError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={resolving}
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={disabled}>
            {t('sessionsOverview.bindPrSubmit')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
