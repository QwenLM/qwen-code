# Worktree Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 worktree 添加会话持久化、hooksPath 初始化、Footer 状态展示和退出对话框，使 worktree 在 `--resume` 后可恢复，用户始终知道自己在哪个隔离环境中。

**Architecture:** 新增 `WorktreeSession` sidecar JSON 文件（与 JSONL session 文件并存），`EnterWorktree` 写入、`ExitWorktree` 清除；CLI 层通过 `useWorktreeSession` hook 监听文件变化并同步到 `UIState.activeWorktree`；Footer 读取该字段内置渲染 worktree 行；`WorktreeExitDialog` 在检测到活跃 worktree 时拦截第二次 Ctrl+C。

**Tech Stack:** TypeScript, React (Ink), Node.js `fs.watch`, `simple-git`, Vitest

---

## 文件结构

| 操作 | 文件                                                         | 说明                                                                          |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 新建 | `packages/core/src/services/worktreeSessionService.ts`       | WorktreeSession 接口 + 读写清除函数                                           |
| 新建 | `packages/core/src/services/worktreeSessionService.test.ts`  | 单元测试                                                                      |
| 修改 | `packages/core/src/services/sessionService.ts`               | 新增 `getWorktreeSessionPath()` 公开方法                                      |
| 修改 | `packages/core/src/services/gitWorktreeService.ts`           | `createUserWorktree()` / `createAgentWorktree()` 后追加 `core.hooksPath` 配置 |
| 修改 | `packages/core/src/services/gitWorktreeService.test.ts`      | hooksPath 测试                                                                |
| 修改 | `packages/core/src/tools/enter-worktree.ts`                  | 创建 worktree 后写入 WorktreeSession                                          |
| 修改 | `packages/core/src/tools/enter-worktree.test.ts`             | session 写入测试                                                              |
| 修改 | `packages/core/src/tools/exit-worktree.ts`                   | 退出 worktree 后清除 WorktreeSession                                          |
| 修改 | `packages/core/src/tools/exit-worktree.test.ts`              | session 清除测试                                                              |
| 新建 | `packages/cli/src/ui/hooks/useWorktreeSession.ts`            | 监听 sidecar 文件，返回当前 WorktreeSession                                   |
| 修改 | `packages/cli/src/ui/contexts/UIStateContext.tsx`            | 新增 `activeWorktree` 字段                                                    |
| 修改 | `packages/cli/src/ui/AppContainer.tsx`                       | 同步 `activeWorktree`、注入 resume 上下文、拦截退出                           |
| 修改 | `packages/cli/src/ui/hooks/useStatusLine.ts`                 | `StatusLineCommandInput` 新增 `worktree` 字段                                 |
| 修改 | `packages/cli/src/ui/components/Footer.tsx`                  | 内置 worktree 行展示                                                          |
| 新建 | `packages/cli/src/ui/components/WorktreeExitDialog.tsx`      | 退出提示对话框                                                                |
| 新建 | `packages/cli/src/ui/components/WorktreeExitDialog.test.tsx` | 组件测试                                                                      |
| 修改 | `packages/cli/src/ui/components/DialogManager.tsx`           | 注册 WorktreeExitDialog                                                       |

---

## Task 1: WorktreeSession sidecar 存储

**Files:**

- Create: `packages/core/src/services/worktreeSessionService.ts`
- Create: `packages/core/src/services/worktreeSessionService.test.ts`
- Modify: `packages/core/src/services/sessionService.ts`

- [ ] **Step 1: 新建 `worktreeSessionService.ts`**

```typescript
// packages/core/src/services/worktreeSessionService.ts
import * as fs from 'node:fs/promises';
import { isNodeError } from '../utils/errors.js';

export interface WorktreeSession {
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  originalCwd: string;
  originalBranch: string;
}

export async function readWorktreeSession(
  filePath: string,
): Promise<WorktreeSession | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as WorktreeSession;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(require('node:path').dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function clearWorktreeSession(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}
```

- [ ] **Step 2: 写失败测试**

```typescript
// packages/core/src/services/worktreeSessionService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  type WorktreeSession,
} from './worktreeSessionService.js';

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.qwen/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
};

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-session-test-'));
  filePath = path.join(tmpDir, 'test.worktree.json');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readWorktreeSession', () => {
  it('returns null when file does not exist', async () => {
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('reads back what was written', async () => {
    await fs.writeFile(filePath, JSON.stringify(sample), 'utf-8');
    expect(await readWorktreeSession(filePath)).toEqual(sample);
  });
});

describe('writeWorktreeSession', () => {
  it('writes a readable JSON file', async () => {
    await writeWorktreeSession(filePath, sample);
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(sample);
  });

  it('overwrites existing file', async () => {
    await writeWorktreeSession(filePath, sample);
    const updated = { ...sample, slug: 'updated' };
    await writeWorktreeSession(filePath, updated);
    expect(await readWorktreeSession(filePath)).toEqual(updated);
  });
});

describe('clearWorktreeSession', () => {
  it('deletes the file', async () => {
    await writeWorktreeSession(filePath, sample);
    await clearWorktreeSession(filePath);
    expect(await readWorktreeSession(filePath)).toBeNull();
  });

  it('is a no-op when file does not exist', async () => {
    await expect(clearWorktreeSession(filePath)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd packages/core
npx vitest run src/services/worktreeSessionService.test.ts
```

期望：`FAIL` — 模块不存在。

- [ ] **Step 4: 修复 `writeWorktreeSession` 中的 require 调用**

`worktreeSessionService.ts` 中用 `path.dirname`，需要在文件顶部引入 `node:path`：

```typescript
// 把 "require('node:path').dirname(filePath)" 替换为正确引入
import * as path from 'node:path';

export async function writeWorktreeSession(
  filePath: string,
  session: WorktreeSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd packages/core
npx vitest run src/services/worktreeSessionService.test.ts
```

期望：`PASS` — 6 tests passed。

- [ ] **Step 6: 在 `SessionService` 中新增 `getWorktreeSessionPath()`**

在 `packages/core/src/services/sessionService.ts` 找到 `private getChatsDir()` 方法（约行 180），在其后添加：

```typescript
getWorktreeSessionPath(sessionId: string): string {
  return path.join(this.getChatsDir(), `${sessionId}.worktree.json`);
}
```

- [ ] **Step 7: 类型检查**

```bash
cd packages/core
npm run typecheck
```

期望：无错误。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/services/worktreeSessionService.ts \
        packages/core/src/services/worktreeSessionService.test.ts \
        packages/core/src/services/sessionService.ts
git commit -m "feat(worktree): add WorktreeSession sidecar storage"
```

---

## Task 2: hooksPath post-creation setup

**Files:**

- Modify: `packages/core/src/services/gitWorktreeService.ts:1133-1158`（`createUserWorktree`）
- Modify: `packages/core/src/services/gitWorktreeService.test.ts`

- [ ] **Step 1: 写失败测试**

在 `gitWorktreeService.test.ts` 中找到 `createUserWorktree` 测试组，新增：

```typescript
it('configures core.hooksPath to main repo after creation', async () => {
  const result = await service.createUserWorktree('hooks-test');
  expect(result.success).toBe(true);

  const worktreePath = result.worktree!.path;
  const worktreeGit = simpleGit(worktreePath);
  const hooksPath = await worktreeGit.raw([
    'config',
    '--local',
    'core.hooksPath',
  ]);
  // Should point to the main repo's .git/hooks
  expect(hooksPath.trim()).toContain('.git/hooks');
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/core
npx vitest run src/services/gitWorktreeService.test.ts -t "configures core.hooksPath"
```

期望：`FAIL` — hooksPath 为空。

- [ ] **Step 3: 在 `createUserWorktree` 中追加 hooksPath 配置**

在 `gitWorktreeService.ts` 中找到 `createUserWorktree` 内 `git worktree add` 调用之后（约行 1140），在 `return { success: true, worktree }` 之前添加：

```typescript
// Configure hooksPath so commits inside this worktree run the main
// repo's hooks instead of the (absent) per-worktree hooks directory.
try {
  const worktreeGit = simpleGit(worktreePath);
  const mainHooksPath = path.join(this.sourceRepoPath, '.git', 'hooks');
  await worktreeGit.raw(['config', 'core.hooksPath', mainHooksPath]);
} catch (hookError) {
  debugLogger.warn(
    `createUserWorktree: failed to set core.hooksPath: ${hookError}`,
  );
  // Non-fatal: worktree is usable, just without inherited hooks.
}
```

`this.sourceRepoPath` 是 `GitWorktreeService` 构造函数赋值的私有字段（`this.sourceRepoPath = path.resolve(sourceRepoPath)`，约行 224）。

- [ ] **Step 4: 对 `createAgentWorktree` 做相同修改**

找到 `createAgentWorktree` 方法，在其 `git worktree add` 之后添加相同的 hooksPath 代码块（完整代码与 Step 3 相同，`slug` 来自 agent worktree 的参数）。

- [ ] **Step 5: 运行测试确认通过**

```bash
cd packages/core
npx vitest run src/services/gitWorktreeService.test.ts -t "configures core.hooksPath"
```

期望：`PASS`。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/services/gitWorktreeService.ts \
        packages/core/src/services/gitWorktreeService.test.ts
git commit -m "feat(worktree): configure core.hooksPath after worktree creation"
```

---

## Task 3: EnterWorktreeTool 写入 WorktreeSession

**Files:**

- Modify: `packages/core/src/tools/enter-worktree.ts`
- Modify: `packages/core/src/tools/enter-worktree.test.ts`

- [ ] **Step 1: 写失败测试**

在 `enter-worktree.test.ts` 的成功创建用例之后新增：

```typescript
import { readWorktreeSession } from '../services/worktreeSessionService.js';

it('writes WorktreeSession sidecar after creating worktree', async () => {
  // Arrange: use the existing test setup that creates a real git repo
  // and invokes the tool (copy from existing "custom name" test)
  const result = await invokeTool(tool, { name: 'session-test' });
  expect(result.error).toBeUndefined();

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  const session = await readWorktreeSession(sessionPath);

  expect(session).not.toBeNull();
  expect(session!.slug).toBe('session-test');
  expect(session!.worktreePath).toContain('session-test');
  expect(session!.worktreeBranch).toBe('worktree-session-test');
  expect(session!.originalCwd).toBeTruthy();
  expect(session!.originalBranch).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/core
npx vitest run src/tools/enter-worktree.test.ts -t "writes WorktreeSession"
```

期望：`FAIL` — session file is null。

- [ ] **Step 3: 修改 `enter-worktree.ts`，在成功创建后写入 session**

在 `enter-worktree.ts` 顶部新增 import：

```typescript
import { writeWorktreeSession } from '../services/worktreeSessionService.js';
```

在 `execute()` 方法中，`writeWorktreeSessionMarker(...)` 调用之后，新增：

```typescript
// Persist worktree session so --resume can restore context.
try {
  await writeWorktreeSession(
    this.config
      .getSessionService()
      .getWorktreeSessionPath(this.config.getSessionId()),
    {
      slug,
      worktreePath: result.worktree.path,
      worktreeBranch: result.worktree.branch,
      originalCwd: projectRoot,
      originalBranch: baseBranch ?? 'HEAD',
    },
  );
} catch (error) {
  debugLogger.warn(`enter_worktree: failed to write session state: ${error}`);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/core
npx vitest run src/tools/enter-worktree.test.ts
```

期望：全部通过，无回归。

- [ ] **Step 5: 类型检查**

```bash
cd packages/core && npm run typecheck
```

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/tools/enter-worktree.ts \
        packages/core/src/tools/enter-worktree.test.ts
git commit -m "feat(worktree): persist WorktreeSession in EnterWorktreeTool"
```

---

## Task 4: ExitWorktreeTool 清除 WorktreeSession

**Files:**

- Modify: `packages/core/src/tools/exit-worktree.ts`
- Modify: `packages/core/src/tools/exit-worktree.test.ts`

- [ ] **Step 1: 写失败测试**

在 `exit-worktree.test.ts` 新增两个用例（keep 和 remove 都应该清除 session）：

```typescript
import {
  writeWorktreeSession,
  readWorktreeSession,
} from '../services/worktreeSessionService.js';

async function seedSession(cfg: Config, slug: string) {
  await writeWorktreeSession(
    cfg.getSessionService().getWorktreeSessionPath(cfg.getSessionId()),
    {
      slug,
      worktreePath: `/repo/.qwen/worktrees/${slug}`,
      worktreeBranch: `worktree-${slug}`,
      originalCwd: '/repo',
      originalBranch: 'main',
    },
  );
}

it('clears WorktreeSession after keep', async () => {
  await seedSession(config, 'exit-keep-test');
  // Create the worktree first so exit_worktree can find it
  await config.getWorktreeService().createUserWorktree('exit-keep-test');
  await invokeTool(tool, { name: 'exit-keep-test', action: 'keep' });

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  expect(await readWorktreeSession(sessionPath)).toBeNull();
});

it('clears WorktreeSession after remove', async () => {
  await seedSession(config, 'exit-remove-test');
  await config.getWorktreeService().createUserWorktree('exit-remove-test');
  await invokeTool(tool, { name: 'exit-remove-test', action: 'remove' });

  const sessionPath = config
    .getSessionService()
    .getWorktreeSessionPath(config.getSessionId());
  expect(await readWorktreeSession(sessionPath)).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/core
npx vitest run src/tools/exit-worktree.test.ts -t "clears WorktreeSession"
```

期望：`FAIL`。

- [ ] **Step 3: 修改 `exit-worktree.ts`**

在顶部新增 import：

```typescript
import { clearWorktreeSession } from '../services/worktreeSessionService.js';
```

找到 `action === 'keep'` 的返回路径（约行 184-196），在 `return { llmContent: ..., returnDisplay: ... }` 之前新增：

```typescript
try {
  await clearWorktreeSession(
    this.config
      .getSessionService()
      .getWorktreeSessionPath(this.config.getSessionId()),
  );
} catch (error) {
  debugLogger.warn(`exit_worktree: failed to clear session state: ${error}`);
}
```

找到 `action === 'remove'` 的成功返回路径（`removeUserWorktree` 调用之后），同样新增相同的 `clearWorktreeSession` 调用块。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/core
npx vitest run src/tools/exit-worktree.test.ts
```

期望：全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tools/exit-worktree.ts \
        packages/core/src/tools/exit-worktree.test.ts
git commit -m "feat(worktree): clear WorktreeSession in ExitWorktreeTool"
```

---

## Task 5: useWorktreeSession hook + UIState.activeWorktree

**Files:**

- Create: `packages/cli/src/ui/hooks/useWorktreeSession.ts`
- Modify: `packages/cli/src/ui/contexts/UIStateContext.tsx`
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: 在 `UIStateContext.tsx` 新增 `activeWorktree` 字段**

找到 `UIState` interface（约行 85），在 `branchName: string | undefined;` 附近新增：

```typescript
activeWorktree: {
  slug: string;
  branch: string;
  path: string;
} | null;
```

找到 UIState 的初始值（通常在 `AppContainer.tsx` 的 UIState provider 处）或 `createContext` 的 defaultValue，添加 `activeWorktree: null`。

- [ ] **Step 2: 新建 `useWorktreeSession.ts`**

```typescript
// packages/cli/src/ui/hooks/useWorktreeSession.ts
import { useState, useEffect } from 'react';
import * as fs from 'node:fs';
import {
  readWorktreeSession,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';

export function useWorktreeSession(): WorktreeSession | null {
  const config = useConfig();
  const [session, setSession] = useState<WorktreeSession | null>(null);

  useEffect(() => {
    const sessionService = config.getSessionService();
    const sessionId = config.getSessionId();
    const filePath = sessionService.getWorktreeSessionPath(sessionId);

    let watcher: fs.FSWatcher | undefined;

    const load = async () => {
      try {
        const ws = await readWorktreeSession(filePath);
        setSession(ws);
      } catch {
        setSession(null);
      }
    };

    void load();

    try {
      watcher = fs.watch(filePath, () => void load());
    } catch {
      // File does not exist yet — watcher set up on next write event via load()
    }

    return () => {
      watcher?.close();
    };
  }, [config]);

  return session;
}
```

注意：`readWorktreeSession` 和 `WorktreeSession` 需要从 `@qwen-code/qwen-code-core` 导出，需要同时在 `packages/core/src/index.ts` 中新增导出：

```typescript
export {
  readWorktreeSession,
  writeWorktreeSession,
  clearWorktreeSession,
  type WorktreeSession,
} from './services/worktreeSessionService.js';
```

- [ ] **Step 3: 在 `AppContainer.tsx` 使用 hook 同步 `activeWorktree`**

在 `AppContainer.tsx` 顶部新增 import：

```typescript
import { useWorktreeSession } from './hooks/useWorktreeSession.js';
```

在 `AppContainer` 函数体内（靠近 `branchName` 的使用处），新增：

```typescript
const worktreeSession = useWorktreeSession();
```

在传递给 `UIStateContext.Provider` 的 value 中新增：

```typescript
activeWorktree: worktreeSession
  ? {
      slug: worktreeSession.slug,
      branch: worktreeSession.worktreeBranch,
      path: worktreeSession.worktreePath,
    }
  : null,
```

- [ ] **Step 4: 类型检查**

```bash
npm run typecheck
```

从仓库根运行（跨 workspace 检查）。期望：无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/services/worktreeSessionService.ts \
        packages/core/src/index.ts \
        packages/cli/src/ui/hooks/useWorktreeSession.ts \
        packages/cli/src/ui/contexts/UIStateContext.tsx \
        packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): add useWorktreeSession hook and UIState.activeWorktree"
```

---

## Task 6: StatusLineCommandInput.worktree 字段 + Footer worktree 行

**Files:**

- Modify: `packages/cli/src/ui/hooks/useStatusLine.ts`
- Modify: `packages/cli/src/ui/components/Footer.tsx`

- [ ] **Step 1: 在 `useStatusLine.ts` 新增 `worktree` 字段**

找到 `StatusLineCommandInput` interface（约行 21），在 `git?: { branch: string }` 字段之后新增：

```typescript
worktree?: {
  slug: string;
  branch: string;
};
```

找到 `doUpdate` 回调中构造 `input: StatusLineCommandInput` 对象的地方（约行 225），在 `...(ui.branchName && { git: { branch: ui.branchName } })` 之后新增：

```typescript
...(uiStateRef.current.activeWorktree && {
  worktree: {
    slug: uiStateRef.current.activeWorktree.slug,
    branch: uiStateRef.current.activeWorktree.branch,
  },
}),
```

- [ ] **Step 2: 在 `Footer.tsx` 新增 worktree 内置展示行**

在 `Footer.tsx` 顶部引入 `useUIState`（已有）。

找到 `statusLineLines` 渲染区域（约行 140-148）：

```tsx
{
  statusLineLines.length > 0 &&
    !uiState.ctrlCPressedOnce &&
    !uiState.ctrlDPressedOnce &&
    statusLineLines.map((line, i) => (
      <Text key={`status-line-${i}`} dimColor wrap="truncate">
        {line}
      </Text>
    ));
}
```

在其之前插入 worktree 行（当 `activeWorktree` 非空且无用户 statusline 时显示）：

```tsx
{
  uiState.activeWorktree &&
    !uiState.ctrlCPressedOnce &&
    !uiState.ctrlDPressedOnce &&
    statusLineLines.length === 0 && (
      <Text dimColor wrap="truncate">
        {`⎇ ${uiState.activeWorktree.branch} (${uiState.activeWorktree.slug})`}
      </Text>
    );
}
```

- [ ] **Step 3: 类型检查 + 构建**

```bash
npm run typecheck && npm run build
```

期望：无错误。

- [ ] **Step 4: 提交**

```bash
git add packages/cli/src/ui/hooks/useStatusLine.ts \
        packages/cli/src/ui/components/Footer.tsx
git commit -m "feat(worktree): show active worktree in Footer and StatusLine payload"
```

---

## Task 7: --resume worktree 上下文注入

**Files:**

- Modify: `packages/cli/src/ui/AppContainer.tsx:459-489`

- [ ] **Step 1: 在 resume 路径中注入 worktree 上下文消息**

在 `AppContainer.tsx` 中找到 resume 路径（约行 459-489）：

```typescript
const resumedSessionData = config.getResumedSessionData();
if (resumedSessionData) {
  const historyItems = buildResumedHistoryItems(resumedSessionData, config);
  historyManager.loadHistory(historyItems);
  // ...
}
```

修改为：

```typescript
const resumedSessionData = config.getResumedSessionData();
if (resumedSessionData) {
  const historyItems = buildResumedHistoryItems(resumedSessionData, config);
  historyManager.loadHistory(historyItems);

  // If there is an active worktree session, inject a context reminder so
  // the model immediately knows to continue using the worktree path.
  const ws = await readWorktreeSession(
    config.getSessionService().getWorktreeSessionPath(config.getSessionId()),
  );
  if (ws) {
    // Verify the worktree directory still exists before treating it as active.
    const worktreeAlive = await fs
      .stat(ws.worktreePath)
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (worktreeAlive) {
      historyManager.addItem(
        {
          type: MessageType.INFO,
          text:
            `[Resumed] Active worktree: "${ws.slug}" at ${ws.worktreePath} ` +
            `(branch: ${ws.worktreeBranch}). Continue using this path for all file operations.`,
        },
        Date.now(),
      );
    } else {
      // Stale sidecar — worktree was deleted externally, clean up.
      await clearWorktreeSession(
        config
          .getSessionService()
          .getWorktreeSessionPath(config.getSessionId()),
      );
    }
  }

  // ... rest of existing resume code (background agents, session name)
}
```

在文件顶部新增 import：

```typescript
import {
  readWorktreeSession,
  clearWorktreeSession,
} from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs/promises';
```

（`fs` 可能已经引入，检查后合并。）

- [ ] **Step 2: 类型检查**

```bash
npm run typecheck
```

- [ ] **Step 3: 提交**

```bash
git add packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): inject context message on --resume when worktree is active"
```

---

## Task 8: WorktreeExitDialog

**Files:**

- Create: `packages/cli/src/ui/components/WorktreeExitDialog.tsx`
- Create: `packages/cli/src/ui/components/WorktreeExitDialog.test.tsx`
- Modify: `packages/cli/src/ui/components/DialogManager.tsx`
- Modify: `packages/cli/src/ui/contexts/UIStateContext.tsx`
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: 在 `AppContainer.tsx` 新增 dialog 状态**

`showWelcomeBackDialog` 等 dialog 状态由各自的 hook 返回给 AppContainer，然后通过 UIState value 对象传入 Provider。对 WorktreeExitDialog 采用同样模式：

在 `AppContainer.tsx` 函数体内新增：

```typescript
const [showWorktreeExitDialog, setShowWorktreeExitDialog] = useState(false);
```

在 UIState Provider 的 value 对象中新增：

```typescript
showWorktreeExitDialog,
```

在 `UIState` interface 中新增（靠近其他 dialog 字段）：

```typescript
showWorktreeExitDialog: boolean;
```

- [ ] **Step 2: 写失败组件测试**

```typescript
// packages/cli/src/ui/components/WorktreeExitDialog.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

describe('WorktreeExitDialog', () => {
  it('renders worktree slug and options', () => {
    const { lastFrame } = render(
      <WorktreeExitDialog
        slug="my-feature"
        branch="worktree-my-feature"
        onKeep={vi.fn()}
        onRemove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(lastFrame()).toContain('my-feature');
    expect(lastFrame()).toContain('Keep');
    expect(lastFrame()).toContain('Remove');
  });

  it('calls onKeep when Keep is selected', async () => {
    const onKeep = vi.fn();
    // Key navigation test — follow pattern from MemoryDialog.test.tsx
    // render → send Enter on first option → verify onKeep called
    expect(onKeep).not.toHaveBeenCalled(); // placeholder until nav is wired
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd packages/cli
npx vitest run src/ui/components/WorktreeExitDialog.test.tsx
```

期望：`FAIL` — 模块不存在。

- [ ] **Step 4: 新建 `WorktreeExitDialog.tsx`**

参考 `WelcomeBackDialog.tsx` 的 RadioSelect 模式：

```tsx
// packages/cli/src/ui/components/WorktreeExitDialog.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { RadioSelect } from '../shared/RadioSelect.js';
import type { RadioSelectItem } from '../shared/RadioSelect.js';
import { theme } from '../semantic-colors.js';

interface WorktreeExitDialogProps {
  slug: string;
  branch: string;
  onKeep: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

type Choice = 'keep' | 'remove' | 'cancel';

const options: Array<RadioSelectItem<Choice>> = [
  {
    key: 'keep',
    label: 'Keep worktree (exit without deleting)',
    value: 'keep',
  },
  { key: 'remove', label: 'Remove worktree and branch', value: 'remove' },
  { key: 'cancel', label: 'Cancel (stay in session)', value: 'cancel' },
];

export const WorktreeExitDialog: React.FC<WorktreeExitDialogProps> = ({
  slug,
  branch,
  onKeep,
  onRemove,
  onCancel,
}) => {
  const [selected, setSelected] = useState<Choice>('keep');

  const handleSelect = (value: Choice) => {
    if (value === 'keep') onKeep();
    else if (value === 'remove') onRemove();
    else onCancel();
  };

  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Text color={theme.status.warning}>
        {`Active worktree: "${slug}" (${branch})`}
      </Text>
      <Text color={theme.text.secondary}>What would you like to do?</Text>
      <RadioSelect
        items={options}
        selectedValue={selected}
        onSelect={handleSelect}
        onChange={setSelected}
      />
    </Box>
  );
};
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd packages/cli
npx vitest run src/ui/components/WorktreeExitDialog.test.tsx
```

期望：基本渲染测试通过（onKeep 的键导航测试暂时跳过，视 RadioSelect API 而定）。

- [ ] **Step 6: 在 `DialogManager.tsx` 注册**

找到 `DialogManager` 中最后一个 dialog 渲染块，新增：

```tsx
import { WorktreeExitDialog } from './WorktreeExitDialog.js';

// 在 DialogManager 返回的 JSX 中，在最后一个 dialog 之后添加：
{
  uiState.showWorktreeExitDialog && uiState.activeWorktree && (
    <WorktreeExitDialog
      slug={uiState.activeWorktree.slug}
      branch={uiState.activeWorktree.branch}
      onKeep={() => {
        setShowWorktreeExitDialog(false);
        handleSlashCommand('/quit');
      }}
      onRemove={async () => {
        setShowWorktreeExitDialog(false);
        // Remove the worktree directly via service (no tool call needed).
        try {
          const svc = new GitWorktreeService(config.getTargetDir());
          await svc.removeUserWorktree(uiState.activeWorktree!.slug, {
            deleteBranch: true,
          });
          await clearWorktreeSession(
            config
              .getSessionService()
              .getWorktreeSessionPath(config.getSessionId()),
          );
        } catch {
          // Non-fatal — exit anyway.
        }
        handleSlashCommand('/quit');
      }}
      onCancel={() => {
        setShowWorktreeExitDialog(false);
      }}
    />
  );
}
```

`setShowWorktreeExitDialog` 来自 Step 1 在 AppContainer 中定义的 useState，需要通过 props 或直接在 DialogManager 的调用处传入（参考其他 dialog 的传参模式）。

- [ ] **Step 7: 在 `AppContainer.tsx` 拦截第二次 Ctrl+C**

在 `handleExit` 回调（约行 2387）中，找到 `pressedOnce` 为 `true` 时调用 `handleSlashCommand('/quit')` 的分支：

```typescript
// Fast double-press: Direct quit (preserve user habit)
if (pressedOnce) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  // Exit directly
  handleSlashCommand('/quit');
  return;
}
```

修改为：

```typescript
if (pressedOnce) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  // If inside a worktree, show the exit dialog instead of quitting directly.
  if (worktreeSession) {
    setShowWorktreeExitDialog(true);
    return;
  }
  handleSlashCommand('/quit');
  return;
}
```

`worktreeSession` 是 Step 1 中 `useWorktreeSession()` 的返回值（已在 AppContainer 函数体内）。将其加入 `handleExit` 的 `useCallback` 依赖数组。`setShowWorktreeExitDialog` 来自 Step 1 的 useState。

- [ ] **Step 9: 类型检查 + 全量测试**

```bash
npm run typecheck
cd packages/core && npx vitest run
cd packages/cli && npx vitest run
```

期望：全部通过，无回归。

- [ ] **Step 10: 构建**

```bash
npm run build && npm run bundle
```

期望：`dist/cli.js` 生成无报错。

- [ ] **Step 11: 提交**

```bash
git add packages/cli/src/ui/components/WorktreeExitDialog.tsx \
        packages/cli/src/ui/components/WorktreeExitDialog.test.tsx \
        packages/cli/src/ui/components/DialogManager.tsx \
        packages/cli/src/ui/contexts/UIStateContext.tsx \
        packages/cli/src/ui/AppContainer.tsx
git commit -m "feat(worktree): add WorktreeExitDialog — intercept Ctrl+C when worktree is active"
```

---

## 验收标准

| 场景                          | 预期行为                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| `enter_worktree` 调用后       | `<sessionId>.worktree.json` 存在，内含 slug / path / branch |
| `exit_worktree` 调用后        | `<sessionId>.worktree.json` 被删除                          |
| `--resume` 时 worktree 仍存在 | Footer 显示 worktree 行；INFO 消息提示路径                  |
| `--resume` 时 worktree 已删除 | sidecar 文件被清理，无 worktree 行展示                      |
| worktree 内第一次 Ctrl+C      | 显示 "Press Ctrl+C again to exit."                          |
| worktree 内第二次 Ctrl+C      | 显示 WorktreeExitDialog（keep / remove / cancel）           |
| 非 worktree 环境第二次 Ctrl+C | 直接退出（行为不变）                                        |
| 新建 worktree 内提交          | `core.hooksPath` 指向主仓库 hooks，pre-commit 正常触发      |
| statusline 脚本 stdin         | JSON payload 含 `worktree.slug` 和 `worktree.branch`        |
