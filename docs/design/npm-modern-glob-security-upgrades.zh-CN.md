# 现代 glob 与 minimatch 安全迁移

[English](npm-modern-glob-security-upgrades.md) | [简体中文](npm-modern-glob-security-upgrades.zh-CN.md)

## 问题与基线

本批接续已合并的 P3 #17147，基于 main `6fb21a87f3` 继续开发。工作区解析 glob 10.5.0/13.0.6、
minimatch 9.0.9/10.2.5；Mobile 独立 npm 树还包含 glob 10.5.0 和 minimatch
9.0.9/10.2.6。

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
列出 minimatch >=7,<11.0.1 受影响。CLI 直接调用 minimatch 没有请求 level 2，
但 glob 10.5.0 构造函数明确设置 `optimizationLevel: 2`，此前针对直接调用的
评估不能覆盖间接路径。确定性复现中，两条旧现代版本将八组 `**/../a/b/` 展开为
256 个候选，即使显式预算为 32 也不限制；修复版本会执行预算。这里证明库级放大，
不是已经测得产品拒绝服务。

## 目标与兼容决策

使用 minimatch **11.0.8** 和 glob **14.0.6**。仅升级到 minimatch 11.0.1
会引入后续已知问题：通配符编译问题由 11.0.7 修复
（[GHSA-cf2h-pxjq-68xw](https://github.com/isaacs/minimatch/security/advisories/GHSA-cf2h-pxjq-68xw)）；
转义及缓存保留问题由 11.0.8 修复
（[GHSA-c859-jr93-m5j4](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4)、
[GHSA-hqmv-qgp3-jx75](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75)）。
glob 14.0.6 修复 ignore 模式展开预算
（[GHSA-qxr8-q827-836c](https://github.com/isaacs/node-glob/security/advisories/GHSA-qxr8-q827-836c)）；
14.0.2 还修复取消后继续遍历
（[GHSA-3g3m-2fjr-6pw4](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)）。

不能将 minimatch 11 强制放在 glob 10/13 下：旧 glob 的模式实现检查
`instanceof RegExp`，minimatch 11 改用非递归 Matcher 对象，因此必须一起升级
现代 glob 父包。旧 glob 7、minimatch 3/5 留给单独父链迁移；其回调/函数 API
不能通过全局 override 直接换成现代主版本。

提高根/Core/CLI 的 glob 声明及 CLI 直接 minimatch 声明。Core 也声明 minimatch
下限 11.0.8：glob 14.0.6 仍要求 `^11.0.5`，该范围本身允许后续已知受影响的
matcher 版本进入消费端。这记录消费端下限，不新增应用 API；既有消费端锁仍需要
刷新并核验。直接下限不能约束既有消费端锁在 glob 下保留的另一份 matcher；消费端
探针必须从 glob 父模块实际解析。用匹配的 npm/pnpm override 限定现代 glob 和
minimatch 版本范围，使传递现代消费者同步迁移；
在 Mobile 独立安装树中镜像。遵守 pnpm 包龄策略，不增加豁免。若目标包龄尚未
满足，保持本批为草稿，直到可以正常安装，不选择已知有漏洞的临时目标。

## 消费者与影响

| 消费者                                                  | 要保留的行为                                  |
| ------------------------------------------------------- | --------------------------------------------- |
| CLI 扩展路径激活、Hosted brace 边界                     | dotfiles、brace 展开、转义及拒绝路径逃逸      |
| Core glob/grep workers                                  | 异步流、上限、取消、符号链接和目录边界        |
| Core 扩展转换/管理/变量、pathReader                     | 递归发现及相对/绝对路径                       |
| Core 文件系统服务和 LSP 发现                            | 同步结果、忽略、nocase 及上限                 |
| CLI 命令加载/迁移、Hosted 工作区文件系统                | 命令枚举、工作区范围和 ignore 回调            |
| 根 clean/i18n/bundle 脚本和工作流测试                   | 同步/异步发现和复制                           |
| @ts-morph/common、vsce、TypeScript ESLint、test-exclude | 公开匹配、包文件选择、lint 过滤和覆盖范围选择 |
| archiver-utils 5、cacache 19                            | 归档文件展开和缓存内容枚举                    |
| Mobile 构建/测试工具                                    | 独立 npm 安装、构建、类型检查及非设备测试     |

Node 要求保持在仓库 Node >=22 契约内。Mobile 的现代副本仅为开发依赖，运行时
Node >=18 声明保持不变，开发验证使用仓库 Node >=22。匹配引擎变化较大，仅类型签名一致不足以
证明兼容。保留应用已有保护，不增加公开开关或 daemon 路由。依赖和许可证变化后
刷新生成的 notices。

## 验证与验收

改动前由 test-engineer 复现。迁移后验证真实目录 glob 和上述消费者对应的现有
Core/CLI 精准测试，再执行完整 build、bundle、typecheck、lint。核对每个现代
消费者的实际父链解析，覆盖同步/异步/流搜索、dotfiles、brace、ignore、取消及
目录边界，证明预算执行且普通模式仍正常。检查 VSIX 打包和 ts-morph 文件选择。
干净安装 Mobile，执行非设备检查。对比父分支生产审计并检查干净 CLI/Core 消费端：
工作区 overrides 不会被已发布包消费者继承。

验收要求上述检查及修复版本的正常冻结安装通过。本文是迁移方案，不表示验证完成。

## 当前验证

Mobile 干净独立安装和构建通过，32 项非设备测试及实际父链的匹配/glob、覆盖文件
选择、TypeScript ESLint 项目选择探针通过。其 lint 仍有 6,374 条错误；隔离的
父提交安装报出完全相同的诊断文件及逐项消息，因此属于基线失败，不能称 lint 通过。

新增三项回归测试已通过显式旧/新候选 glob 模块运行：旧 glob 10 的两项预算检查
失败，新 glob 14 三项全部通过。这还不是对工作区实际安装依赖的验证。无缓存的
严格 pnpm 策略校验仅拒绝 glob 14.0.6 未满 24 小时包龄；当前没有外部包豁免。
完整工作区测试、制品检查、notices 及消费端验证仍待正常安装后执行。

## 剩余工作

保持 #17099 开放。旧 ExcelJS/archiver/unzipper/inflight 父链、CUA/Live Host
独立树中的现代 glob 副本、#13169 示例协调、发布、消费端部署及原始 Snyk 复扫
继续跟踪。不能由 macOS 测试推断 Windows/Linux 原生或设备验证通过。
