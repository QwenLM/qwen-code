# Hosted Harness Session 测试拆分

[English](2026-11-24-hosted-harness-session-test-split.md) | [简体中文](2026-11-24-hosted-harness-session-test-split.zh-CN.md)

## 测试结构

`hosted-harness-session.test.ts` 超过 50,000 行。将核心文本 Turn 和事件流用例保留在原文件，其余用例按主题移至同目录的 `hosted-harness-session.<topic>.test.ts`。按行为组织路由及失败用例，例如生命周期、唤醒对账、审批和 Runtime 接管。

先导入共享 Harness fixture，再导入路由模块，让 Vitest 优先安装原有的 Store、模型和唤醒 mock。主题专用 helper 放在使用它的测试旁，只在多个文件需要同一份 setup 时提取共享代码。两个崩溃暂停用例共享模块级的一次性开关，因此按原顺序运行。

## 验证

比较拆分前后的测试名称、参数化用例和断言。从 `packages/cli` 运行 `npx vitest run src/serve/hosted-harness-session --coverage.enabled=false`，执行这一组测试。另行运行仓库构建和类型检查。拆分仅涉及测试代码，保留生产路由和测试断言。
