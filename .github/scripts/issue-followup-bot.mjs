#!/usr/bin/env node
/* global console, fetch, process, setTimeout */

import { pathToFileURL } from 'node:url';

export const INVALID_COMMENT_MARKER = '<!-- qwen-issue-bot:invalid -->';
export const NEEDS_INFO_COMMENT_MARKER = '<!-- qwen-issue-bot:needs-info -->';
export const RELATED_COMMENT_MARKER = '<!-- qwen-issue-bot:related -->';

export const DEFAULT_SCHEDULED_LIMIT = 10;
const RELATED_ISSUE_LIMIT = 3;
const GITHUB_API_BASE = 'https://api.github.com';
const MAX_GITHUB_REQUEST_ATTEMPTS = 3;

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'but',
  'can',
  'cannot',
  'code',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'issue',
  'not',
  'qwen',
  'that',
  'the',
  'this',
  'using',
  'was',
  'when',
  'with',
  'you',
]);

const TRIVIAL_PHRASES = new Set([
  'a',
  'aa',
  'aaa',
  'aaaa',
  'asdf',
  'ignore',
  'just testing',
  'na',
  'n/a',
  'none',
  'nothing',
  'please ignore',
  'qwerty',
  'test',
  'testing',
  'test issue',
]);

const MEANINGFUL_SHORT_TERMS = new Set([
  'api',
  'auth',
  'bug',
  'cli',
  'crash',
  'error',
  'fail',
  'login',
  'mcp',
  'oauth',
  'proxy',
  'shell',
  'token',
  'tool',
  'vscode',
]);

const USER_TEMPLATE_HEADINGS = new Set([
  'anything else we need to know?',
  'login information',
  'what did you expect to happen?',
  'what happened?',
]);

function normalizeLabels(labels = []) {
  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

function normalizeText(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_`[\](){}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function issueText(issue) {
  return normalizeText(`${issue.title || ''}\n${issue.body || ''}`);
}

function wordCount(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function compactSignal(text) {
  return normalizeText(text).replace(/[^a-z0-9]+/g, '');
}

function isRepeatedSignal(signal) {
  if (signal.length < 6) {
    return false;
  }
  return new Set(signal.split('')).size <= 2;
}

function extractUserTemplateValues(body) {
  const matches = [...String(body || '').matchAll(/^###\s+(.+?)\s*$/gim)];
  const values = [];

  for (let index = 0; index < matches.length; index += 1) {
    const heading = normalizeText(matches[index][1]);
    if (!USER_TEMPLATE_HEADINGS.has(heading)) {
      continue;
    }

    const start = matches[index].index + matches[index][0].length;
    const end =
      index + 1 < matches.length ? matches[index + 1].index : body.length;
    values.push(String(body).slice(start, end).trim());
  }

  return values;
}

function isShortTemplateNoise(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return true;
  }

  if (
    /\b(settings\.json|settings|config|command|exception|traceback|expected|actual|windows|linux|macos|darwin)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  const tokens = normalized.split(/\s+/);
  if (tokens.some((token) => MEANINGFUL_SHORT_TERMS.has(token))) {
    return false;
  }

  const signal = compactSignal(normalized);
  return tokens.length <= 2 && signal.length > 0 && signal.length <= 12;
}

function hasOnlyShortTemplateNoise(issue) {
  const title = normalizeText(issue.title);
  const titleSignal = compactSignal(title);
  if (
    !titleSignal ||
    title.includes(' ') ||
    titleSignal.length > 12 ||
    MEANINGFUL_SHORT_TERMS.has(titleSignal)
  ) {
    return false;
  }

  const values = extractUserTemplateValues(issue.body);
  if (values.length < 2) {
    return false;
  }

  return values.every(isShortTemplateNoise);
}

function hasExistingLabel(issue, prefix) {
  return normalizeLabels(issue.labels).some((label) =>
    label.startsWith(prefix),
  );
}

function addLabel(labels, labelNames, existingLabels, name) {
  if (!labelNames.has(name) || existingLabels.has(name)) {
    return;
  }
  labels.add(name);
}

function isClearlyInvalidIssue(issue) {
  const title = normalizeText(issue.title);
  const body = normalizeText(issue.body);
  const combined = normalizeText(`${title} ${body}`);
  const signal = compactSignal(combined);
  const words = wordCount(combined);

  if (!title && !body) {
    return true;
  }

  if (TRIVIAL_PHRASES.has(title) && (!body || TRIVIAL_PHRASES.has(body))) {
    return true;
  }

  if (TRIVIAL_PHRASES.has(combined) && words <= 4) {
    return true;
  }

  if (signal.length <= 4 && words <= 2) {
    return true;
  }

  if (isRepeatedSignal(signal) && words <= 3) {
    return true;
  }

  if (hasOnlyShortTemplateNoise(issue)) {
    return true;
  }

  return false;
}

function isLikelyFeatureRequest(text, labels) {
  return (
    labels.includes('type/feature-request') ||
    /\b(feature request|proposal|enhancement|support|add|would like|please add|need a way)\b/i.test(
      text,
    )
  );
}

function isLikelyQuestion(text, labels) {
  return (
    labels.includes('type/question') ||
    /\b(question|how do i|how to|is there a way|help|support)\b/i.test(text)
  );
}

function isLikelyBug(text, labels) {
  return (
    labels.includes('type/bug') ||
    /\b(bug|crash|error|exception|fail|failed|failing|broken|cannot|can't|unable|unexpected|overwrite|overwrites|overwritten|regression|not working)\b/i.test(
      text,
    )
  );
}

function hasEnvironmentDetails(text) {
  return /\b(\/about|cli version|qwen code version|version\s*[:=]?\s*v?\d+\.\d+\.\d+|os\s*[:=]|macos|darwin|windows|linux|ubuntu|auth method|oauth|api key)\b/i.test(
    text,
  );
}

function hasReproductionDetails(text) {
  return /\b(steps to reproduce|reproduce|reproduction|minimal repro|run\s+`?|command|input|when i|after i)\b/i.test(
    text,
  );
}

function hasExpectedAndActual(text) {
  return /\b(expected|actual|what happened|what did you expect|should|instead)\b/i.test(
    text,
  );
}

function hasDiagnostics(text) {
  return /\b(log|logs|stack trace|traceback|screenshot|recording|config|settings\.json|error output|terminal output)\b/i.test(
    text,
  );
}

function missingInformationForIssue(issue) {
  const text = issueText(issue);
  const labels = normalizeLabels(issue.labels);

  if (isClearlyInvalidIssue(issue)) {
    return [];
  }

  if (!isLikelyBug(text, labels) && !isLikelyQuestion(text, labels)) {
    return [];
  }

  const missing = [];

  if (!hasEnvironmentDetails(text)) {
    missing.push('full output of the `/about` command');
  }
  if (!hasReproductionDetails(text)) {
    missing.push('minimal reproduction steps or the exact command you ran');
  }
  if (!hasExpectedAndActual(text)) {
    missing.push('expected behavior and actual behavior');
  }
  if (!hasDiagnostics(text)) {
    missing.push('relevant logs, screenshots, or configuration snippets');
  }

  return missing;
}

function inferLabels(issue, availableLabelNames) {
  const labelNames = new Set(availableLabelNames);
  const existingLabels = new Set(normalizeLabels(issue.labels));
  const labelsToAdd = new Set();
  const text = issueText(issue);

  const hasType = hasExistingLabel(issue, 'type/');
  if (!hasType) {
    if (isLikelyFeatureRequest(text, [...existingLabels])) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'type/feature-request');
    } else if (isLikelyQuestion(text, [...existingLabels])) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'type/question');
    } else if (isLikelyBug(text, [...existingLabels])) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'type/bug');
    }
  }

  const hasCategory = hasExistingLabel(issue, 'category/');
  if (!hasCategory) {
    if (/\b(vscode|vs code|ide companion|zed|ide)\b/i.test(text)) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'category/integration');
    } else if (
      /\b(settings|settings\.json|config|configuration)\b/i.test(text)
    ) {
      addLabel(
        labelsToAdd,
        labelNames,
        existingLabels,
        'category/configuration',
      );
    } else if (/\b(auth|login|oauth|api key|token)\b/i.test(text)) {
      addLabel(
        labelsToAdd,
        labelNames,
        existingLabels,
        'category/authentication',
      );
    } else if (
      /\b(install|installation|npm|package|windows|macos|linux)\b/i.test(text)
    ) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'category/platform');
    } else if (
      /\b(mcp|tool|shell|file operation|web search|memory)\b/i.test(text)
    ) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'category/tools');
    } else if (/\b(render|markdown|theme|ui|display)\b/i.test(text)) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'category/ui');
    } else if (
      /\b(slow|latency|performance|memory usage|cache)\b/i.test(text)
    ) {
      addLabel(labelsToAdd, labelNames, existingLabels, 'category/performance');
    }
  }

  if (/\b(vscode|vs code)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'scope/vscode');
  }
  if (/\b(ide companion|ide)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'scope/ide');
  }
  if (/\b(settings|settings\.json|config|configuration)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'scope/settings');
  }
  if (/\b(coding plan|plan mode|planning)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'coding-plan');
  }
  if (/\b(mcp)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'scope/mcp');
  }
  if (/\b(shell|command)\b/i.test(text)) {
    addLabel(labelsToAdd, labelNames, existingLabels, 'scope/shell');
  }

  const missingInfo = missingInformationForIssue(issue);
  if (missingInfo.length > 0) {
    addLabel(
      labelsToAdd,
      labelNames,
      existingLabels,
      'status/need-information',
    );
    addLabel(
      labelsToAdd,
      labelNames,
      existingLabels,
      'status/waiting-for-feedback',
    );
  }

  return [...labelsToAdd].sort();
}

function tokenize(text) {
  const normalized = normalizeText(text)
    .replace(/settings\.json/g, 'settings json settingsjson')
    .replace(/vs code/g, 'vscode');

  return normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function scoreRelatedIssue(issue, candidate) {
  if (issue.number === candidate.number) {
    return 0;
  }

  const issueTokens = new Set(
    tokenize(`${issue.title || ''} ${issue.body || ''}`),
  );
  const candidateTokens = new Set(
    tokenize(`${candidate.title || ''} ${candidate.body || ''}`),
  );
  const issueTitleTokens = new Set(tokenize(issue.title || ''));
  const candidateTitleTokens = new Set(tokenize(candidate.title || ''));
  const sharedTokens = [];
  let sharedTitleTokenCount = 0;
  let score = 0;

  for (const token of issueTokens) {
    if (candidateTokens.has(token)) {
      sharedTokens.push(token);
      score += token.length >= 8 ? 2 : 1;
    }
  }

  for (const token of issueTitleTokens) {
    if (candidateTitleTokens.has(token)) {
      sharedTitleTokenCount += 1;
    }
  }

  const hasStrongSharedToken = sharedTokens.some((token) => token.length >= 12);
  if (sharedTitleTokenCount === 0 && !hasStrongSharedToken) {
    return 0;
  }

  const issueTitle = normalizeText(issue.title);
  const candidateTitle = normalizeText(candidate.title);
  if (issueTitle && candidateTitle && issueTitle === candidateTitle) {
    score += 5;
  }

  return score;
}

function selectRelatedIssues(issue, relatedIssues) {
  return relatedIssues
    .map((candidate) => ({
      ...candidate,
      score: scoreRelatedIssue(issue, candidate),
    }))
    .filter((candidate) => candidate.score >= 2)
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, RELATED_ISSUE_LIMIT);
}

export function buildInvalidIssueComment() {
  return `${INVALID_COMMENT_MARKER}
Thanks for opening this issue. This looks like a test or placeholder issue rather than an actionable report, so I am going to close it.

If this was opened by mistake and there is a real Qwen Code problem behind it, please open a new issue with the expected behavior, actual behavior, reproduction steps, and \`/about\` output.`;
}

export function buildNeedsInfoComment(missingInformation) {
  const missingList = missingInformation.map((item) => `- ${item}`).join('\n');

  return `${NEEDS_INFO_COMMENT_MARKER}
Thanks for the report. I could not find enough detail to route or investigate this confidently yet.

Could you add the following information?

${missingList}

Once this is available, maintainers can triage the issue more accurately.`;
}

export function buildRelatedIssueComment(relatedIssues) {
  const relatedList = relatedIssues
    .map(
      (issue) =>
        `- #${issue.number}: ${issue.title} (${issue.state || 'unknown'})`,
    )
    .join('\n');

  return `${RELATED_COMMENT_MARKER}
I found a few potentially related issues that may help with triage:

${relatedList}

These are not marked as duplicates automatically; they are linked here so the discussion can be compared before maintainers decide the next step.`;
}

function findBotComment(comments, marker, fallbackPredicate) {
  return comments.find((comment) => {
    if (comment.user?.type !== 'Bot') {
      return false;
    }
    if (comment.body?.includes(marker)) {
      return true;
    }
    return fallbackPredicate?.(comment) || false;
  });
}

function queueComment(result, comments, marker, body, fallbackPredicate) {
  const existing = findBotComment(comments, marker, fallbackPredicate);

  if (existing?.body?.includes(marker)) {
    result.commentsToUpdate.push({
      id: existing.id,
      body,
    });
    return;
  }

  if (existing) {
    return;
  }

  result.commentsToCreate.push({ body });
}

export function analyzeIssue({
  issue,
  labelNames = [],
  relatedIssues = [],
  comments = [],
}) {
  const result = {
    labelsToAdd: [],
    commentsToCreate: [],
    commentsToUpdate: [],
    closeIssue: false,
    closeReason: undefined,
  };

  if (issue.pull_request || issue.state === 'closed') {
    return result;
  }

  if (isClearlyInvalidIssue(issue)) {
    result.closeIssue = true;
    result.closeReason = 'not_planned';
    queueComment(
      result,
      comments,
      INVALID_COMMENT_MARKER,
      buildInvalidIssueComment(),
    );
    return result;
  }

  const availableLabels = new Set(labelNames);
  result.labelsToAdd = inferLabels(issue, availableLabels);

  const missingInformation = missingInformationForIssue(issue);
  if (missingInformation.length > 0) {
    queueComment(
      result,
      comments,
      NEEDS_INFO_COMMENT_MARKER,
      buildNeedsInfoComment(missingInformation),
      (comment) => comment.body?.includes('Missing Required Information'),
    );
  }

  const strongRelatedIssues = selectRelatedIssues(issue, relatedIssues);
  if (strongRelatedIssues.length > 0) {
    queueComment(
      result,
      comments,
      RELATED_COMMENT_MARKER,
      buildRelatedIssueComment(strongRelatedIssues),
    );
  }

  return result;
}

function parseArgs(argv) {
  const args = {
    mode: process.env.RUN_MODE || 'single',
    issueNumber: process.env.ISSUE_NUMBER || '',
    dryRun: process.env.DRY_RUN === 'true',
    limit: Number(process.env.SCHEDULED_LIMIT || DEFAULT_SCHEDULED_LIMIT),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      args.mode = argv[index + 1];
      index += 1;
    } else if (arg === '--issue') {
      args.issueNumber = argv[index + 1];
      index += 1;
    } else if (arg === '--limit') {
      args.limit = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }

  return args;
}

function splitRepository(repository) {
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo.');
  }
  return { owner, repo };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function shouldRetryGitHubRequest(error) {
  if ([429, 500, 502, 503, 504].includes(error?.status)) {
    return true;
  }

  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(
    error?.cause?.code || error?.code,
  );
}

async function githubRequest(path, options = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');
  }

  for (let attempt = 1; attempt <= MAX_GITHUB_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${GITHUB_API_BASE}${path}`, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });

      if (response.status === 204) {
        return undefined;
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : undefined;

      if (!response.ok) {
        const message = data?.message || response.statusText;
        const error = new Error(`GitHub API ${response.status}: ${message}`);
        error.status = response.status;
        throw error;
      }

      return data;
    } catch (error) {
      if (
        attempt < MAX_GITHUB_REQUEST_ATTEMPTS &&
        shouldRetryGitHubRequest(error)
      ) {
        await sleep(attempt * 1000);
        continue;
      }
      throw error;
    }
  }
}

async function listRepoLabels(owner, repo) {
  const labels = [];
  let page = 1;

  while (page <= 3) {
    const batch = await githubRequest(
      `/repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
    );
    labels.push(...batch.map((label) => label.name));
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return labels;
}

async function getIssue(owner, repo, issueNumber) {
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
}

async function listComments(owner, repo, issueNumber) {
  return githubRequest(
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
  );
}

function dateDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function searchIssues(owner, repo, query, limit) {
  const data = await githubRequest(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}`,
  );

  return data.items.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    labels: normalizeLabels(issue.labels),
    state: issue.state,
    url: issue.html_url,
    pull_request: issue.pull_request,
  }));
}

async function findScheduledIssues(owner, repo, limit) {
  const queries = [
    `repo:${owner}/${repo} is:issue is:open no:label`,
    `repo:${owner}/${repo} is:issue is:open label:"status/needs-triage"`,
    `repo:${owner}/${repo} is:issue is:open label:"status/need-information" updated:>=${dateDaysAgo(14)}`,
  ];
  const issuesByNumber = new Map();

  for (const query of queries) {
    const issues = await searchIssues(owner, repo, query, limit);
    for (const issue of issues) {
      if (!issue.pull_request) {
        issuesByNumber.set(issue.number, issue);
      }
      if (issuesByNumber.size >= limit) {
        return [...issuesByNumber.values()];
      }
    }
  }

  return [...issuesByNumber.values()];
}

function relatedSearchTerms(issue) {
  const titleTokens = tokenize(issue.title || '');
  const bodyTokens = tokenize(issue.body || '');
  const terms = [];

  for (const token of [...titleTokens, ...bodyTokens]) {
    if (!terms.includes(token)) {
      terms.push(token);
    }
    if (terms.length >= 5) {
      break;
    }
  }

  return terms;
}

async function findRelatedIssues(owner, repo, issue) {
  const terms = relatedSearchTerms(issue);
  if (terms.length < 2) {
    return [];
  }

  const query = `repo:${owner}/${repo} is:issue ${terms.join(' ')}`;
  const candidates = await searchIssues(owner, repo, query, 10);
  return selectRelatedIssues(issue, candidates);
}

async function applyAnalysis(owner, repo, issue, analysis, dryRun) {
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          issue: issue.number,
          dryRun: true,
          ...analysis,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (analysis.labelsToAdd.length > 0) {
    await githubRequest(
      `/repos/${owner}/${repo}/issues/${issue.number}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({ labels: analysis.labelsToAdd }),
      },
    );
  }

  for (const comment of analysis.commentsToUpdate) {
    await githubRequest(
      `/repos/${owner}/${repo}/issues/comments/${comment.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ body: comment.body }),
      },
    );
  }

  for (const comment of analysis.commentsToCreate) {
    await githubRequest(
      `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: comment.body }),
      },
    );
  }

  if (analysis.closeIssue) {
    await githubRequest(`/repos/${owner}/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'closed',
        state_reason: analysis.closeReason || 'not_planned',
      }),
    });
  }

  console.log(
    `Processed issue #${issue.number}: ${analysis.labelsToAdd.length} labels, ${analysis.commentsToCreate.length} new comments, ${analysis.commentsToUpdate.length} updated comments, close=${analysis.closeIssue}`,
  );
}

async function processIssue(owner, repo, issueNumber, labelNames, dryRun) {
  const issue = await getIssue(owner, repo, issueNumber);
  if (issue.pull_request) {
    console.log(`Skipping #${issueNumber}: pull request.`);
    return;
  }

  const comments = await listComments(owner, repo, issueNumber);
  const relatedIssues = await findRelatedIssues(owner, repo, issue);
  const analysis = analyzeIssue({
    issue,
    labelNames,
    relatedIssues,
    comments,
  });

  await applyAnalysis(owner, repo, issue, analysis, dryRun);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { owner, repo } = splitRepository(process.env.GITHUB_REPOSITORY);
  const labelNames = await listRepoLabels(owner, repo);

  if (args.mode === 'scheduled') {
    const issues = await findScheduledIssues(owner, repo, args.limit);
    console.log(`Found ${issues.length} candidate issues.`);
    for (const issue of issues) {
      await processIssue(owner, repo, issue.number, labelNames, args.dryRun);
    }
    return;
  }

  if (!args.issueNumber) {
    throw new Error('--issue or ISSUE_NUMBER is required in single mode.');
  }

  await processIssue(owner, repo, args.issueNumber, labelNames, args.dryRun);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
