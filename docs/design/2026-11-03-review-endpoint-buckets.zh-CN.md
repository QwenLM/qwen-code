# PR review endpoint 分桶

[English](2026-11-03-review-endpoint-buckets.md) | [简体中文](2026-11-03-review-endpoint-buckets.zh-CN.md)

## 状态与范围

在 PR #16151 中实现；尚未通过 CI 或真实 endpoint 流量验证。
仓库变量和 secrets 保持不变。范围仅为共享的 `Run review` 步骤，
不包含 Triage、Autofix 或冲突解决。

## 问题

通过比较模型名识别 endpoint cohort，会在两个网关使用同名模型时关闭 endpoint 分流。
一百个桶的周期还会让 80% 灰度集中在八十个连续 PR 编号上。
现有 host 日志在 endpoint 覆盖前输出，可能被误认为最终请求地址。

## 决策

- 先由 PR 编号选择 cohort，再选择该组模型和可选的 endpoint/key 对。
  模型名相同不能关闭 endpoint 分流。
- `QWEN_PR_REVIEW_MODEL_CANARY_PERCENT` 仍以百分比为单位。
  十的整数倍使用 `PR_NUMBER % 10`：80% 时 0–7 桶为 canary，8–9 桶为 default。
  其他百分比保留 `PR_NUMBER % 100`，避免把 8% 变成 80% 或 0%。
  判断条件为 `bucket * 100 < percent * bucket_count`。
- 保留无效百分比处理、无效 PR 回退和可选 endpoint 契约。
  未配置 canary URL 时保留既有的仅模型分流；配置 URL 但缺少 key，
  或 URL 无法解析时，回退至 default cohort。
- 将提前输出的 host 日志标记为 `initial_openai_host`。
  选择完成后记录请求模型名、桶号与桶数、最终 cohort 和 endpoint hostname。
  notice 不包含 key、URL 用户信息、路径或查询参数。

## 兼容性与风险

缩短分桶周期可能让已有 PR 更换 cohort。只有百分比和配置不变时，cohort 才稳定。
80/20 分流描述的是 PR 桶，不是模型请求量或并发容量；
本修改不保证任何网关能够承受其流量份额。传输错误不会自动触发跨 endpoint 切换，
其他 workflow 仍可能消耗默认 endpoint 的配额。

EAS 后端模型尚未确认。在确认显式支持 `deepseek-v4.1-flash-1017` 之前，
保留当前可用的默认请求名；仅替换后端模型不能证明支持哪些请求名。

## 验证与验收

Workflow 元测试执行真实 shell 选择块，覆盖 80% 时连续两个十 PR 周期、
同名模型的 7/8 桶边界、8% 的百分比精度、endpoint/key 成对选择、
配置回退和最终 hostname notice。本轮未运行这些本地测试；
交付不需要运行本地构建或安装依赖。

CI 通过并合并 PR 后，各检查一个 cohort 的 review。
80% 时，0–7 桶应记录北京 hostname，8–9 桶应记录上海 EAS hostname。
必须确认 `Run review` 实际执行，不能只依赖 review 被跳过时的绿色 workflow。
服务端模型与容量验证留作独立后续工作；
不能仅根据 notice 中的请求模型名修改线上模型变量。
