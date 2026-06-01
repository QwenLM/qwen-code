/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(
  repoRoot,
  '.aoneci',
  'scripts',
  'send-dingtalk-alert.js',
);
const mergeWorkflowPath = path.join(
  repoRoot,
  '.aoneci',
  'upstream-sync-merge.yml',
);

describe('send-dingtalk-alert.js', () => {
  it('skips successfully when the webhook is not configured', () => {
    const output = execFileSync(
      'node',
      [
        scriptPath,
        '--title',
        'Upstream Sync failed',
        '--content',
        'merge conflict',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
        },
      },
    );

    expect(output).toContain('DingTalk webhook is not configured');
  }, 10000);

  it('builds a signed markdown payload in dry-run mode', () => {
    const timestamp = '1700000000000';
    const secret = 'test-secret';
    const expectedSign = encodeURIComponent(
      crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`)
        .digest('base64'),
    );

    const output = execFileSync(
      'node',
      [
        scriptPath,
        '--title',
        'Upstream Sync failed',
        '--content',
        'merge conflict in packages/core/src/foo.ts',
        '--url',
        'https://code.alibaba-inc.com/alishu/qwen-code/codereview/1',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          CI_DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send',
          CI_DINGTALK_WEBHOOK_SECRET: secret,
          DINGTALK_TIMESTAMP: timestamp,
        },
      },
    );

    const result = JSON.parse(output);
    expect(result.url).toBe(
      `https://oapi.dingtalk.com/robot/send?timestamp=${timestamp}&sign=${expectedSign}`,
    );
    expect(result.payload).toMatchObject({
      msgtype: 'markdown',
      markdown: {
        title: 'Upstream Sync failed',
      },
    });
    expect(result.payload.markdown.text).toContain(
      'merge conflict in packages/core/src/foo.ts',
    );
    expect(result.payload.markdown.text).toContain(
      'https://code.alibaba-inc.com/alishu/qwen-code/codereview/1',
    );
  }, 10000);

  it('is called by the upstream sync workflow for conflict and verification alerts', () => {
    const workflow = fs.readFileSync(mergeWorkflowPath, 'utf8');

    expect(workflow).toContain('send-dingtalk-alert.js');
    expect(workflow).toContain(
      'cp .aoneci/scripts/send-dingtalk-alert.js "$DINGTALK_SCRIPT_FILE"',
    );
    expect(workflow).toContain('node "$DINGTALK_SCRIPT_FILE"');
    expect(workflow).not.toContain(
      'node .aoneci/scripts/send-dingtalk-alert.js',
    );
    expect(workflow).toContain('Upstream Sync 需要人工处理');
    expect(workflow).toContain('Upstream Sync 验证失败');
  });

  it('keeps upstream sync phases visible and fails the job for actionable states', () => {
    const workflow = fs.readFileSync(mergeWorkflowPath, 'utf8');

    expect(workflow).toContain("name: '准备 sync 分支'");
    expect(workflow).toContain("name: '合并 upstream 并检测冲突'");
    expect(workflow).toContain("name: '提交 clean sync 结果'");
    expect(workflow).toContain("name: '上游同步状态门禁'");
    expect(workflow).toContain('VERIFY_STATUS_FILE="$STATE_DIR/verify-status"');
    expect(workflow).toContain('echo "failed" > "$VERIFY_STATUS_FILE"');
    expect(workflow).toContain('CONFLICT_SUMMARY="存在冲突待人工处理"');
    expect(workflow).toContain('MR_CONFLICT_FILES_OUTPUT_PATH');
    expect(workflow).toContain(
      'if [ "$EXISTING_CONFLICT_COUNT" -eq 0 ] && [ -s "$MR_CONFLICT_FILES_FILE" ]; then',
    );
    expect(workflow).toContain(
      '从已有 MR 读取到 $EXISTING_CONFLICT_COUNT 个冲突文件',
    );
    expect(workflow).toContain('DINGTALK_CONTENT="$SUMMARY"');
    expect(workflow).toContain('冲突文件:');
    expect(workflow).toContain('if [ "$SYNC_STATUS" = "has_conflicts" ]; then');
    expect(workflow).toContain('if [ "$VERIFY_STATUS" = "failed" ]; then');
    expect(workflow).not.toContain('验证失败（不阻塞 MR）');
  }, 10000);
});
