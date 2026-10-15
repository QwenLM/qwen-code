# Managed Agent Server 复用现有库

[English](2026-10-15-managed-agent-library-reuse.md) | [简体中文](2026-10-15-managed-agent-library-reuse.zh-CN.md)

## 问题与范围

Managed Agent Server 重复实现了通用字符串截断、空值安全的空白判断、数字判断、SHA-256 计算和 HMAC 初始化。部分请求路径还会在每次调用时新建 JSON mapper 或摘要组件。已有依赖能够提供相同操作，这些重复实现增加了维护工作。

本次在服务内部进行保持行为不变的重构。公共 API、数据库 schema、所有权校验和生命周期状态转换继续遵守现有契约。

## 方案与约束

- 在服务 POM 中直接声明 `commons-lang3` 和 `commons-codec`，使用 Spring Boot 的依赖管理，保持解析后的版本不变。
- 普通错误信息和标题截断使用 `StringUtils.truncate`；普通的空值安全空白判断使用 `StringUtils.isBlank` / `isNotBlank`。保持 UTF-16 截断和 null 处理方式。标题专用的 `unicodeBlank` 判断继续保留，包括 NBSP 和 BOM 的处理。
- 保留域前缀判断，使用 `StringUtils.isNumeric` 校验保留事件 ID 的数字后缀，继续接受 Unicode 数字。仅允许 ASCII 的契约校验继续显式实现。
- 重复的原始 SHA-256 方法委托给 `DigestUtils`。保持各调用方的字节编码、十六进制大小写、前缀和 JSON 规范化方式。使用 `DigestUtils.getSha256Digest()` 初始化增量摘要；保留字段长度前缀、流大小限制、心跳检查和长度校验。删除 Channel 服务中的原始摘要转发方法，在输出十六进制的调用点直接使用 `sha256Hex`。
- 签名认证、writer 凭据、快照游标和主机标识使用 `HmacUtils`，每次调用创建新实例。保留输入字节、二进制或十六进制结果、Base64 编码、恒定时间比较和异常映射。继续区分非法游标输入与被库包装的安全提供者异常。
- 复用配置固定的 JSON mapper。向定义存储注入已有 `RequestDigests` 组件；其规范化 mapper 与默认存储 mapper 分开使用。协议 JSON 配置不能替换为可变的应用全局配置。
- 将这些复用要求写入服务的 `AGENTS.md`，指导后续修改遵循同样的约定。
- 使用 `StringUtils.split(text, '\n')` 分割 Git 输出，仅丢弃空行并保留回车字符。使用 `StringUtils.replaceEach` 转义续跑历史文本，只将 `&`、`<`、`>` 替换一次；引号、控制字符和已有实体文本保持原有处理行为。
- 将产物字节区间的解析和归一化委托给 Spring 的 `HttpRange.parseRanges`。保留 ASCII 语法校验、外层 `trim()`、单区间限制、1 MiB 上限和现有的 400/416 错误映射。在检查产物是否为空之前解析非法语法和溢出数字，确保空产物的畸形区间仍返回 400。

## 验证与验收

验证 null、空字符串、长度边界和代理项输入的截断等价性；验证普通空白判断的等价性和标题规则的差异。对照原始摘要和十六进制输出，包括空内容和 UTF-8 内容。
将增量摘要和 HMAC 输出与现有 JDK 实现对照。验证保留事件 ID 的后缀继续接受 Unicode 数字，并拒绝空后缀和非数字后缀。保持现有的规范 JSON、五字段 cron/DST 计算和 JSON 字节预算截断不变。
通过调用方验证仅按 LF 分行和续跑历史转义。覆盖闭区间、开放结束区间、后缀区间、空产物、数字溢出、非 ASCII 数字、正负号、空白、多区间和恰好 1 MiB 的边界，确保选择结果与错误码不变。

在新工作树中，先按仓库的依赖安装和构建流程准备 Core 与 CLI 构建产物；原生 CSI 一致性测试会导入这些产物。

运行受影响的定义、Action、子 Workspace、消息中继、认证、凭据、快照、事件和自动化测试，再执行模块的 `mvn verify`，覆盖单元/H2 测试、Checkstyle 和 SpotBugs 门禁。检查解析后的依赖版本，以及两份文档的格式和链接。验收要求摘要字节不变、现有行为测试通过；本次重构不提供新的 MySQL 或 Hosted 恢复验收证据。
