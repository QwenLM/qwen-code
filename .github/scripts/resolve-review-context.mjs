#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

import { resolveReviewContext } from './lib/review-context-core.mjs';

function writeOutputValue(key, value) {
  const stringValue = String(value);
  if (stringValue.includes('\n')) {
    // Some of these values are comment-controlled (review_prompt embeds
    // maintainer focus text, override_reason copies the comment). A
    // Date.now()-derived delimiter is predictable: a commenter could
    // emit the delimiter line followed by forged `key=value` output
    // assignments (e.g. bypass_design_gate=true). A cryptographically
    // random delimiter cannot be predicted, and we additionally reject
    // the (astronomically unlikely) case where the value contains it.
    let delimiter;
    do {
      delimiter = `QWEN_REVIEW_CONTEXT_${randomUUID()}`;
    } while (stringValue.includes(delimiter));
    return `${key}<<${delimiter}\n${stringValue}\n${delimiter}\n`;
  }
  return `${key}=${stringValue}\n`;
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const context = resolveReviewContext({
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    inputs: {
      pr_number: process.env.WORKFLOW_PR_NUMBER,
      review_mode: process.env.WORKFLOW_REVIEW_MODE,
      additional_instructions: process.env.WORKFLOW_ADDITIONAL_INSTRUCTIONS,
    },
    repository: process.env.GITHUB_REPOSITORY,
    serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
  });

  if (process.env.GITHUB_OUTPUT) {
    const chunks = [];
    for (const [key, value] of Object.entries(context)) {
      chunks.push(writeOutputValue(key, value));
    }
    await appendFile(process.env.GITHUB_OUTPUT, chunks.join(''));
  } else {
    console.log(JSON.stringify(context, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
