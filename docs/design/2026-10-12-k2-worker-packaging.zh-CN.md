# K2 私有 worker artifact 打包

[English](2026-10-12-k2-worker-packaging.md) | [简体中文](2026-10-12-k2-worker-packaging.zh-CN.md)

状态：implementation candidate。原 ACK worker 的完整 image digest、command 和 loader manifest 已不可取得，其文字验收不能资格化替代品。本文提供新的可审阅构建输入，不发布或安装，不资格化 confinement 或启用物理释放。

私有 provisioner 接受固定摘要的 image 和 base command，再追加 `managed-runtime-worker --container-boot /var/run/qwen-runtime/boot.json`。从现有生产 attestation worker 构建一个 ESM bundle，入口只接受这些 exact arguments，并将 boot 验证交给生产 worker。没有新增 route 或 tool，已有 boot capability 仍选择仅文件 composition。bundle 嵌入实际 WASM 依赖，提供 Node ESM/CommonJS bridge，拒绝不支持的 asset loader 或 build warning。每个文件实际提供的 bytes 及最终 readback 都固定摘要，保留 compiler output 和完整 metadata；build 成功不是启动验收。

官方 Node 22 bookworm-slim image 必须先读取并固定实际选中 Linux 架构的 manifest、configuration 和全部 layers；tag 只用于发现。compose 前验证每个 descriptor 的完整 bytes/digest 及每层解压后的 diff ID。anonymous registry pull 不持久化或输出 token；打包不执行或解压落地下载的 archive。新 worker layer 只含 root 拥有、只读的 `/opt/qwen-k2/worker.mjs`。清除继承的启动/environment 配置，设置固定 Node command、非 root image user 及私有 worker arguments。生产 Pod 另外实施已有 UID/GID、capability drop、只读 root、boot volume 及仅文件合同。image defaults 不能代替 admitted-spec 或 kernel 检查。

`deploy/k2-evidence/build-worker.mjs` 构建 exact bundle 和输入 manifest，`package-worker.py` 将其与独立验证的 base OCI layout 合成为新目录。两者拒绝覆盖，保留未完成 attempt。输出包含完整 manifest/configuration/layers 及 provenance 摘要，不含凭据或 boot payload。base 含普通 binaries，经审阅 worker policy 必须仅允许实际 Node/loader/library/module 链；文件清单或 image hash 本身不能禁止执行其他文件。

使用实际生产 imports 验证 bundler，独立测试有界 invalid invocation/boot refusal，并比较输入不变时重复构建的完整 output bytes。image composer 验证实际固定 base descriptors/diff IDs、只读 layer metadata、output digest readback，以及损坏或不匹配输入的拒绝。完整 AppArmor bundle 下的 native worker 启动仍需要实际 image、command、syscall/loader/mount 权限及目标 runtime。旧 Mac、fixture、parser 或历史 ACK 结果均不转移。registry publication 和安装需要另外具体批准。完整 application、stop/unpublish、原子释放、reuse 及公开选择仍是独立 K2 验收要求。

冻结的 `4c9ed6e0` packaging candidate 独立完成输入/输出读回：2873 个实际 module inputs 和30个 artifacts 全等。重复构建生成相同25187242字节 bundle，SHA-256 `53214b2fab584b0cee325b3d0c69b890cc1d45b455c40340f0704bcb4806e2a6`。离线核对两个 Linux 架构全部 descriptors、共12层 compressed/uncompressed layers、固定 user/command/environment 及 exact root-owned 0444 worker payload。实际 manifests 为 amd64 `8ae5593757f15f3c8c59334afccb7afc884256930517cb1cd59728264aa36cff` 和 arm64 `bec0955c6532ce65e123739d45c229329789cfc0f7f223850b1129289213eabc`。

Darwin arm64 Node22.14.0 上8次有界原 bundle 调用均按要求 exit1：7种 invalid arguments 及固定 boot file 缺失。原 wrapper 第8项预期 error 文案错误，其 exit1 和 raw output 原样保留；独立 byte comparison 与生产 missing-boot constant 匹配，没有重跑。这只证明本地 import/refusal，未执行 base image 声明的 Node22.23.3。包装 guards 仅作静态读取，corrupt-input CLI 测试仍待完成。这些结果不提供 syscall/network trace、有效 worker startup、image runtime、LSM、云端发布或安装资格。独立报告 SHA-256 为 `40d3d42aa944073fefe1e3592164b3df8d432f574d2ad624e103131fe8854faa`，自有 processes 全部关闭。

另行冻结的composer组通过16个实际负向CLI用例及7项完整性/关闭检查（报告 `a0688cef297806adac0b364a7f001f12eb242845eba886812a99065ca1c92de9`）。自有人工inputs覆盖digest/descriptor/architecture/media/diff-ID/duplicate-JSON/path/symlink/overwrite错误。两个晚拒绝保留partial fake layer blob，没有完整output image，也未执行。此结果仅替代corrupt-input CLI待验状态，不提供Linux image或confinement资格。
