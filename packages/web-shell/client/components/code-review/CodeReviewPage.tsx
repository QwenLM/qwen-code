import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  DaemonClient,
  DaemonGitHubAccountPullRequest,
  DaemonGitHubPullRequestDetailResponse,
  DaemonGitHubPullRequestInbox,
} from '@qwen-code/sdk/daemon';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { timeAgo } from '../../utils/timeAgo';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { PullRequestDetails } from './PullRequestDetails';
import { GitHubAvatar } from './GitHubAvatar';
import { useReviewPane } from './useReviewPane';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../ui/resizable';
import styles from './CodeReviewPage.module.css';

export interface CodeReviewPageProps {
  client: DaemonClient;
  settingsControl?: ReactNode;
  initialPrRef?: string;
  onSelectPullRequest?: (ref: string | undefined) => void;
  onClose?: () => void;
}

interface ReadState<T> {
  scope: object;
  revision: number;
  ref?: string;
  data?: T;
  error?: string;
  loading: boolean;
}

interface InboxState extends ReadState<DaemonGitHubPullRequestInbox> {
  loadingMore?: boolean;
  moreError?: string;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'body' in error) {
    const body = error.body;
    if (
      body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string'
    ) {
      return body.code;
    }
  }
  return 'github_pr_read_failed';
}

function errorMessageKey(code: string): string {
  switch (code) {
    case 'github_cli_unavailable':
      return 'prWorkbench.error.cli';
    case 'feature_disabled':
      return 'prWorkbench.error.disabled';
    case 'invalid_pull_request_ref':
      return 'prWorkbench.error.invalid';
    case 'github_account_changed':
      return 'prWorkbench.error.accountChanged';
    case 'github_host_mismatch':
      return 'prWorkbench.error.host';
    case 'github_pr_not_found':
      return 'prWorkbench.error.notFound';
    default:
      return 'prWorkbench.error.read';
  }
}

function normalizePullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^(\/[^/]+\/[^/]+\/pull\/[1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/,
    );
    if (url.protocol === 'https:' && !url.username && !url.password && match) {
      return `${url.origin}${match[1]}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mergePullRequests(
  previous: DaemonGitHubAccountPullRequest[],
  next: DaemonGitHubAccountPullRequest[],
) {
  return [
    ...new Map([...previous, ...next].map((pr) => [pr.url, pr])).values(),
  ].sort((left, right) => right.updatedAt - left.updatedAt);
}

function LoadError({
  code,
  detail,
  onRetry,
}: {
  code: string;
  detail?: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.error} role="alert">
      <TriangleAlertIcon size={20} aria-hidden="true" />
      <strong>
        {t(detail ? 'prWorkbench.detailFailed' : 'prWorkbench.loadFailed')}
      </strong>
      <p>{t(errorMessageKey(code))}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('prWorkbench.retry')}
      </Button>
    </div>
  );
}

function PullRequestGroup({
  title,
  prs,
  query,
  selectedRef,
  hasMore,
  onSelect,
}: {
  title: string;
  prs: DaemonGitHubAccountPullRequest[];
  query: string;
  selectedRef?: string;
  hasMore: boolean;
  onSelect: (ref: string) => void;
}) {
  const { t, language } = useI18n();
  const filtered = prs.filter((pr) =>
    `${pr.number} ${pr.title} ${pr.author} ${pr.repository.nameWithOwner}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <section className={styles.group} aria-label={title}>
      <h2 className={styles.groupTitle}>
        {title}
        <span>
          {prs.length}
          {hasMore ? '+' : ''}
        </span>
      </h2>
      {filtered.map((pr) => (
        <button
          type="button"
          key={pr.url}
          className={styles.prRow}
          data-testid="code-review-pr-row"
          data-pr-number={pr.number}
          data-pr-url={pr.url}
          aria-current={pr.url === selectedRef ? 'true' : undefined}
          onClick={() => onSelect(pr.url)}
        >
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>
              <span>{pr.title}</span>
              <GitPullRequestIcon
                size={15}
                className={styles.prIcon}
                data-state={pr.state}
                aria-label={t(`prWorkbench.state.${pr.state}`)}
              />
            </span>
            <span className={styles.rowMeta}>
              <GitHubAvatar
                login={pr.author}
                src={pr.authorAvatarUrl}
                className={styles.rowAvatar}
              />
              <span className={styles.rowAuthor} title={pr.author}>
                {pr.author}
              </span>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.rowTime}>
                {timeAgo(pr.updatedAt, Date.now() / 1000, language)}
              </span>
              <span
                className={styles.rowRepository}
                title={`${pr.repository.nameWithOwner} #${pr.number}`}
              >
                {pr.repository.nameWithOwner} <span>#{pr.number}</span>
              </span>
            </span>
          </span>
        </button>
      ))}
      {filtered.length === 0 && (
        <p className={styles.groupEmpty}>
          {t(query ? 'prWorkbench.noMatches' : 'prWorkbench.emptyGroup')}
        </p>
      )}
    </section>
  );
}

export function CodeReviewPage({
  client,
  settingsControl,
  initialPrRef,
  onSelectPullRequest,
  onClose,
}: CodeReviewPageProps) {
  const { t } = useI18n();
  const pane = useReviewPane('inbox', 340, 280, 520, 800);
  const scope = useMemo(() => ({ client }), [client]);
  const route = useMemo(() => ({ initialPrRef }), [initialPrRef]);
  const [request, setRequest] = useState({
    scope,
    revision: 0,
    page: 1,
    attempt: 0,
  });
  const { revision, page, attempt } =
    request.scope === scope ? request : { revision: 0, page: 1, attempt: 0 };
  const [inboxState, setInboxState] = useState<InboxState>();
  const [detailState, setDetailState] =
    useState<ReadState<DaemonGitHubPullRequestDetailResponse>>();
  const [queryState, setQueryState] = useState({ scope, value: '' });
  const [selection, setSelection] = useState({
    scope,
    route,
    ref: initialPrRef,
    showDetail: Boolean(initialPrRef),
  });
  const inbox =
    inboxState?.scope === scope && inboxState.revision === revision
      ? inboxState
      : undefined;
  const query = queryState.scope === scope ? queryState.value : '';
  const currentSelection =
    selection.scope === scope && selection.route === route
      ? selection
      : undefined;
  const selectionRef =
    inbox?.error === 'github_account_changed'
      ? undefined
      : ((currentSelection ? currentSelection.ref : initialPrRef) ??
        inbox?.data?.authored[0]?.url ??
        inbox?.data?.needsMyReview[0]?.url);
  const selectedRef = selectionRef
    ? (normalizePullRequestUrl(selectionRef) ?? selectionRef)
    : undefined;
  const showDetail = currentSelection?.showDetail ?? Boolean(initialPrRef);
  const detail =
    detailState?.scope === scope &&
    detailState.revision === revision &&
    detailState.ref === selectedRef
      ? detailState
      : undefined;

  const accountMismatch = Boolean(
    inbox?.data &&
      detail?.data &&
      (inbox.data.account.host !== detail.data.account.host ||
        inbox.data.account.login !== detail.data.account.login),
  );
  const inboxError = accountMismatch ? 'github_account_changed' : inbox?.error;
  const detailError = accountMismatch
    ? 'github_account_changed'
    : detail?.error;

  useEffect(() => {
    let cancelled = false;
    setInboxState((previous) => ({
      scope,
      revision,
      data:
        page > 1 && previous?.scope === scope && previous.revision === revision
          ? previous.data
          : undefined,
      loading: page === 1,
      loadingMore: page > 1,
    }));
    void client.githubPullRequestInbox({ page }).then(
      (data) => {
        if (cancelled) return;
        setInboxState((previous) => {
          const prior =
            previous?.scope === scope && previous.revision === revision
              ? previous.data
              : undefined;
          if (
            page > 1 &&
            prior &&
            (prior.account.host !== data.account.host ||
              prior.account.login !== data.account.login)
          ) {
            return {
              scope,
              revision,
              loading: false,
              error: 'github_account_changed',
            };
          }
          return {
            scope,
            revision,
            loading: false,
            data: {
              ...data,
              authored: mergePullRequests(
                page > 1 ? (prior?.authored ?? []) : [],
                data.authored,
              ),
              needsMyReview: mergePullRequests(
                page > 1 ? (prior?.needsMyReview ?? []) : [],
                data.needsMyReview,
              ),
            },
          };
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setInboxState((previous) => ({
          scope,
          revision,
          data:
            page > 1 &&
            previous?.scope === scope &&
            previous.revision === revision
              ? previous.data
              : undefined,
          loading: false,
          ...(page > 1
            ? { moreError: errorCode(error) }
            : { error: errorCode(error) }),
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, scope, revision, page, attempt]);

  useEffect(() => {
    if (initialPrRef || !inbox?.data) return;
    const first =
      inbox.data.authored[0]?.url ?? inbox.data.needsMyReview[0]?.url;
    if (!first) return;
    setSelection((previous) =>
      previous.scope === scope && previous.route === route && previous.ref
        ? previous
        : { scope, route, ref: first, showDetail: false },
    );
  }, [scope, route, initialPrRef, inbox?.data]);

  useEffect(() => {
    if (!selectedRef) return;
    if (!normalizePullRequestUrl(selectedRef)) {
      setDetailState({
        scope,
        revision,
        ref: selectedRef,
        loading: false,
        error: 'invalid_pull_request_ref',
      });
      return;
    }
    let cancelled = false;
    setDetailState({ scope, revision, ref: selectedRef, loading: true });
    void client.githubPullRequestDetail(selectedRef).then(
      (data) => {
        if (!cancelled)
          setDetailState({
            scope,
            revision,
            ref: selectedRef,
            data,
            loading: false,
          });
      },
      (error: unknown) => {
        if (!cancelled)
          setDetailState({
            scope,
            revision,
            ref: selectedRef,
            error: errorCode(error),
            loading: false,
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, scope, selectedRef, revision]);

  const select = (ref: string) => {
    setSelection({ scope, route, ref, showDetail: true });
    onSelectPullRequest?.(ref);
  };
  const refresh = () =>
    setRequest({ scope, revision: revision + 1, page: 1, attempt: 0 });
  const loadMore = () =>
    setRequest({
      scope,
      revision,
      page: (inbox?.data?.page ?? 1) + 1,
      attempt: attempt + 1,
    });
  const lookup = normalizePullRequestUrl(query.trim());
  const hasMore =
    inbox?.data &&
    (inbox.data.hasMore.authored || inbox.data.hasMore.needsMyReview);
  const partial =
    inbox?.data &&
    Object.values(inbox.data.search).some(
      (search) => search.incompleteResults || search.searchLimitReached,
    );

  const inboxContent = (
    <aside
      className={styles.inbox}
      aria-label={t('prWorkbench.title')}
      data-testid="code-review-inbox"
    >
      <header className={styles.inboxHeader}>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t('prWorkbench.back')}
          >
            <ArrowLeftIcon size={17} />
          </Button>
        )}
        <h1>{t('prWorkbench.title')}</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="code-review-refresh"
          disabled={!inbox || inbox.loading}
          onClick={refresh}
          aria-label={t('prWorkbench.refresh')}
          title={t('prWorkbench.refresh')}
        >
          <RefreshCwIcon
            size={16}
            className={!inbox || inbox.loading ? styles.spinning : undefined}
          />
        </Button>
        {settingsControl}
      </header>
      <form
        className={styles.search}
        onSubmit={(event) => {
          event.preventDefault();
          if (lookup) select(lookup);
        }}
      >
        <SearchIcon size={16} aria-hidden="true" />
        <Input
          data-testid="code-review-search"
          aria-label={t('prWorkbench.search')}
          placeholder={t('prWorkbench.search')}
          value={query}
          onChange={(event) =>
            setQueryState({ scope, value: event.target.value })
          }
        />
        {lookup && (
          <Button
            type="submit"
            variant="ghost"
            size="icon-sm"
            aria-label={t('prWorkbench.open')}
          >
            <ArrowRightIcon />
          </Button>
        )}
      </form>
      {inbox?.data && !accountMismatch && (
        <p className={styles.account}>
          {inbox.data.account.login}
          <span> · {inbox.data.account.host}</span>
        </p>
      )}
      {query && !lookup && (
        <p className={styles.filterHint}>{t('prWorkbench.filterLoaded')}</p>
      )}
      <div className={styles.inboxContent}>
        {inboxError ? (
          <LoadError code={inboxError} onRetry={refresh} />
        ) : !inbox?.data ? (
          <div className={styles.loading} role="status">
            <LoaderCircleIcon className={styles.spinning} size={18} />
            {t('prWorkbench.loading')}
          </div>
        ) : (
          <>
            <PullRequestGroup
              title={t('prWorkbench.authored')}
              prs={inbox.data.authored}
              query={lookup ? '' : query}
              selectedRef={selectedRef}
              hasMore={inbox.data.hasMore.authored}
              onSelect={select}
            />
            <PullRequestGroup
              title={t('prWorkbench.requested')}
              prs={inbox.data.needsMyReview}
              query={lookup ? '' : query}
              selectedRef={selectedRef}
              hasMore={inbox.data.hasMore.needsMyReview}
              onSelect={select}
            />
            {partial && (
              <p className={styles.limit} role="status">
                {t('prWorkbench.searchLimited')}
              </p>
            )}
            {inbox.moreError && (
              <p className={styles.moreError} role="alert">
                {t(errorMessageKey(inbox.moreError))}
              </p>
            )}
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.loadMore}
                data-testid="code-review-load-more"
                disabled={inbox.loadingMore}
                onClick={loadMore}
              >
                {inbox.loadingMore && (
                  <LoaderCircleIcon size={14} className={styles.spinning} />
                )}
                {t(
                  inbox.moreError
                    ? 'prWorkbench.retry'
                    : 'prWorkbench.loadMore',
                )}
              </Button>
            )}
          </>
        )}
      </div>
    </aside>
  );
  const detailContent = (
    <div
      className={styles.detail}
      aria-busy={Boolean(selectedRef && (!detail || detail.loading))}
    >
      <div className={styles.mobileToolbar}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="code-review-detail-back"
          onClick={() => {
            setSelection({
              scope,
              route,
              ref: undefined,
              showDetail: false,
            });
            onSelectPullRequest?.(undefined);
          }}
        >
          <ArrowLeftIcon size={16} />
          {t('prWorkbench.title')}
        </Button>
      </div>
      {detailError ? (
        <LoadError code={detailError} detail onRetry={refresh} />
      ) : selectedRef && (!detail || detail.loading) ? (
        <div className={styles.empty} role="status">
          <LoaderCircleIcon className={styles.spinning} size={24} />
          <p>{t('prWorkbench.loadingDetail')}</p>
        </div>
      ) : detail?.data ? (
        <PullRequestDetails
          key={detail.data.pullRequest.url}
          detail={detail.data}
        />
      ) : (
        <div className={styles.empty}>
          <GitPullRequestIcon size={30} strokeWidth={1.5} />
          <h2>{t('prWorkbench.selectPr')}</h2>
          <p>{t('prWorkbench.selectPrBody')}</p>
        </div>
      )}
    </div>
  );
  return (
    <div
      ref={pane.containerRef}
      className={styles.root}
      data-testid="code-review-page"
      data-show-detail={showDetail}
      data-layout={pane.wide ? 'split' : 'stacked'}
    >
      {pane.wide ? (
        <ResizablePanelGroup
          onLayoutChanged={pane.onLayoutChanged}
          resizeTargetMinimumSize={{ fine: 10, coarse: 24 }}
        >
          <ResizablePanel
            id="code-review-inbox-panel"
            defaultSize={pane.width}
            minSize={280}
            maxSize={520}
            groupResizeBehavior="preserve-pixel-size"
            panelRef={pane.panelRef}
          >
            {inboxContent}
          </ResizablePanel>
          <ResizableHandle
            id="code-review-inbox-resize"
            className={styles.resizeHandle}
            aria-label={t('prWorkbench.resizeInbox')}
            disableDoubleClick
          />
          <ResizablePanel id="code-review-detail-panel" minSize={360}>
            {detailContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          {inboxContent}
          {detailContent}
        </>
      )}
    </div>
  );
}
