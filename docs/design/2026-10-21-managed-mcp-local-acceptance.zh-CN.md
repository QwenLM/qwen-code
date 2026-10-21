# Managed MCP 本机验收

[English](2026-10-21-managed-mcp-local-acceptance.md) | [简体中文](2026-10-21-managed-mcp-local-acceptance.zh-CN.md)

## 问题与当前状态

Managed Session 已支持发布 MCP 服务版本引用、在选定 Workspace Runtime 执行工具，
并向输入框暴露已提交目录。已有 Hosted MCP 进程及故障测试覆盖传输、结果交付、
重启和释放。公开扩展组合验收也检查 Runtime 复用，但其 Hook/cgroup 配置将该
用例限制在 Linux。

本机验收还缺一项可执行见证：在不依赖 Hook/cgroup 的条件下，贯通公开
AgentDefinition 和 Session API、普通连续模型轮次、两种目录接口、持久工具结果
和公开关闭。浏览器目录 fixture 通过不能证明这条执行链。

## 方案

在现有 `HostedMcpStreamGapIT` 夹具中增加 MCP 独立验收用例。复用真实 Spring
控制面、一次性 MySQL、打包 Harness、持久本机 worker、stdio 服务及确定性的
OpenAI 兼容模型。通过公开 API 发布配置，再通过公开 Session 输入路由提交两个
不同任务。

第一轮结束后保存原 worker 登记和已提交 MCP 配置。下一轮必须保持相同 binding、
generation、进程身份和连接身份。统计实际服务启动、初始化请求、工具调用次数，
核对夹具的持久副作用。检查普通工具执行的已提交结果和模型实际看到的响应；
模型工具调用不产生原始资源/提示操作使用的 `mcp_operation` 记录。

分别读取公开目录和 WebShell 适配接口，要求返回相同、经过脱敏且非空的已提交
目录。通过公开 Session API 关闭，要求关闭操作完成、MCP 和 Runtime 所有权释放、
没有存储 holder，以及原 worker 和 MCP 进程均退出。在测试清理前保存证据，
不能让 teardown 代替关闭断言。

## 范围与决策

- 增加进程验收见证，复用现有 MCP 实现。
- 复用已有夹具和服务，不增加通用测试抽象。
- 保留配置、凭据、工具授权与 Runtime 路由规则。
- 仅使用测试自有数据库、目录、端口和进程。
- 在可用的原生 macOS 上执行，保持 Linux 兼容。本次不启用 SSH MCP 或专用
  常驻文件执行 profile。
- 确定性模型验证协议和工具结果链路，不代表上游模型行为。浏览器交互及
  HTTP/SSE 传输仍是独立验收维度。

## 验证

先尝试全局安装 CLI 的基线，再使用新构建的 bundle 和一次性 MySQL 8.4 执行
新增用例。运行完整的受影响测试类和 Java 模块验证。构建、类型检查并打包
TypeScript 前置产物，检查格式和 Hosted 进程预算契约。使用负向见证证明：MCP
即使返回貌似成功的响应，缺少预期的持久物理副作用时也不能通过验收。命令、
测量值、限制和前后证据记录于 `.qwen/e2e-tests/managed-mcp-local-acceptance.md`。

在原生 macOS、MySQL 8.4.11、JDK 21 上，新用例单独执行耗时 8.776 秒，在四项
整类中耗时 6.017 秒；四项全部通过，共 113.7 秒。整类实测耗时的两倍仍小于
现有 242 秒预算，因此共享 fork、job 和 step 上限保持不变。

## 开放问题

本验收切片没有待定问题。用户配置管理、WebShell 资源/提示执行及其他 Runtime
profile 是独立工作。
