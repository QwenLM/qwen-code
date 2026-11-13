# Managed Workspace 网页抓取

[English](2026-10-23-managed-web-fetch.md) | [简体中文](2026-10-23-managed-web-fetch.zh-CN.md)

## 问题与范围

主 Hosted Workspace profile 尚未实现 [#15076](https://github.com/QwenLM/qwen-code/issues/15076) 中的 `web_fetch` 子需求。本次将其加入现有的 files、shell、search 和 team lead profile。快照 read profile 与独立的 CSI files 契约保留现有工具词表。`todo_write`、认证网页抓取和二进制下载不在本次范围内。

## 执行与权限

声明 `url`、`prompt` 与可选的 `format`，沿用共享工具的参数语义。在获取 Runtime 前校验参数，在审批前规范化 GitHub blob URL，使审批预览展示实际访问目标。保留 `default` 与 `auto-edit` 审批；`yolo` 沿用部署显式选择的免审批语义。网页抓取涉及出站信息披露，因此计划模式仍不允许执行。

沿用 Session 所属的 Broker Tool v2 路径，在绑定的 Runtime 中以显式 managed 模式执行 `WebFetchTool`。Worker 返回规范化文本和元数据，由会话主模型处理，不在缺少模型凭据时调用旁路模型。Managed 模式拒绝二进制内容，不向宿主机文件溢写，将文本预览的 JSON 编码限制为 16 KiB 并附截断提示。最终编码结果仍以现有持久化大小校验为准。

## 网络策略

Managed 抓取仅接受不含凭据、全部解析结果均为公网地址的 HTTPS URL。每次请求、重定向跳转与重试均复用扩展网络策略的地址分类和固定解析。将这段共享实现下移到 Core 工具模块，旧的 extension 导入路径通过重新导出保持兼容。独立的 Undici agent 与同版本内置 fetch 固定已校验的 DNS 结果，强制校验证书，并绕过进程全局代理 dispatcher。非 Node 运行时的原生 fetch 可能静默忽略 dispatcher，因此明确拒绝该运行环境。拒绝私网、回环、链路本地、元数据及保留地址，包括 IPv4 映射 IPv6 和混合公网／私网 DNS 结果。Managed 模式不降级到 HTTP。跨主机、协议或端口的重定向返回模型，通过新调用重新审批，不自动跟随。`yolo` 同样受网络策略及响应限制约束。

## 持久化与兼容性

在 Harness 能力声明中增加 `web-fetch/1`。将原生工具加入双端审批输入预览、审批 continuation 校验、原生批次恢复与生命周期的内联结果识别。为 CSI 及其已保存的恢复定义保留仅包含 Read/Write/Edit 的共享文件声明基线，仅在主 profile 中组合网页抓取工具。复用普通工具结果持久化与取消机制，不修改数据库、公开 API，也不新增路由。在提供该能力前，应同步升级 Runtime Worker 与 Harness。现有本地 `web_fetch` 保留旁路模型、私网访问、代理行为与下载能力。

## 影响范围

- Core 网页抓取与有界 HTTP 传输，以及网络和 managed 模式的定向测试。
- Hosted 工具声明、参数校验、能力、审批 continuation 与 Runtime 工具注册。
- Java 审批预览及内联结果生命周期校验，以及受影响的测试。
- Managed Agent 文档和本地 E2E 计划。

## 验证与验收

使用 `.qwen/e2e-tests/managed-web-fetch.md` 记录基线和改后验证。覆盖公网 HTML／Markdown／文本、格式协商、重定向、HTTP 错误、响应限制、取消、二进制拒绝，以及不含宿主路径的有界输出。验证私网和混合 DNS 拒绝、重定向／重试的连接固定、TLS 校验与审批拒绝／恢复。验证普通内联结果恢复和生命周期收敛。运行受影响的 Core／CLI 测试、根目录 build／typecheck／bundle、Java 定向测试和 `mvn verify`；独立报告未能执行的真实模型或部署检查。

验收要求：主 profile 声明并执行 `web_fetch`，审批展示实际 URL，拒绝后不发请求，安全公网文本进入模型和持久化历史，已完成调用允许生命周期清理。本地验证与部署验收分别记录。无未决设计问题。
