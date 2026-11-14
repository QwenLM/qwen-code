# ExcelJS 归档依赖安全升级

[English](npm-exceljs-security-upgrades.md) | [简体中文](npm-exceljs-security-upgrades.zh-CN.md)

## 问题与基线

本批接续已合并的 P4 #17149，基于 main `7bb953cc7d`。ExcelJS 4.4.0 仍通过
archiver-utils 2、zip-stream 的 archiver-utils 3、unzipper 0.10/fstream/rimraf
引入三条 glob 7/inflight 父链，archiver 还使用 readdir-glob 1/minimatch 5。
ExcelJS 已是 Web Shell 的 bundled 开发依赖。其重建的浏览器入口使用 JSZip，
排除了 Node archiver/unzipper/glob 代码。当前源码不能证明旧消费端内嵌包已修复。

[unzipper 公告](https://github.com/ZJONSSON/node-unzipper/security/advisories/GHSA-2756-j7rr-9464)
描述同前缀兄弟目录的解压逃逸。元数据仍列出 <=0.12.3、未列修复版，用户扫描则
指定 >=0.12.5。独立运行对照复现了 0.10.14 两条公开解压 API 向受控临时兄弟
目录写入标记；精确 0.12.5 阻止写出且保留正常条目。这是库级复现，不是产品漏洞。
inflight 清理探针没有独立复现泄漏；它没有修复版本，需移除旧依赖路径。

## 方案与兼容性

| 父依赖边                | 原版本  | 目标   |
| ----------------------- | ------- | ------ |
| exceljs → unzipper      | 0.10.14 | 0.12.5 |
| archiver-utils 2 → glob | 7.2.3   | 14.0.6 |
| archiver-utils 3 → glob | 7.2.3   | 14.0.6 |
| readdir-glob 1          | 1.1.3   | 4.0.0  |

使用定向 pnpm overrides 并重新生成工作区锁。为 ExcelJS 保留 archiver 5.3.2、
archiver-utils 2.1.0、zip-stream 4.1.1。不能把所有 glob 7 全局换成 glob 14，
因为其他旧调用者可能依赖已移除的回调 API。已检查的 archiver-utils 2/3 文件
辅助函数只使用仍被保留的同步 `glob.sync` API。

不采用看似直接的 archiver 7/6 升级：archiver-utils 4/5 返回
`source.pipe(new PassThrough())`，但 ExcelJS 的 StreamBuf.pipe 返回 undefined，
导致真实流式 writer 报 INPUTSTEAMBUFFERREQUIRED。保留兼容父包、替换其受影响
子边即可移除风险，无需生产 shim 或改变电子表格 API。

readdir-glob 4 保留 CommonJS 函数/事件 API 并使用现代 minimatch。其工作区
消费者是 ExcelJS 的 archiver 5 和 CLI 测试夹具的 archiver 7，两者都需要覆盖。
新工具链要求 Node >=20，符合仓库 Node >=22；不改公开运行时引擎声明。
P4 已提供 glob 14.0.6/minimatch 11.0.8 及后续公告修复，遵守既有包龄策略，
不增加豁免。

## 验证与验收

独立复现及现有 33 项浏览器解析/构建测试作为基线。隔离候选树不再包含
inflight/glob 7/minimatch 3/5，普通 document/公式/样式、bare 浏览器读取、
inline-string 流式读写、archiver glob/目录和 utils 文件展开对照通过。
这只是候选证据，不是仓库实际安装验证。

正常冻结安装后核对每条实际 ExcelJS 父边，重跑解压边界和正常文件对照，补充边界
及流式 writer 兼容回归。运行现有 Web Shell parser/browser-build 测试和表格
worker/浏览器 E2E，另执行 CLI workspace-skill-archive、workspace-skill-management
测试覆盖 archiver 7。完成 build、bundle、typecheck、浏览器制品检查、notices
更新、审计对比和干净 Web Shell 包消费端验证。最终评审需确认 ExcelJS 已没有
通往旧依赖的声明路径，不能把工作区其他旧开发依赖路径也称为清除。

旧 shared-string 流式 reader 对照在迁移前的 Node 22/24 均失败。明确保留基线，
不能归因本次升级或默认为通过。document 和浏览器预览的 shared-string 行为由
既有 parser 测试另行覆盖。

## 当前验证

实际冻结工作区安装（包括正常 prepare 构建和 bundle）在既有严格包龄策略下通过，
全量 typecheck 和 lint 通过。Web Shell 实际测试 36 项通过，包括三项新增归档/
流回归及现有 33 项 parser/browser-build。CLI 归档/管理 83 项通过。Chromium
表格预览 11 项 E2E 全部通过，覆盖按需加载、worker 策略、虚拟滚动、格式/合并
单元格及无效或不可用预览时的下载回退。

从真实 ExcelJS 沿声明依赖遍历得到 84 个安装包，已没有 inflight、fstream、
rimraf 2、glob 7、minimatch 3/5 路径。保留 ExcelJS 4.4.0、archiver 5.3.2、
zip-stream 4.1.1、archiver-utils 2.1.0/3.0.4；两个辅助包均解析到 glob 14.0.6/
minimatch 11.0.8，普通包含/排除/重新包含控制通过。实际 document/公式/样式、
bare 浏览器读取及 inline-string 流往返也通过。

同期全工作区 audit 本批前后保持 94 项（low 14、moderate 40、high 33、critical 7），
不能据此宣称 audit 数减少，源码依赖图移除单独评估。独立本地评审未发现可行动
缺陷，并单独复跑三项新增回归通过。实际 ExcelJS 父包的普通 glob/directory ZIP
生成也通过，七个输出文件内容均符合预期。

Web Shell 发布前 verifier 通过。实际 tarball 含 874 个文件，压缩 7,497,577
字节、解包 29,729,528 字节；新消费端与同树 SDK 候选 tarball 一起安装，不带 overrides 或 workspace
链接，无 DOM 导入根入口/transcript 和 Vite 5.4.21 生产构建均通过。
SpreadsheetPreview 仍为动态 chunk，包内与消费端输出的 inline worker 字节一致，
受控 Node worker_threads 的 load/sheet 消息能正确解析普通工作簿。该资产/协议
控制与仓库 11 项真实浏览器测试分开，不代表所有浏览器 Blob Worker 生命周期或
发布完成。

#17149 合并后，原 PR 已 retarget 到 main，保留五文件增量。正常严格冻结安装及
prepare 完整构建/bundle、全量 typecheck/lint、锁/Playwright parity 再次通过，
Web Shell 36、CLI 归档/管理 83、Chromium Excel 11 项测试也再次通过。远端 CI/
评审作为当前 PR head 的独立验收继续跟进。

## 剩余工作

本批不关闭 #17099 或 #16434。发布、消费端部署/锁刷新、原始 Snyk 复扫、
CUA/Live Host 剩余独立树及 Windows/Linux 原生验证仍单独跟踪。不新增 daemon
路由、生产选项或公开 API。定向父依赖边方案没有阻塞实施的设计待定项。
