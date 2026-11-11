/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `extra`（SDK 盖在 user 消息上的元数据，含 started_at_ms / submitted_at_ms）
 * 在 thread-manager 链路上的透传守卫。
 *
 * ## 背景
 * 进程内会话此前漏了这条透传：SDK 盖的提交时间戳在 daemon 链路上到不了引擎，
 * 统计里 `userMessageTiming.extra` 恒为空。这里用源码级守卫钉住三处转发。
 *
 * 含 isSynthetic 护栏：合成消息不带宿主的提交时间，否则一轮 kickoff 会被记成宿主提交。
 *
 * ## 为什么是源码级守卫而不是运行时断言
 * 运行时断言要走到 core `query()` 才看得到 `extra`，而 `query()` 只在
 * `executeUserInput` 返回 `shouldQuery:true` 时才被调用；让真的 executeUserInput
 * 返回 true 需要装配 slash 处理器 / attachment 上下文等一整条链，与「钉三行透传」
 * 不成比例（mock 掉 executeUserInput 又等于把被测链路换成替身，断言就自证了）。
 * queryProjectionParity 套件已经用 mock query 覆盖了参数面的其它字段，这里补它够
 * 不着的两环：threadSession → submitMessage、sessionQueryRunner → query()。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const FORWARDING_LINE = 'extra: msg.isSynthetic ? undefined : msg.extra';

function readSource(relativeFromHere: string): string {
  return fs.readFileSync(path.join(__dirname, relativeFromHere), 'utf8');
}

describe('extra 透传：thread-manager 侧保留 isSynthetic 护栏', () => {
  it('threadSession.runTurn 带同一行转发 msg.extra', () => {
    expect(readSource('../threadSession.ts')).toContain(FORWARDING_LINE);
  });

  it('sessionQueryRunner 把 options.extra 交给 core query()', () => {
    expect(readSource('./sessionQueryRunner.ts')).toContain(
      'extra: options?.extra',
    );
  });

  it('SessionSubmitOptions 声明了 extra，删字段会让上面两条失去类型支撑', () => {
    expect(readSource('./sessionQueryRunner.ts')).toContain(
      'extra?: Record<string, unknown>;',
    );
  });
});

describe('SDK 附加请求头透传：thread-manager 侧保留 isSynthetic 护栏', () => {
  it('threadSession.runTurn 带同一行转发 msg.extra_headers', () => {
    expect(readSource('../threadSession.ts')).toContain(
      'extraHeaders: msg.isSynthetic ? undefined : msg.extra_headers',
    );
  });

  it('sessionQueryRunner 把 options.extraHeaders 交给 core query()', () => {
    expect(readSource('./sessionQueryRunner.ts')).toContain(
      'extraHeaders: options?.extraHeaders',
    );
  });

  it('SessionQueryRunOptions 声明了 extraHeaders，删字段会让上面两条失去类型支撑', () => {
    expect(readSource('./sessionQueryRunner.ts')).toContain(
      'extraHeaders?: Record<string, string>;',
    );
  });
});

describe('fork 的 sourceSessionId 逐轮透传：worker 与 thread-manager 同形', () => {
  it('threadSession.runTurn 对 fork 会话带 sourceSessionId（受 forked 守卫）', () => {
    const source = readSource('../threadSession.ts');
    expect(source).toContain(
      'this.params.forked && this.resumeSnapshot?.sourceSessionId',
    );
    expect(source).toContain(
      'sourceSessionId: this.resumeSnapshot.sourceSessionId',
    );
  });
});

describe('MCP 资源注入：worker 与 thread-manager 同形', () => {
  it('buildAttachmentExternalContext 提供 mcpResources（@server:uri 的宿主入口）', () => {
    // worker 同位：headlessSession.ts:2487 mcpResources: createMcpResourceAttachmentSource(config)。
    // 守卫形式与 extra 透传同因：真正断言展开结果要装配整条 attachment 链，与「钉一行注入」不成比例。
    expect(readSource('../threadSession.ts')).toContain(
      'mcpResources: createMcpResourceAttachmentSource(config)',
    );
  });
});
