# 独立 npm 构建树安全升级

[English](npm-independent-build-security-upgrades.md) | [简体中文](npm-independent-build-security-upgrades.zh-CN.md)

## 问题与基线

P1 #17105 和 P2 #17134 已合并。在 `e832ae58bd` 上，两条仍在使用的私有
Electron 构建树保留了低于 #17099 修复要求的版本：

| 独立安装树            | 依赖路径                                                                                                                       | 基线   | 目标   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ------ |
| Live Host             | electron-builder → app-builder-lib → ajv → fast-uri                                                                            | 3.1.6  | 3.1.9  |
| CUA Electron 测试夹具 | electron-builder → app-builder-lib → @electron/rebuild → node-gyp → make-fetch-happen → socks-proxy-agent → socks → ip-address | 10.3.1 | 10.7.4 |

两者都是应用构建所用的开发依赖，并非运行时直接导入。Live Host 不属于根工作区，
发布工作流执行独立的 `npm ci`。嵌套 CUA 夹具也按自己的锁文件安装，因此根
pnpm/npm overrides 不能修复这两条安装树。库级复现不代表产品漏洞已证明可达。

## 方案与兼容性

只在原父依赖允许的范围内更新两条锁记录：AJV 接受 `fast-uri ^3.0.1`，socks
接受 `ip-address ^10.1.1`。保留父包及其主版本，不增加直接依赖或 override，
因为父依赖范围已经允许修复版本。保留 npm 生成的注册表完整性和依赖元数据。

[fast-uri 公告](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg)
列出 3.x 中低于 3.1.9 的版本受影响；[ip-address 公告](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5)
列出截至 10.7.3 的版本受影响，10.7.4 修复。
fast-uri 3.1.9 会拒绝歧义或编码的 scheme、host，并正确转义相对 suffix 引用。
除安全用例外，需要验证正常 URI 规范化和 AJV 引用。ip-address 10.7.4 限制畸形
zone 的处理开销；除有时间上限的恶意输入外，还需验证 IPv4/IPv6 和 SOCKS 代理连接。

## 验证与验收

改依赖前，由独立 test-engineer 报告复现残留的库级行为。改动后执行干净的独立
npm 安装，核对实际父链，重跑安全及正常输入探针，执行 Live Host 构建、类型检查、
测试。在 macOS 构建 CUA 夹具并检查打包应用。按贡献流程执行仓库构建和类型检查。
在 PR 报告中记录真实结果及限制；这里是计划，不代表以上验证已经通过。

验收要求两条实际安装树均解析到目标修复版本，相关构建及兼容检查通过。不增加生产
选项、daemon 路由或应用源码行为。

## 剩余工作

不关闭 #17099。CUA agent 示例与 #13169 重叠，需协调后续修复。minimatch、
ExcelJS/unzipper/inflight、发布、消费端锁刷新、内嵌 bundle 及原始 Snyk 复扫仍
单独跟踪。macOS 验证不能证明 Windows/Linux 夹具打包及真机验证通过。
这两项同主版本升级没有阻塞实施的设计待定项。
