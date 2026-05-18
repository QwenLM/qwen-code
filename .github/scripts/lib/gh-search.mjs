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

async function searchIssues({ query, repo, state = 'closed', limit = 20 }) {
  return ghJson([
    'search',
    'issues',
    query,
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
  const args = ['search', 'prs', query, '--repo', repo];

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

export async function scanHistory({ repo, pr, shape, limit = 20 }) {
  const keywords = extractKeywords({
    title: pr.title,
    body: pr.body,
    files: shape.changed_files,
  });
  const queries = buildHistoryQueries({ keywords, repo });

  const [closedIssues, mergedPrs, byDesignClosedPrs, badSignals] =
    await Promise.all([
      searchIssues({ query: queries.closedIssues, repo, limit }).catch(
        () => [],
      ),
      searchPrs({
        query: queries.mergedPrs,
        repo,
        merged: true,
        limit,
      }).catch(() => []),
      searchPrs({
        query: queries.byDesign,
        repo,
        state: 'closed',
        limit,
      }).catch(() => []),
      searchPrs({
        query: queries.regression,
        repo,
        merged: true,
        limit: Math.min(limit, 10),
      }).catch(() => []),
    ]);

  const byDesignWithComments = await Promise.all(
    byDesignClosedPrs.slice(0, 10).map(async (pull) => ({
      ...pull,
      comments: await issueComments({ repo, number: pull.number }),
    })),
  );

  return {
    keywords,
    queries,
    ...classifyHistoryResults({
      prBody: pr.body,
      closedIssues,
      mergedPrs,
      byDesignClosedPrs: byDesignWithComments,
      badSignals,
    }),
    raw: {
      closedIssues,
      mergedPrs,
      byDesignClosedPrs: byDesignWithComments,
      badSignals,
    },
  };
}
