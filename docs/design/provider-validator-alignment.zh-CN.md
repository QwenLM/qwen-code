# Provider 校验器对齐

[English](provider-validator-alignment.md) | [简体中文](provider-validator-alignment.zh-CN.md)

## 问题与范围

Issue #13041 指出 managed-runtime-provider/1 的 TypeScript worker 与 Java Broker
还存在五个接收行为差异：checkpoint 的 promptId 长度、三个孤立代理项用例，以及
Session UUID 大小写。同类 promptId 长度缺口还存在于原始历史 rewind 和恢复的历史
快照中。本次覆盖这些差异，不改变协议版本、路由或工具自定义输入的语义。

## 规则与实现

- 每个协议 promptId 都必须是非空字符串，最多 128 个 UTF-16 单元，且不含 NUL。
  Java 用同一辅助函数校验身份、引用、checkpoint、原始历史 prepare/rewind，以及
  两种快照绑定形式。快照容器沿用 worker 的上限：最多 100 个唯一 promptId。
- 操作中的字符串和对象键必须是合法 Unicode。worker 在现有 JSON 形状、深度和
  大小校验之后检查。Broker 保留已有拒绝规则：否则其编码器会将孤立代理项替换为
  问号，改变工具参数。
- 工具身份及引用的 Session UUID 必须为小写，并与信封 runtimeSessionId 完全
  相等。core 的通用 UUID 解析器保持不变。provider 对比原始身份与解析结果，防止
  规范化暂时放行随后会被运行时拒绝的值。
- 信封 Session ID 仍是不透明、路径安全且区分大小写的标识。其原始拼写、路由、
  存储键和归属不会被规范化。不携带工具身份的操作仍可使用含大写字母的 Session ID。
- Acquire/release 和 execution/status/cancel 保留 Broker 现有的独立入口；
  它们的路由差异是有意设计。

## 兼容性与约束

合法小写身份和合法文本保持原有行为。原先通过某一校验器、随后才失败的输入，
现在在准入时拒绝。尤其不新增身份别名：core 运行时和 Broker 执行账本会比较原始
身份及引用摘要；规范化已存储的引用会改变幂等语义。

快照补充校验仅覆盖 prompt 身份及其容器，不重复实现 worker 的时间戳、备份和
路径等无关解析器，也不替代 worker 的全部语义校验。

## 验证与验收标准

- 两种语言回放同一个共享请求语料，包含 provider control 的正例和负例。Java
  必须在发送任何 HTTP 请求前拒绝无效操作，并原样保留合法信封。
- 覆盖每个协议 promptId 入口的 128/129 边界、嵌套无效 promptId、字符串值和
  键中的孤立代理项、合法 emoji、UUID 大小写组合，以及不透明信封的大小写保留。
- 同时测试 TypeScript 完整请求入口和独立操作入口。Java 覆盖快照类型、重复值
  以及 100/101 容量检查。
- 运行定向协议、provider、worker 和 Java transport 测试，项目构建、打包和
  类型检查，以及真实打包 worker 探针。保留基线失败证据，并在本地报告中说明
  验证限制。
- 交付前检查所有受影响的调用方和完整差异。
