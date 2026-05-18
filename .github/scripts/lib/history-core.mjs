const BY_DESIGN_LABELS = new Set([
  'by design',
  'wontfix',
  "won't fix",
  'not planned',
  'declined',
  'invalid',
]);

const BY_DESIGN_TEXT =
  /\b(direction|decided not|by design|not planned|won't ship|will not ship|rather not carry|not to ship|declined)\b/i;

export function buildHistoryQueries({ keywords = [], repo }) {
  const queryText = keywords.slice(0, 6).join(' ').trim() || 'qwen code';
  const repoQualifier = repo ? ` repo:${repo}` : '';
  return {
    closedIssues: `${queryText}${repoQualifier}`,
    mergedPrs: `${queryText}${repoQualifier}`,
    byDesign: `${queryText} is:unmerged${repoQualifier}`,
    regression: `${queryText} regression OR revert${repoQualifier}`,
  };
}

export function hasDifferentiatingRationale(body = '') {
  return /\b(why this is different|why it is different|different from|this differs|unlike the prior|prior decision|rationale|context changed|new constraint)\b/i.test(
    body,
  );
}

function labelsContainByDesign(labels = []) {
  return labels.some((label) => {
    const name = typeof label === 'string' ? label : label?.name;
    return name && BY_DESIGN_LABELS.has(name.toLowerCase());
  });
}

function commentsContainByDesign(comments = []) {
  return comments.some((comment) => BY_DESIGN_TEXT.test(comment.body ?? ''));
}

function citationFor(pr) {
  const comment = (pr.comments ?? []).find((item) =>
    BY_DESIGN_TEXT.test(item.body ?? ''),
  );
  return comment?.url ?? pr.url;
}

export function classifyHistoryResults({
  prBody = '',
  closedIssues = [],
  mergedPrs = [],
  byDesignClosedPrs = [],
  badSignals = [],
} = {}) {
  const findings = [];
  const hasRationale = hasDifferentiatingRationale(prBody);

  for (const pr of byDesignClosedPrs) {
    if (
      !labelsContainByDesign(pr.labels) &&
      !commentsContainByDesign(pr.comments)
    ) {
      continue;
    }
    findings.push({
      kind: 'by_design_rejected',
      severity: hasRationale ? 'advisory' : 'blocking',
      message: hasRationale
        ? `Prior by-design rejection found for PR #${pr.number}; author provided differentiating rationale.`
        : `Prior by-design rejection found for PR #${pr.number}; PR description should explain why this proposal is different.`,
      citations: [citationFor(pr)].filter(Boolean),
      source: {
        number: pr.number,
        title: pr.title,
        url: pr.url,
      },
    });
  }

  for (const issue of closedIssues.slice(0, 3)) {
    findings.push({
      kind: 'closed_issue_overlap',
      severity: 'advisory',
      message: `Closed issue #${issue.number} may overlap with this PR; confirm whether this is a regression or duplicate.`,
      citations: [issue.url].filter(Boolean),
      source: issue,
    });
  }

  for (const pr of mergedPrs.slice(0, 3)) {
    findings.push({
      kind: 'merged_pr_overlap',
      severity: 'advisory',
      message: `Merged PR #${pr.number} appears related; clarify whether this extends or supersedes that work.`,
      citations: [pr.url].filter(Boolean),
      source: pr,
    });
  }

  for (const signal of badSignals.slice(0, 3)) {
    findings.push({
      kind: 'regression_or_revert_signal',
      severity: 'advisory',
      message: `Historical regression/revert signal found: ${signal.title ?? signal.url}`,
      citations: [signal.url].filter(Boolean),
      source: signal,
    });
  }

  return { findings };
}
