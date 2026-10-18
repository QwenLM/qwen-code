import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type {
  DaemonGitHubPullRequestDetail,
  DaemonGitHubPullRequestDetailResponse,
} from '@qwen-code/sdk/daemon';
import {
  ArrowRightIcon,
  CheckIcon,
  CircleIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageCircleIcon,
  XIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { timeAgo } from '../../utils/timeAgo';
import { Markdown } from '../messages/Markdown';
import { DiffView } from '../messages/tools/DiffView';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { GitHubAvatar } from './GitHubAvatar';
import { useReviewPane } from './useReviewPane';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../ui/resizable';
import styles from './CodeReviewPage.module.css';

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  const openExternal = useExternalLinkOpener();
  if (!href || !/^https?:\/\//i.test(href))
    return <span className={className}>{children}</span>;
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => openExternal(event, href)}
    >
      {children}
    </a>
  );
}

function checkState(
  check: DaemonGitHubPullRequestDetail['checksDetails'][number],
) {
  const conclusion = check.conclusion?.toLowerCase();
  if (conclusion === 'success') return 'passing';
  if (
    conclusion &&
    [
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
      'startup_failure',
      'stale',
    ].includes(conclusion)
  )
    return 'failing';
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipped';
  return check.status.toLowerCase() === 'completed' ? 'completed' : 'pending';
}

function ReviewState({ state }: { state: string }) {
  const { t } = useI18n();
  const normalized = state.toLowerCase();
  const known = [
    'approved',
    'changes_requested',
    'review_required',
    'commented',
    'dismissed',
    'pending',
  ].includes(normalized);
  return (
    <span className={styles.reviewState} data-state={normalized}>
      {known ? t(`prWorkbench.review.${normalized}`) : state}
    </span>
  );
}

function PendingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M8 3.5a4.5 4.5 0 0 1 0 9Z" fill="currentColor" />
    </svg>
  );
}

export function PullRequestDetails({
  detail,
}: {
  detail: DaemonGitHubPullRequestDetailResponse;
}) {
  const { t, language } = useI18n();
  const pane = useReviewPane('context', 300, 240, 440, 740);
  const pr = detail.pullRequest;
  const [tab, setTab] = useState('overview');
  const [allChecks, setAllChecks] = useState(false);
  const [allReviewers, setAllReviewers] = useState(false);
  const [allComments, setAllComments] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | undefined>(
    pr.files[0]?.path,
  );
  const activity = [
    ...pr.reviews.map((review) => ({
      ...review,
      key: `review-${review.id}`,
      state: review.state,
      path: null,
      line: null,
    })),
    ...pr.comments.map((comment) => ({
      ...comment,
      key: `comment-${comment.id}`,
      state: null,
    })),
  ].sort((left, right) => right.createdAt - left.createdAt);
  const reviewerPriority: Record<string, number> = {
    changes_requested: 0,
    review_required: 1,
    pending: 1,
    approved: 2,
  };
  const reviewers = [
    ...(pr.reviewers ??
      pr.requestedReviewers.map((reviewer) => ({
        ...reviewer,
        state: 'REVIEW_REQUIRED',
        commentCount: 0,
      }))),
  ].sort(
    (left, right) =>
      (reviewerPriority[left.state.toLowerCase()] ?? 3) -
      (reviewerPriority[right.state.toLowerCase()] ?? 3),
  );
  const checkPriority = (check: (typeof pr.checksDetails)[number]) => {
    const state = checkState(check);
    if (state === 'failing') return 0;
    if (state === 'pending')
      return check.status.toLowerCase() === 'in_progress' ? 1 : 2;
    return state === 'passing' ? 4 : 3;
  };
  const checks = [...pr.checksDetails].sort(
    (left, right) => checkPriority(left) - checkPriority(right),
  );
  const checkNames = new Map<string, number>();
  for (const check of checks)
    checkNames.set(check.name, (checkNames.get(check.name) ?? 0) + 1);
  const StateIcon = pr.state === 'merged' ? GitMergeIcon : GitPullRequestIcon;

  const mainContent = (
    <main className={styles.main} data-testid="code-review-body">
      <header className={styles.prHeader}>
        <div className={styles.prEyebrow}>
          <Badge
            variant="secondary"
            className={styles.stateBadge}
            data-state={pr.state}
          >
            <StateIcon size={13} />
            {t(`prWorkbench.state.${pr.state}`)}
          </Badge>
          <span>{detail.repository.nameWithOwner}</span>
          <span>#{pr.number}</span>
          <ExternalLink href={pr.url} className={styles.externalLink}>
            <ExternalLinkIcon size={13} />
            {t('prWorkbench.github')}
          </ExternalLink>
        </div>
        <h2>{pr.title}</h2>
        <div className={styles.prMetadata}>
          {pr.author && (
            <>
              <GitHubAvatar login={pr.author} src={pr.authorAvatarUrl} />
              <span className={styles.prAuthor}>{pr.author}</span>
            </>
          )}
          <span>{timeAgo(pr.updatedAt, Date.now() / 1000, language)}</span>
          <div
            className={styles.branches}
            aria-label={t('prWorkbench.fromTo', {
              head: pr.headRefName,
              base: pr.baseRefName,
            })}
          >
            <span title={`${pr.headRefName} (${pr.headRefOid})`}>
              {pr.headRefName}
            </span>
            <ArrowRightIcon size={13} aria-hidden="true" />
            <span title={`${pr.baseRefName} (${pr.baseRefOid})`}>
              {pr.baseRefName}
            </span>
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className={styles.tabs}>
        <TabsList
          variant="line"
          className={styles.detailTabs}
          aria-label={t('prWorkbench.title')}
        >
          <TabsTrigger value="overview">
            {t('prWorkbench.overview')}
          </TabsTrigger>
          <TabsTrigger
            value="files"
            title={pr.truncated.files ? t('prWorkbench.truncated') : undefined}
          >
            {t('prWorkbench.files')}{' '}
            <span className={styles.tabCount}>{pr.changedFiles}</span>
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            title={
              pr.truncated.comments || pr.truncated.reviews
                ? t('prWorkbench.truncated')
                : undefined
            }
          >
            {t('prWorkbench.activity')}{' '}
            <span className={styles.tabCount}>
              {activity.length}
              {pr.truncated.comments || pr.truncated.reviews ? '+' : ''}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className={styles.tabContent}>
          {pr.body ? (
            <div className={styles.description}>
              <Markdown content={pr.body} />
            </div>
          ) : (
            <p className={styles.muted}>{t('prWorkbench.noBody')}</p>
          )}
        </TabsContent>
        <TabsContent value="files" className={styles.tabContent}>
          {pr.files.length === 0 && (
            <p className={styles.muted}>{t('prWorkbench.noFiles')}</p>
          )}
          <div className={styles.files}>
            {pr.files.map((file) => (
              <section className={styles.file} key={file.path}>
                <button
                  type="button"
                  className={styles.fileHeader}
                  aria-expanded={expandedFile === file.path}
                  onClick={() =>
                    setExpandedFile(
                      expandedFile === file.path ? undefined : file.path,
                    )
                  }
                >
                  <ChevronRightIcon
                    size={13}
                    className={
                      expandedFile === file.path ? styles.expanded : undefined
                    }
                  />
                  <FileCode2Icon size={14} />
                  <span title={file.path}>{file.path}</span>
                  <span className={styles.diffStats}>
                    +{file.additions} / −{file.deletions}
                  </span>
                </button>
                {expandedFile === file.path && (
                  <>
                    {file.patch ? (
                      <DiffView diff={file.patch} />
                    ) : (
                      <p className={styles.patchNotice}>
                        {t('prWorkbench.patchUnavailable')}{' '}
                        <ExternalLink href={`${pr.url}/files`}>
                          {t('prWorkbench.github')}
                        </ExternalLink>
                      </p>
                    )}
                    {file.patchTruncated && (
                      <p className={styles.patchNotice}>
                        {t('prWorkbench.patchTruncated')}{' '}
                        <ExternalLink href={`${pr.url}/files`}>
                          {t('prWorkbench.github')}
                        </ExternalLink>
                      </p>
                    )}
                  </>
                )}
              </section>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="activity" className={styles.tabContent}>
          {activity.length === 0 && (
            <p className={styles.muted}>{t('prWorkbench.noActivity')}</p>
          )}
          <div className={styles.activity}>
            {activity.map((item) => (
              <article className={styles.activityItem} key={item.key}>
                <GitHubAvatar login={item.author} src={item.authorAvatarUrl} />
                <div className={styles.activityBody}>
                  <div className={styles.activityMeta}>
                    <strong>{item.author}</strong>
                    {item.state ? (
                      <ReviewState state={item.state} />
                    ) : (
                      <span>{t('prWorkbench.comment')}</span>
                    )}
                    <ExternalLink href={item.url}>
                      {timeAgo(item.createdAt, Date.now() / 1000, language)}
                    </ExternalLink>
                  </div>
                  {item.path && (
                    <code className={styles.commentPath}>
                      {item.path}
                      {item.line !== null ? `:${item.line}` : ''}
                    </code>
                  )}
                  {item.body && <Markdown content={item.body} />}
                </div>
              </article>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
  const contextContent = (
    <aside
      className={styles.context}
      data-testid="code-review-context"
      aria-label={t('prWorkbench.activity')}
    >
      <section className={styles.contextSection}>
        <h3>{t('prWorkbench.changes')}</h3>
        <button
          type="button"
          className={styles.changesSummary}
          onClick={() => setTab('files')}
        >
          <FileCode2Icon size={17} aria-hidden="true" />
          <span>{t('prWorkbench.filesCount', { count: pr.changedFiles })}</span>
          <span className={styles.changeCounts}>
            <span>+{pr.additions.toLocaleString()}</span>
            <span>−{pr.deletions.toLocaleString()}</span>
          </span>
          <ChevronRightIcon size={14} aria-hidden="true" />
        </button>
      </section>
      <section className={styles.contextSection}>
        <h3
          title={pr.truncated.comments ? t('prWorkbench.truncated') : undefined}
        >
          {t('prWorkbench.comments')}
          <span className={styles.sectionCount}>
            {pr.comments.length}
            {pr.truncated.comments ? '+' : ''}
          </span>
        </h3>
        {pr.comments.length === 0 && (
          <p className={styles.muted}>{t('prWorkbench.noComments')}</p>
        )}
        <div className={styles.commentPreviews}>
          {[...pr.comments]
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, allComments ? undefined : 5)
            .map((comment) => {
              const preview =
                comment.body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim() ||
                t('prWorkbench.comment');
              return (
                <button
                  type="button"
                  key={comment.id}
                  onClick={() => setTab('activity')}
                  className={styles.commentPreview}
                  aria-label={`${comment.author}: ${preview.slice(0, 300)}`}
                  title={`${comment.author}: ${preview.slice(0, 300)}`}
                >
                  <CircleIcon
                    size={16}
                    className={styles.commentIcon}
                    aria-hidden="true"
                  />
                  <GitHubAvatar
                    login={comment.author}
                    src={comment.authorAvatarUrl}
                  />
                  <span className={styles.commentExcerpt}>
                    <ReactMarkdown
                      skipHtml
                      allowedElements={[]}
                      unwrapDisallowed
                    >
                      {preview}
                    </ReactMarkdown>
                  </span>
                </button>
              );
            })}
        </div>
        {pr.comments.length > 5 && (
          <button
            type="button"
            className={styles.expandButton}
            data-testid="code-review-comments-expand"
            aria-expanded={allComments}
            onClick={() => setAllComments(!allComments)}
          >
            {t(allComments ? 'prWorkbench.showLess' : 'prWorkbench.showAll', {
              count: pr.comments.length,
            })}
          </button>
        )}
      </section>
      <section className={styles.contextSection}>
        <h3
          title={
            pr.truncated.reviewers || pr.truncated.requestedReviewers
              ? t('prWorkbench.truncated')
              : undefined
          }
        >
          {t('prWorkbench.reviewers')}
          {(pr.truncated.reviewers || pr.truncated.requestedReviewers) && (
            <span className={styles.sectionCount}>{reviewers.length}+</span>
          )}
        </h3>
        {reviewers.length === 0 && (
          <p className={styles.muted}>{t('prWorkbench.noReviewers')}</p>
        )}
        <ul className={styles.reviewers}>
          {(allReviewers ? reviewers : reviewers.slice(0, 5)).map(
            (reviewer) => {
              const state = reviewer.state.toLowerCase();
              const label = t(`prWorkbench.review.${state}`);
              return (
                <li
                  key={`${reviewer.kind}-${reviewer.login}`}
                  data-testid="code-review-reviewer"
                  data-state={state}
                >
                  <span
                    className={styles.reviewerStateIcon}
                    title={label}
                    role="img"
                    aria-label={label}
                  >
                    {state === 'changes_requested' ? (
                      <XIcon size={16} aria-hidden="true" />
                    ) : state === 'approved' ? (
                      <CheckIcon size={16} aria-hidden="true" />
                    ) : state === 'review_required' || state === 'pending' ? (
                      <PendingIcon />
                    ) : (
                      <CircleIcon size={16} aria-hidden="true" />
                    )}
                  </span>
                  <GitHubAvatar
                    login={reviewer.login}
                    src={reviewer.avatarUrl}
                    team={reviewer.kind === 'team'}
                  />
                  <ExternalLink href={reviewer.url}>
                    {reviewer.login}
                  </ExternalLink>
                  {reviewer.commentCount > 0 && (
                    <span
                      className={styles.reviewerComments}
                      aria-label={t('prWorkbench.reviewComments', {
                        count: reviewer.commentCount,
                      })}
                      title={t('prWorkbench.reviewComments', {
                        count: reviewer.commentCount,
                      })}
                    >
                      {reviewer.commentCount}
                      <MessageCircleIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </li>
              );
            },
          )}
        </ul>
        {reviewers.length > 5 && (
          <button
            type="button"
            className={styles.expandButton}
            data-testid="code-review-reviewers-expand"
            aria-expanded={allReviewers}
            onClick={() => setAllReviewers(!allReviewers)}
          >
            {t(allReviewers ? 'prWorkbench.showLess' : 'prWorkbench.showAll', {
              count: reviewers.length,
            })}
          </button>
        )}
      </section>
      <section className={styles.contextSection}>
        <h3
          title={pr.truncated.checks ? t('prWorkbench.truncated') : undefined}
        >
          {t('prWorkbench.checks')}
          <span className={styles.sectionCount}>
            {pr.checksDetails.length}
            {pr.truncated.checks ? '+' : ''}
          </span>
        </h3>
        {pr.checksDetails.length === 0 && (
          <p className={styles.muted}>{t('prWorkbench.noChecks')}</p>
        )}
        <ul className={styles.checks}>
          {(allChecks ? checks : checks.slice(0, 5)).map((check, index) => {
            const state = checkState(check);
            const qualifier =
              (checkNames.get(check.name) ?? 0) > 1
                ? [check.workflowName, check.event].filter(Boolean).join(' · ')
                : '';
            const label = qualifier
              ? `${check.name} (${qualifier})`
              : check.name;
            const Icon =
              state === 'passing'
                ? CircleCheckIcon
                : state === 'failing'
                  ? CircleXIcon
                  : state === 'pending'
                    ? PendingIcon
                    : CircleDashedIcon;
            return (
              <li
                key={check.id ?? `${check.name}-${index}`}
                data-testid="code-review-check"
                data-state={state}
                title={`${label}: ${t(`prWorkbench.check.${state}`)}`}
              >
                <span
                  className={styles.checkIcon}
                  role="img"
                  aria-label={t(`prWorkbench.check.${state}`)}
                >
                  <Icon size={16} aria-hidden="true" />
                </span>
                <ExternalLink href={check.url}>{label}</ExternalLink>
              </li>
            );
          })}
        </ul>
        {pr.checksDetails.length > 5 && (
          <button
            type="button"
            className={styles.expandButton}
            data-testid="code-review-checks-expand"
            aria-expanded={allChecks}
            onClick={() => setAllChecks(!allChecks)}
          >
            {t(allChecks ? 'prWorkbench.showLess' : 'prWorkbench.showAll', {
              count: pr.checksDetails.length,
            })}
          </button>
        )}
      </section>
    </aside>
  );
  return (
    <div
      ref={pane.containerRef}
      className={styles.detailLayout}
      data-testid="code-review-detail"
      data-layout={pane.wide ? 'split' : 'stacked'}
    >
      {pane.wide ? (
        <ResizablePanelGroup
          onLayoutChanged={pane.onLayoutChanged}
          resizeTargetMinimumSize={{ fine: 10, coarse: 24 }}
        >
          <ResizablePanel id="code-review-body-panel" minSize={360}>
            {mainContent}
          </ResizablePanel>
          <ResizableHandle
            id="code-review-context-resize"
            className={styles.resizeHandle}
            aria-label={t('prWorkbench.resizeContext')}
            disableDoubleClick
          />
          <ResizablePanel
            id="code-review-context-panel"
            defaultSize={pane.width}
            minSize={240}
            maxSize={440}
            groupResizeBehavior="preserve-pixel-size"
            panelRef={pane.panelRef}
          >
            {contextContent}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          {mainContent}
          {contextContent}
        </>
      )}
    </div>
  );
}
