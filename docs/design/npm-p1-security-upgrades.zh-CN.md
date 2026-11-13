# P1 npm 安全升级

[English](npm-p1-security-upgrades.md) | [简体中文](npm-p1-security-upgrades.zh-CN.md)

## 问题与范围

Issue #17099 跟踪消费端安全扫描问题。基线锁定 DOMPurify 3.4.14、MCP SDK
1.30.0（Mobile MCP 为 1.26.0）和 body-parser 2.3.0。畸形压缩请求可导致
daemon 退出；MCP 客户端可能跨来源转发凭据。DOMPurify 报告中的 Shadow Root
模板绕过需要非默认选项，当前 Generated UI 配置不满足该条件。

本次处理这三个 P1 依赖。ExcelJS/inflight、minimatch 公告复核及其他 P2 项
继续单独跟踪。

## 决策与消费者

- 全部直接 MCP SDK 声明（包括独立扩展示例）在 1.x 内升至 1.32.2，保留
  Mobile MCP 的精确版本策略。消费者包括 Core/CLI、SDK 和 daemon SDK、
  Node REPL、Mobile MCP、IDE companion、Generated UI、external context、
  Mem0 和 failure explorer。
- Generated UI 直接固定 DOMPurify 3.4.17；同步增加 npm/pnpm overrides，
  确保 Mermaid 内嵌清洗器也使用修复版本重新构建。
- 对 Express 5 依赖路径同步增加 body-parser 2.4.0 npm/pnpm overrides，
  保留压缩请求支持和既有请求体大小限制。
- 全部自建 MCP 服务构造点（包括示例）启用 `maxToolInputElements: 100_000`。
  SDK 修复默认没有启用此上限。Schema 解析前累计对象成员和数组元素，超限
  调用返回参数无效错误，不执行 handler。这是元素数量限制，不是字节数、
  字符串长度或进程总内存限制。固定且较宽松的上限兼顾普通标量参数和批量
  输入，同时限制集合遍历；不新增公共配置。SDK 用户提供的外部服务仍由其负责。
- 当前生产调用未使用 SDK bearer 中间件或 taskStore，不引入无实际消费者的
  audience 或任务存储配置。未来若引入 bearer 中间件，必须设置
  expectedResource 并返回 AuthInfo.resource；仅升级不会开启 audience 校验。

## 兼容性与交付

三个依赖均保持原主版本并支持 Node 22。跨来源 MCP 重定向改为失败，不再
转发自定义凭据；同来源重定向和正常工具调用应继续可用。超过 100,000 个
输入元素的调用会被主动拒绝。SDK 消费端通过声明获得提高后的 MCP 最低版本；
CLI 和 Web Shell 必须重新构建，overrides 无法重写旧制品已内嵌的依赖。

## 验证与验收

升级前复现压缩请求导致 daemon 退出、跨来源凭据转发和条件性清洗绕过。
升级后对修复依赖和已构建 CLI 重跑相同探针，并确认畸形请求后正常请求仍可用。
两个 SDK 工厂均测试元素精确边界和拒绝后的恢复。回归 Core OAuth/传输、SDK
Schema、Mobile MCP、IDE、Generated UI、Mermaid/公式和 XLSX 预览。执行全量
build/typecheck/bundle、针对性单测、浏览器冒烟、冻结锁文件校验，并检查制品
和许可清单。PR 记录实际平台和限制；发布与消费端部署作为后续步骤。

验收要求工作区锁文件不再包含这三个 P1 依赖的旧副本，适用安全探针通过，正常
MCP/浏览器流程通过，且不存在无法说明的依赖或许可清单变化。
