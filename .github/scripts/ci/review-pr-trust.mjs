#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(process.env.GITHUB_EVENT_JSON || '{}');
const prNumber =
  event.pull_request?.number ||
  (event.issue?.number &&
    event.issue?.pull_request &&
    /^\s*@qwen-code \/review(?:[ \r\n]|$)/.test(event.comment?.body || '') &&
    event.issue.number) ||
  (/^[1-9][0-9]*$/.test(event.inputs?.pr_number || '')
    ? Number(event.inputs.pr_number)
    : undefined);
if (!repository || !Number.isInteger(prNumber) || prNumber <= 0) {
  throw new Error('review-pr-trust: cannot resolve the pull request');
}
const pr =
  event.pull_request ||
  JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/pulls/${prNumber}`], {
      encoding: 'utf8',
    }),
  );
const untrusted =
  pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase();
if (pr.state !== 'OPEN' || !/^[a-f0-9]{40}$/.test(pr.head?.sha || '')) {
  throw new Error('review-pr-trust: PR is closed or has an invalid head');
}
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `untrusted=${untrusted}\npr_number=${pr.number}\nhead_sha=${pr.head.sha}\n`,
);
