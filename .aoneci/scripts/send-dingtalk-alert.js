#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const crypto = require('node:crypto');

function parseArgs(argv) {
  const args = {
    title: '',
    content: '',
    url: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--title':
        args.title = argv[++i] ?? '';
        break;
      case '--content':
        args.content = argv[++i] ?? '';
        break;
      case '--url':
        args.url = argv[++i] ?? '';
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function buildSignedUrl(webhook, secret) {
  const url = new URL(webhook);
  if (!secret) {
    return url.toString();
  }

  const timestamp = process.env.DINGTALK_TIMESTAMP || Date.now().toString();
  const sign = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');

  // sign is raw base64 here; URLSearchParams.set() handles percent-encoding
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  return url.toString();
}

function buildPayload({ title, content, url }) {
  const text = [`### ${title}`, '', content, url ? `\n[查看详情](${url})` : '']
    .filter(Boolean)
    .join('\n');

  return {
    msgtype: 'markdown',
    markdown: {
      title,
      text,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const webhook = process.env.CI_DINGTALK_WEBHOOK_URL || '';
  const secret = process.env.CI_DINGTALK_WEBHOOK_SECRET || '';

  if (!args.title || !args.content) {
    throw new Error('--title and --content are required');
  }

  if (!webhook) {
    console.log('DingTalk webhook is not configured; skipping notification.');
    process.exit(0);
  }

  const targetUrl = buildSignedUrl(webhook, secret);
  const payload = buildPayload(args);

  if (args.dryRun) {
    console.log(JSON.stringify({ url: targetUrl, payload }));
    process.exit(0);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DingTalk notification failed: ${response.status} ${body}`);
  }

  console.log('DingTalk notification sent.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
