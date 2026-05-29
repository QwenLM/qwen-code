# Guarded Upstream Sync：低人工介入的上游同步保护方案

> 目标：每天自动同步 upstream，同时避免 AI 或 Git 自动合并静默丢失 fork 定制。

## 1. 背景

本仓库是 `QwenLM/qwen-code` 的内部 fork。fork 分支包含 DataWorks
定制、内部发布链路、channel、OAuth、i18n、CI 等改动。日常需要定期把
`upstream/main` 合入内部 `main`。

最初考虑过 patch replay 方案：

1. 先把 fork 改动回退到接近 upstream 的状态。
2. 合并最新 upstream。
3. 再逐个 apply fork patch。

这个方案能让 fork 改动显式化，但对当前仓库来说维护成本偏高：fork 改动面较宽，
后续每个 patch 都要判断保留、改写、退休；如果 upstream 的方案更合理，patch
replay 还容易形成“本地改动默认覆盖 upstream”的倾向。

因此主同步流程建议采用 guarded merge，而不是 patch replay。

## 2. 核心原则

Guarded upstream sync 的核心不是让 fork 改动永远胜出，而是让风险可见：

- CI 每天自动同步，不要求人工每天合并代码。
- Git 正常 merge upstream，保留 upstream 的自然演进。
- AI 不默认自动解冲突，避免静默改坏代码。
- 只有出现风险信号时才升级人工或 agent 处理。
- 通过 fork manifest 和 guard tests 保护关键业务能力。

也就是说，大多数同步仍然自动完成；人工只处理冲突、测试失败或高风险文件。

## 3. 推荐流程

```text
每天定时：
  1. fetch upstream/main
  2. 检查 upstream 是否有新提交
  3. 基于内部 main 创建或复用 sync/upstream-YYYYMMDD 分支
  4. 正常 git merge upstream/main
  5. 根据结果分级处理
  6. 创建或更新 sync MR
  7. 发送钉钉通知
```

分级策略：

| Level | 条件                                       | 自动行为                      | 人工介入           |
| ----- | ------------------------------------------ | ----------------------------- | ------------------ |
| 0     | 无 upstream 新提交                         | 跳过 MR，通知 already latest  | 不需要             |
| 1     | merge 成功，guard 通过                     | 创建 MR，可标记低风险         | 通常不需要         |
| 2     | merge 成功，命中 fork 高风险文件，测试通过 | 创建 MR，列出重点 review 文件 | 只 review 重点文件 |
| 3     | merge 成功，但 guard 测试失败              | 创建 MR 并阻断自动合入        | agent 或人工修复   |
| 4     | Git merge conflict                         | 停止自动改代码，输出冲突报告  | agent 或人工处理   |

## 4. Fork Manifest

不建议把所有 fork 改动都转成 patch 作为主流程。更轻的方式是维护
`.fork/manifest.yml` 或 `.fork/manifest.json`，记录“需要保护的 fork 能力”。

示例：

```yaml
features:
  - id: dataworks-branding
    description: Header 和启动信息使用 DataWorks 品牌
    paths:
      - packages/cli/src/ui/components/Header.tsx
      - packages/cli/src/ui/components/AsciiArt.ts
    tests:
      - cd packages/cli && npx vitest run src/ui/components/Header.test.tsx

  - id: dsw-oauth-redirect
    description: DSW 环境下改写 OAuth redirect URI
    paths:
      - packages/core/src/mcp/oauth-provider.ts
    tests:
      - cd packages/core && npx vitest run src/mcp/oauth-provider.test.ts
```

manifest 记录的是“能力”和“风险区域”，不是机械 patch。这样 upstream 如果提供了更好的实现，
我们可以接受 upstream，只要 guard test 证明关键行为仍满足内部需求。

## 5. Guard 检查

同步 MR 创建前后应执行三类检查。

### 5.1 风险文件交集

计算：

```text
本次 upstream 改动文件 ∩ fork manifest paths
```

如果交集非空，MR 描述中列为 high-risk files。这个结果不一定阻塞合并，但 reviewer
需要重点看这些文件。

### 5.2 fork 能力测试

manifest 中每个 feature 可以声明测试命令。同步后只运行受影响 feature 的测试，避免全量测试过慢。

测试失败时应阻断自动合入，但仍然创建 MR，方便 agent 或人工基于 MR 修复。

### 5.3 静默回退检测

可以保留现有的 diff/签名行校验作为辅助信号，但它不应是唯一依据。更可靠的判断应来自：

- 高风险文件列表
- 针对 fork 能力的行为测试
- MR 中清晰展示 upstream 改动范围

## 6. AI 使用边界

AI 可以参与修复，但不应该在 CI 默认自动解冲突。

推荐边界：

- merge conflict：CI 只生成冲突报告，不自动 `--yolo` 修改代码。
- guard test failure：可以由 agent 在独立分支上修复，再走正常 MR。
- clean merge：AI 不参与改代码，只生成风险摘要。

这样保留了自动同步效率，同时避免“AI 自动合流丢代码”。

## 7. 与现有 Aone CI 的关系

当前仓库没有 `a1-ci/a1-ci.yaml`。实际相关配置位于 `.aoneci/`：

- `.aoneci/upstream-sync-merge.yml`：每天 22:20 执行 upstream merge。
- `.aoneci/upstream-sync-analyze.yml`：工作日 9:00 分析 upstream 变更并通知。

`.aoneci/upstream-sync-merge.yml` 已经接近 guarded sync 的雏形：

- 定时 fetch upstream。
- 检查是否有新 upstream commits。
- 创建 `sync/upstream-YYYYMMDD` 分支。
- 正常 `git merge upstream/main`。
- 创建 MR。
- 在 clean 状态下运行验证脚本。

但它还不是完整的 guarded sync：

- 仍会尝试 LLM 自动解决冲突。
- fork 风险文件和 fork 能力测试还没有成为主 MR 信号。
- 验证步骤是非阻塞的，无法防止失败结果被忽略。
- 现有静默回退检测偏文件级，不能替代行为测试。

因此建议在现有 `.aoneci/upstream-sync-merge.yml` 基础上增量改造，而不是引入 patch
replay 主流程。

## 8. 后续落地建议

优先级建议：

1. 新增 `.fork/manifest.yml`，先记录最关键的 5 到 10 个 fork 能力。
2. 在 sync MR 描述中加入 high-risk files。
3. 对命中的 feature 运行对应 guard tests。
4. 禁用 CI 默认 LLM 自动解冲突，改为报告冲突。
5. 将 guard test failure 设置为阻断自动合入。

patch 文件可以保留为审计或迁移辅助工具，但不建议作为每天同步的主路径。
