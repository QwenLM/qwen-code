#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(process.env.GITHUB_EVENT_JSON || '{}');

// Fail-safe default: an event that carries no review request (a routine
// comment, /triage, /resolve, or a closed PR) is written as untrusted so the
// downstream lanes select the isolated hosted path rather than reading empty
// outputs as trusted. The review-pr job only proceeds on the explicit review
// triggers, so these rows are never consumed — but they must never be read
// as trusted either (R1-9).
const failSafe = (reason) => {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `untrusted=true\npr_number=\nhead_sha=\n`,
  );
  console.log(`review-pr-trust: no review requested (${reason}); untrusted.`);
  process.exit(0);
};
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
  failSafe('no PR number in this event');
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
if (
  String(pr.state).toLowerCase() !== 'open' ||
  !/^[a-f0-9]{40}$/.test(pr.head?.sha || '')
) {
  failSafe('PR is closed or has an invalid head');
}
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `untrusted=${untrusted}\npr_number=${pr.number}\nhead_sha=${pr.head.sha}\n`,
);
