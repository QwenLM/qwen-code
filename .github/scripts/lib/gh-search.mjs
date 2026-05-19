import { run } from './cli.mjs';
import {
  buildHistoryQueries,
  classifyHistoryResults,
} from './history-core.mjs';
import { extractKeywords } from './pr-shape-core.mjs';

async function ghJson(args) {
  const stdout = await run('gh', args);
  return JSON.parse(stdout || '[]');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripRepoQualifier(query, repo) {
  if (!repo) {
    return query;
  }
  return query
    .replace(new RegExp(`\\s+repo:${escapeRegExp(repo)}(?=\\s|$)`, 'g'), '')
    .trim();
}

async function searchIssues({ query, repo, state = 'closed', limit = 20 }) {
  return ghJson([
    'search',
    'issues',
    stripRepoQualifier(query, repo),
    '--repo',
    repo,
    '--state',
    state,
    '--limit',
    String(limit),
    '--json',
    'number,title,url,state,closedAt,labels',
  ]);
}

export function buildSearchPrsArgs({
  query,
  repo,
  state,
  merged = false,
  limit = 20,
}) {
  const args = [
    'search',
    'prs',
    stripRepoQualifier(query, repo),
    '--repo',
    repo,
  ];

  if (merged) {
    args.push('--merged');
  } else if (state) {
    args.push('--state', state);
  }

  args.push(
    '--limit',
    String(limit),
    '--json',
    'number,title,url,state,closedAt,labels',
  );

  return args;
}

async function searchPrs({ query, repo, state, merged = false, limit = 20 }) {
  return ghJson(buildSearchPrsArgs({ query, repo, state, merged, limit }));
}

function uniquePulls(pulls = []) {
  const seen = new Set();
  const unique = [];
  for (const pull of pulls) {
    if (seen.has(pull.number)) {
      continue;
    }
    seen.add(pull.number);
    unique.push(pull);
  }
  return unique;
}

async function issueComments({ repo, number }) {
  try {
    return ghJson([
      'api',
      `repos/${repo}/issues/${number}/comments`,
      '--paginate',
      '--jq',
      '[.[] | {body: .body, url: .html_url, createdAt: .created_at}]',
    ]);
  } catch {
    return [];
  }
}

async function withIssueComments({ repo, pulls, limit }) {
  return Promise.all(
    pulls.slice(0, limit).map(async (pull) => ({
      ...pull,
      comments: await issueComments({ repo, number: pull.number }),
    })),
  );
}

export async function scanHistory({ repo, pr, shape, limit = 20 }) {
  const keywords = extractKeywords({
    title: pr.title,
    body: pr.body,
    files: shape.changed_files,
  });
  const queries = buildHistoryQueries({ keywords, repo });
  const byDesignBlockingQueries = queries.byDesignBlockingCandidates ?? [
    queries.byDesign,
  ];
  const byDesignAdvisoryQueries = queries.byDesignAdvisoryCandidates ?? [];

  const [
    closedIssues,
    mergedPrs,
    byDesignClosedPrsByQuery,
    directionCandidatePrsByQuery,
    badSignals,
  ] = await Promise.all([
    searchIssues({ query: queries.closedIssues, repo, limit }).catch(() => []),
    searchPrs({
      query: queries.mergedPrs,
      repo,
      merged: true,
      limit,
    }).catch(() => []),
    Promise.all(
      byDesignBlockingQueries.map((query) =>
        searchPrs({
          query,
          repo,
          state: 'closed',
          limit,
        }).catch(() => []),
      ),
    ),
    Promise.all(
      byDesignAdvisoryQueries.map((query) =>
        searchPrs({
          query,
          repo,
          state: 'closed',
          limit,
        }).catch(() => []),
      ),
    ),
    searchPrs({
      query: queries.regression,
      repo,
      merged: true,
      limit: Math.min(limit, 10),
    }).catch(() => []),
  ]);

  const byDesignClosedPrs = uniquePulls(byDesignClosedPrsByQuery.flat());
  const directionCandidatePrs = uniquePulls(
    directionCandidatePrsByQuery.flat(),
  ).filter(
    (pull) =>
      !byDesignClosedPrs.some(
        (blockingPull) => blockingPull.number === pull.number,
      ),
  );
  const byDesignWithComments = await withIssueComments({
    repo,
    pulls: byDesignClosedPrs,
    limit: 10,
  });
  const directionCandidatesWithComments = await withIssueComments({
    repo,
    pulls: directionCandidatePrs,
    limit: 10,
  });

  return {
    keywords,
    queries,
    ...classifyHistoryResults({
      prBody: pr.body,
      closedIssues,
      mergedPrs,
      byDesignClosedPrs: byDesignWithComments,
      directionCandidatePrs: directionCandidatesWithComments,
      badSignals,
    }),
    raw: {
      closedIssues,
      mergedPrs,
      byDesignClosedPrs: uniquePulls([
        ...byDesignWithComments,
        ...directionCandidatesWithComments,
      ]),
      directionCandidatePrs: directionCandidatesWithComments,
      badSignals,
    },
  };
}
