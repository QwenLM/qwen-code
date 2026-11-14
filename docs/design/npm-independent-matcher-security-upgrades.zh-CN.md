# 独立 Electron matcher 安全升级

[English](npm-independent-matcher-security-upgrades.md) | [简体中文](npm-independent-matcher-security-upgrades.zh-CN.md)

## 问题与范围

独立 Live Host 和 CUA Electron 夹具 npm 锁不继承工作区 overrides。P3 后两者仍经 Electron 构建工具解析 minimatch 9/10，夹具还经 config-file-ts 解析 glob 10。P4 的工作区迁移不能修复这些独立安装树。

本批接续已合并的 P5 #17163，基于 main `97cc965012`，此前 P4 #17149 也已合并。升级现代 matcher 父边，保留现有 Electron、builder、ASAR 和原生应用版本。这些是私有包的开发/构建依赖，不证明生产应用中的漏洞可达。发布和消费端复扫仍独立验收。

## 目标与消费者

| 依赖树    | 现有父包                  | 现有子包                      | 目标                           |
| --------- | ------------------------- | ----------------------------- | ------------------------------ |
| Live Host | app-builder-lib 26.15.3   | minimatch 10.2.6              | 11.0.8                         |
| Live Host | @electron/universal 2.0.3 | minimatch 9.0.9               | 11.0.8                         |
| CUA 夹具  | app-builder-lib 25.0.5    | minimatch 10.2.6              | 11.0.8                         |
| CUA 夹具  | @electron/universal 2.0.1 | minimatch 9.0.9               | 11.0.8                         |
| CUA 夹具  | config-file-ts 0.2.8-rc1  | glob 10.5.0 / minimatch 9.0.9 | glob 14.0.6 / minimatch 11.0.8 |

在两树使用限定 minimatch 9/10 的 npm overrides，夹具另限定 glob 10。评估时最新 builder 26.18.0 仍声明 minimatch ^10.2.5，仅更新父包不能证明达到安全目标。保留各锁定父包，安装后从真实父包解析 matcher。

现代 matcher 要求构建宿主 Node 20 或 >=22。仓库要求 Node >=22，本轮使用 Node 22/24 验证。这些私有构建工具改动不提高公开应用的运行时 engine 声明。

版本目标沿用 [P4 已核对的公告](npm-modern-glob-security-upgrades.zh-CN.md)：minimatch 11.0.8 包含编译/转义/缓存修正，glob 14.0.6 包含 ignore 展开预算修复。不能只在 glob 10 内替换 matcher：其 RegExp 假设与 minimatch 11 的 Matcher 对象不兼容，会破坏普通匹配。必须联合升级该父包，不给工作区包龄策略新增豁免。

旧 ASAR/dir-compare/filelist/glob 7/minimatch 3/5 以及夹具 cacache/glob 8 路径单独跟踪，其 API 和公告区间不属于本次现代迁移。不能宣称独立构建树已清除 inflight 或全部 audit 项。

## 兼容证据与风险

修改前，测试工程师验证了实际安装父包，并用临时 alias 对 glob 14.0.6、minimatch 11.0.8 重复相同普通文件控制，两组均通过。Alias 证据不等同于干净安装。

Builder 文件筛选使用 Minimatch.match，涉及部分目录遍历、有序排除/重新包含。其 hasMagic 以字符串/非字符串分类读取 .set，可以兼容 Matcher 对象。必须保留各版 builder 已有的 root-node_modules 行为：25 与 26 的基础 filter 在叠加打包默认规则前并不相同。

Universal 使用命名 minimatch 函数和 matchBase 处理单架构 ASAR 文件、x64ArchFiles 和 Info.plist 选择。Alias 控制下真实普通文件 ASAR 合并及错误 allowlist 拒绝通过；该早期控制未覆盖 Mach-O/lipo、原生架构及 plist 改写，后文记录独立安装/原生验证的结果。

config-file-ts 调用真实 glob.glob.sync API，要求返回数组，并用源码/输出 mtime 决定是否编译显式 TS 配置。基线和 alias 均能编译含空格路径的配置、解析相对 helper 导入，并保持输出未变时的缓存命中。字面 builder[local].ts 文件名的既有 raw-glob 限制在两组中均产生 MODULE_NOT_FOUND，本批不修复它。

## 验证与验收

分别生成独立锁并进行干净 npm ci。要求实际父链解析 minimatch 11.0.8，夹具 config-file-ts → glob 14.0.6 → minimatch 11.0.8，相关路径无残留 9/10 副本。确认父包版本未变并检查 npm ls，不能只采信清单。

在正式安装树重复父级筛选、ASAR allowlist、配置编译和缓存控制，包括导入源码过期后的失效重编译。验证 plist/原生架构选择及可用的真实 macOS 打包。运行 Live Host 构建/类型检查/测试，启动带 preload bridge 的 staged CUA 夹具；记录未验证的平台与原生边界。

工作区正常包龄门禁通过后，完成完整构建、bundle、类型检查及相关检查，核对 notices/制品和 audit 变化。父 PR 合并后对齐实际 main 并复验，再开启当前 head 的 CI/评审。这些构建工具源码升级不能证明原 Snyk 复扫、发布或部署闭环。

### 本机证据（11 月 13 日，macOS）

两套独立干净 npm 安装和 npm ls 均通过，实际父/子包版本如上。正式安装树的文件筛选、ASAR/plist 规则、配置缓存及导入 helper 失效重编译均通过，未使用 alias。两版真实 universal 消费者还将本机编译的 thin x64/arm64 Mach-O 合并为双架构；匹配 x64ArchFiles 时保留相同 thin x64 原字节，缺少/不匹配规则时拒绝。没有加载或执行这些 fixture 库。

Live Host 构建、类型检查和全部 374 项测试通过。两个应用都完成真实 macOS universal 目录打包，本机测试明确关闭签名/公证/发布。可执行文件含 x64、arm64，预期 ASAR 条目与完整性元数据存在，Live Host 原有隐私键清理仍有效。其配置中的打包 Electron 仍为 39.2.7，与未变的 npm 开发 runtime 39.8.10 分开；夹具使用 39.8.5。不宣称升级了 Electron 版本。

CUA staged app 和 universal 包均在独立临时 user-data 目录中成功启动；只读 loopback CDP 确认真实 harness DOM 和 preload bridge，没有发送桌面输入。Live Host 麦克风/摄像头/设备行为、签名/公证发行包、x64 slice 执行及 Windows/Linux 未由这些检查覆盖。

npm 11.17 初次安装保留了待批准的生命周期脚本。本机原生引导只在临时项目配置中明确批准锁定的 Electron/esbuild 版本并执行 rebuild，随后删除该本地配置。没有全局放开脚本权限，也没有提交策略变更。

同一时点 audit 快照中 Live Host 减少六个聚合项（13 → 7），夹具减少五个（22 → 17），没有新增唯一公告键。剩余 high/critical 及旧父链继续披露，不宣称 audit 清零。

最终 stack 已包含 P5 验证过的归档迁移。实际冻结工作区安装通过既有严格包龄策略，并完成正常 prepare 构建/bundle；完整工作区 typecheck 及父 worker/预算十项回归通过。对齐后实际独立父消费者及原生架构选择控制再次通过，受跟踪的生成 notices 相对父分支没有额外差异。

完整工作区 lint 及锁/Playwright parity 检查也通过。独立本地依赖评审未发现可行动缺陷，最终自审干净。状态：本地验收及 stack 对齐通过；新 head CI/评审及合并仍待完成。

P5 合并后，本批已对齐实际 main `97cc965012`，四个独立声明/锁文件内容逐字节保留。父设计冲突采用 main 已评审的文档。本基线重新执行严格冻结安装，2199 项策略通过，正常 prepare 完整构建/bundle 完成；完整工作区 typecheck、lint、锁/Playwright parity 及十项 worker/预算测试再次通过。真实安装父消费者、plist 与原生架构选择控制也再次通过。先前 universal 打包和启动证据适用于未变的实现文件；本次对齐没有重复完整打包/启动。
