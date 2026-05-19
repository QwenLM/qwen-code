const BLOCKING_DIRECTION_LABELS = new Set([
  'by design',
  'wontfix',
  "won't fix",
  'not planned',
  'declined',
  'invalid',
]);

const ADVISORY_DIRECTION_LABELS = new Set([
  'status/on-hold',
  'on hold',
  'status/stale',
  'stale',
]);

const BLOCKING_DIRECTION_TEXT =
  /\b(by design|decided not|not planned|won't ship|will not ship|rather not carry|not to ship|declined|direction call|we(?:'ve| have)? decided not to ship)\b/i;

const ADVISORY_DIRECTION_TEXT =
  /\b(still on the roadmap but not (?:a )?near-term priority|on the roadmap but not|not (?:a )?near-term priority|on hold|blocked until|stale)\b/i;

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function buildByDesignCandidates({ keywords = [], repoQualifier = '' }) {
  const keywordText = keywords.join(' ').toLowerCase();
  const queries = [];

  const add = (query) => {
    queries.push(`${query} is:unmerged${repoQualifier}`);
  };

  add(keywords.slice(0, 6).join(' ').trim() || 'qwen code');

  if (
    hasAny(keywordText, [
      /\bmodel(?:s)?\b/,
      /\bmodeldialog\b/,
      /\bmodelproviders\b/,
      /\bprovider(?:s)?\b/,
      /\bopenai\b/,
      /\banthropic\b/,
      /\bapi key\b/,
    ])
  ) {
    add('model list');
    add('openai-compatible models');
    add('model provider');
  }

  if (
    hasAny(keywordText, [
      /\binstaller\b/,
      /\binstall\b/,
      /\bdesktop\b/,
      /\bmacos\b/,
      /\bstandalone\b/,
      /\barchive\b/,
      /\bapp\b/,
    ])
  ) {
    add('standalone archive');
    add('desktop app installer');
    add('macos installer');
  }

  if (
    hasAny(keywordText, [/\bweb\b/, /\bgui\b/, /\bchrome\b/, /\bextension\b/])
  ) {
    add('web gui');
    add('chrome extension');
  }

  return unique(queries);
}

// GitHub search treats `qualifier:value` tokens specially. Even though
// the keyword tokenizer currently strips colons, sanitize here so a
// future tokenizer change can't silently turn PR-derived text into
// query qualifiers (e.g. `author:nobody`, `label:bug`) that narrow or
// suppress the history scan.
const SEARCH_QUALIFIER =
  /^(repo|org|user|author|assignee|mentions|commenter|involves|label|milestone|project|state|is|in|type|status|base|head|language|created|updated|closed|merged|comments|reactions|interactions|draft|review|reviewed-by|review-requested|team|archived|sort|no|linked)$/i;

function sanitizeKeyword(word) {
  return word
    .split(':')
    .filter((part) => part && !SEARCH_QUALIFIER.test(part))
    .join(' ')
    .replace(/["()<>]/g, ' ')
    .trim();
}

function sanitizeKeywords(keywords) {
  return keywords.map(sanitizeKeyword).filter(Boolean);
}

export function buildHistoryQueries({ keywords: rawKeywords = [], repo }) {
  const keywords = sanitizeKeywords(rawKeywords);
  const queryText = keywords.slice(0, 6).join(' ').trim() || 'qwen code';
  const repoQualifier = repo ? ` repo:${repo}` : '';
  const allByDesignCandidates = buildByDesignCandidates({
    keywords,
    repoQualifier,
  });
  const keywordText = keywords.join(' ').toLowerCase();
  const byDesignBlockingCandidates = [allByDesignCandidates[0]];

  if (keywordText.includes('model list')) {
    byDesignBlockingCandidates.push(`model list is:unmerged${repoQualifier}`);
  }
  if (
    keywordText.includes('desktop app') ||
    keywordText.includes('macos installer') ||
    keywordText.includes('standalone archive')
  ) {
    byDesignBlockingCandidates.push(
      `desktop app installer is:unmerged${repoQualifier}`,
    );
  }

  const blockingCandidates = unique(byDesignBlockingCandidates);
  const advisoryCandidates = allByDesignCandidates.filter(
    (query) => !blockingCandidates.includes(query),
  );

  return {
    closedIssues: `${queryText}${repoQualifier}`,
    mergedPrs: `${queryText}${repoQualifier}`,
    byDesign: blockingCandidates[0],
    byDesignCandidates: unique([...blockingCandidates, ...advisoryCandidates]),
    byDesignBlockingCandidates: blockingCandidates,
    byDesignAdvisoryCandidates: advisoryCandidates,
    regression: `${queryText} regression OR revert${repoQualifier}`,
  };
}

export function hasDifferentiatingRationale(body = '') {
  return /\b(why this is different|why it is different|different from|this differs|unlike the prior|prior decision|rationale|context changed|new constraint)\b/i.test(
    body,
  );
}

function labelsContain(labels = [], labelSet) {
  return labels.some((label) => {
    const name = typeof label === 'string' ? label : label?.name;
    return name && labelSet.has(name.toLowerCase());
  });
}

function commentsContain(comments = [], pattern) {
  return comments.some((comment) => pattern.test(comment.body ?? ''));
}

function citationFor(pr) {
  const comment = (pr.comments ?? []).find(
    (item) =>
      BLOCKING_DIRECTION_TEXT.test(item.body ?? '') ||
      ADVISORY_DIRECTION_TEXT.test(item.body ?? ''),
  );
  return comment?.url ?? pr.url;
}

function classifyClosedUnmergedDecision(pr) {
  if (
    labelsContain(pr.labels, BLOCKING_DIRECTION_LABELS) ||
    commentsContain(pr.comments, BLOCKING_DIRECTION_TEXT)
  ) {
    return 'blocking';
  }
  if (
    labelsContain(pr.labels, ADVISORY_DIRECTION_LABELS) ||
    commentsContain(pr.comments, ADVISORY_DIRECTION_TEXT)
  ) {
    return 'advisory';
  }
  return undefined;
}

export function classifyHistoryResults({
  prBody = '',
  closedIssues = [],
  mergedPrs = [],
  byDesignClosedPrs = [],
  directionCandidatePrs = [],
  badSignals = [],
} = {}) {
  const findings = [];
  const hasRationale = hasDifferentiatingRationale(prBody);
  const processedDirectionPrs = new Set();

  for (const pr of byDesignClosedPrs) {
    const decisionSeverity = classifyClosedUnmergedDecision(pr);
    if (!decisionSeverity) {
      continue;
    }
    processedDirectionPrs.add(pr.number);
    const blockingWithoutRationale =
      decisionSeverity === 'blocking' && !hasRationale;
    findings.push({
      kind: blockingWithoutRationale
        ? 'by_design_rejected'
        : 'closed_unmerged_direction',
      severity: blockingWithoutRationale ? 'blocking' : 'advisory',
      message:
        decisionSeverity === 'blocking'
          ? hasRationale
            ? `Prior hard direction rejection found for PR #${pr.number}; author provided differentiating rationale.`
            : `Prior hard direction rejection found for PR #${pr.number}; PR description should explain why this proposal is different.`
          : `Prior closed-unmerged direction signal found for PR #${pr.number}; confirm roadmap priority before proceeding.`,
      citations: [citationFor(pr)].filter(Boolean),
      source: {
        number: pr.number,
        title: pr.title,
        url: pr.url,
      },
    });
  }

  for (const pr of directionCandidatePrs) {
    if (processedDirectionPrs.has(pr.number)) {
      continue;
    }
    const decisionSeverity = classifyClosedUnmergedDecision(pr);
    if (!decisionSeverity) {
      continue;
    }
    findings.push({
      kind: 'closed_unmerged_direction_candidate',
      severity: 'advisory',
      message: `Prior closed-unmerged direction candidate found for PR #${pr.number}; confirm whether this PR repeats or differs from that decision.`,
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
