# P2 npm 安全升级

[English](npm-p2-security-upgrades.md) | [简体中文](npm-p2-security-upgrades.zh-CN.md)

## 问题与范围

Issue #17099 跟踪消费端扫描的剩余告警。本次评估基于 P1 PR #17105 的提交
`1c5be65bb8`。该 PR 修复 DOMPurify、MCP SDK、body-parser，仍有五项 P2
依赖低于修复版本。其 pnpm 树只有 node-server 2.x，但 Mobile MCP 独立 npm
锁文件仍有 1.19.17；只检查工作区会遗漏这条路径。

## 决策与消费者

| 包                | 基线                            | 目标                      | 消费者与可达性                                                                                                                                            |
| ----------------- | ------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| qs                | 6.16.0 和 6.17.1                | 6.17.1                    | Express query 解析、GitLab/飞书客户端和 Mobile MCP。没有直接 stringify 调用；GitLab 用 brackets、飞书用 repeat，未启用 comma 或 allowEmptyArrays。        |
| fast-uri          | pnpm 3.1.7; Mobile npm 3.1.5    | 3.1.9                     | Core 清单及 MCP、工具校验的 AJV Schema/引用解析。无直接生产导入或自定义 suffix 选项，仍需回归 URI 规范化对 Schema 的影响。                                |
| ip-address        | 10.5.0                          | 10.7.4                    | MCP 引入 express-rate-limit；邮件和构建工具引入 socks。限流在 Address6 前用 Node isIPv6 筛选，socks 解析已识别的 IPv6，未证明恶意 zone/换行输入可达产品。 |
| hono              | 4.13.3                          | 4.13.18                   | MCP 间接依赖。自建代码未用 serveStatic、validator、bodyLimit、mount；SDK Node transport 用适配器 getRequestListener。                                     |
| @hono/node-server | pnpm 2.0.12；Mobile npm 1.19.17 | 2.1.7；Mobile npm 1.19.19 | 保留各自已安装主版本和 Mobile 的 Node 18 声明。MCP SDK 1.32.2 接受两条主版本，未用 Vercel adapter。                                                       |

工作区增加精确且一致的 npm/pnpm overrides，提高 Core fast-uri 和 Mobile qs
的最低版本，避免发布清单仍保留旧下限。Mobile 独立 npm 安装增加自己的
overrides，保留适配器 1.x；Node 22 工作区维持 2.x。消费端仍须主动刷新
lockfile，依赖包发布后的 overrides 不会被继承。

## 公告依据

- qs：[comma 类型转换](https://github.com/ljharb/qs/security/advisories/GHSA-6pq8-jhm2-2vcw)
  影响 6.7.0–6.16.0；[空数组 key 注入](https://github.com/ljharb/qs/security/advisories/GHSA-w4cr-vjpx-p82q)
  有 6.16.2 回补，6.17.0+ 已修复。父 PR 已把 body-parser 那份升至 6.17.1，
  本次消除其他路径残留的 6.16.0。
- fast-uri：[scheme 注入](https://github.com/fastify/fast-uri/security/advisories/GHSA-333x-w4r6-6crp)、
  [编码 scheme](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg)、
  [host 混淆](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr)、
  [相对引用](https://github.com/fastify/fast-uri/security/advisories/GHSA-xhq7-xmqj-769h)
  均在 3.x 的 3.1.9 修复。
- ip-address：[zone 匹配平方级耗时](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5)
  影响 <=10.7.3，10.7.4 修复。
- Hono [重复解码](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)
  影响 4.12.4–4.13.10。本次用 [4.13.18](https://github.com/honojs/hono/releases/tag/v4.13.18)，
  同时包含后来 validator、body 缓冲、mount、allowPercentInPath 的修复；
  不为保留旧行为引入该选项。
- Node 适配器[重复解码](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f)
  在 2.1.3 和 [1.19.19](https://github.com/honojs/node-server/releases/tag/v1.19.19) 修复。
  后续 [allowPercentInPath 问题](https://github.com/honojs/node-server/security/advisories/GHSA-fj57-4f93-cfw6)
  影响 2.1.3–2.1.6，2.1.7 修复；1.19.19 回补已包含加固实现。
  全局公告元数据可能落后于官方 1.x 回补。2.x 选包含两项修复且符合包龄策略
  的 2.1.7；2.1.8 发布时间过近，不为其增加包龄检查豁免。

## 兼容性与暂缓项

五项升级保留已使用主版本。不修改生产配置、daemon 路由、鉴权边界或公共
选项。回归风险是 URI 处理、序列化和 HTTP 适配器行为。重建制品和许可清单，
overrides 不能改写已发布的内嵌代码。

minimatch 单独处理：GHSA-g3hv-75wg-m249 影响 7–10，只有 11.0.1 修复，
需要 optimizationLevel >=2，而自建调用未启用。9.0.9/10.2.5 仍是版本治理
欠账，未证明产品可利用；扫描的 3.1.5/5.1.9 不在该公告范围。

ExcelJS/inflight/unzipper 与 #16434 协同。ExcelJS 4.4.0 仍依赖 archiver 5
和 unzipper 0.10；消除 inflight 需要调整上游链，unzipper 0.10→0.12 改变
其 1.0 前兼容范围。自建浏览器预览重建用 JSZip，ExcelJS 流读取器用 unzipper
Parse 而非落盘 Extract，不能声称预览可触发扫描中的磁盘解压漏洞。
这些路径、npm 发布和消费端复扫在 #17099 保持开放。

其他独立锁文件不属于本工作区安装树：CUA agent-SDK 示例仍含五项旧依赖，
其 Electron 夹具含 ip-address 10.3.1，被排除的 live-host 含 fast-uri 3.1.6。
另行跟踪并与已修改 CUA 示例锁的 #13169 协同，不能由本次推断全仓每份锁
或已发布制品均已修复。
CUA 示例是 private 可运行示例，Electron 锁属于 private 测试夹具且 ip-address
标记为 dev-only。Live Host 虽为 private，但 live-host-release.yml 仍通过独立
npm ci 构建，不能称其停用；fast-uri 在其中属于 dev-only 构建工具欠账。
#17099 为 CUA/Live Host 维护者保留这些明确后续，不虚构经办人，也不声称
本 PR 覆盖了其发布验证。

## 验证与验收

修改依赖前独立复现适用的库行为，核对产品可达性；修改后复跑相同探针，验证
正常 Schema 引用、Express query、MCP 初始化/工具调用、IPv4/IPv6 代理/限流，
以及适配器请求、响应流。运行相关 Core、SDK、CLI、邮件/GitLab/飞书及 Mobile
非设备测试，完整构建、打包和类型检查。校验冻结 pnpm、Mobile 独立 npm 锁、
许可清单和 SDK tarball 解析。记录实际平台和覆盖，不能把版本变化等同产品
漏洞实测。

验收要求两条测试依赖树均无这五项的漏洞版本、相关回归通过、制品变化可解释。
若数据库误把官方已回补的 1.19.19 纳入，需附证据说明，不能隐藏。Windows/Linux、
真实移动设备、npm 发布和原始业务复扫留待后续。
