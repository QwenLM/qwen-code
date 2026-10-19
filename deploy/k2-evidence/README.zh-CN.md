# K2 离线安装物与冷启动软件

[English](README.md) | [简体中文](README.zh-CN.md)

本目录包含 [#13526](https://github.com/QwenLM/qwen-code/pull/13526) 的第四个软件拆分，使用节点证据拆分提供的严格 Go/Java 契约。评审流水线前，请阅读完整的[英文设计](../../docs/design/2026-10-20-k2-installation-cold-bootstrap.md)或[中文设计](../../docs/design/2026-10-20-k2-installation-cold-bootstrap.zh-CN.md)。

工具输出离线候选，不安装文件、不加载或锁定宿主策略、不重启节点、不发布镜像，也不认证物理释放。固定冷启动终点只启动空 systemd target。source/gateway 服务模板作为候选输入保留，该终点不启用这些服务。原生验收仍为 `NOT_RUN`。

## 流水线

使用 `python3 <入口> --help` 查看各 Python 入口完整的必需输入。流水线要求明确审查的字节和全新输出目录；不支持、缺失或变化的输入直接拒绝，不做 fallback。

| 入口                     | 输入与结果                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package-worker.py`      | 独立固定的 Node 22 OCI base 和预构建 worker bundle 生成未发布的 worker OCI layout。规范化 Docker gzip 层描述符而不改变字节。不构建 bundle，也不调用容器运行时。 |
| `image-catalog.py`       | 检查具体 OCI manifest、完整镜像层及创建契约，不提取或执行镜像。                                                                                                 |
| `render-pre-exec.py`     | 将 source/shim/runc ELF 字节和两个镜像目录清单绑定到固定创建契约。                                                                                              |
| `render-cold-boot.py`    | 检查精确受支持的基础 initrd、独立提取输入、静态 loader ELF 及 rootfs 依赖字节；生成加固 overlay 和冷启动契约。                                                  |
| `render-profiles.py`     | 将 pre-exec candidate、冷启动契约、target、runtime、source/gateway 配置及六个经过审查的宿主 base 绑定为完整的十一个 profile candidate。                         |
| `compile-profiles.py`    | 使用固定 feature 输入、空配置、不读缓存且不加载内核的显式固定 target parser；保留尝试和真实 stderr。成功记录描述字节生成，不证明策略执行。                      |
| `k2-assemble-artifacts`  | Go 命令依据经过审查的摘要校验 pre-exec/profile/compile 目录，并写出精确 26 个安装候选文件。其源码位于 `packages/k2-node-evidence/cmd/k2-assemble-artifacts`。   |
| `package-cold-initrd.py` | 重新校验候选和闭合安装图，再次生成并比对加固脚本字节，输出最终 initrd、rootfs payload、前提条件、固定命令行及外部清单。                                         |

冷启动生成器读取 `packages/k2-node-evidence/internal/artifactset/cold-lane.json` 共享通道。工具与该仓库布局必须一起保留。generator hash 绑定实际工具字节。最终 initrd 摘要位于自身输入图之外，避免摘要环。打包的前提条件仍需要单独审查的 immutable 安装及原生启动试验；生成清单不授予权限。

## 软件验证

在仓库根目录执行：

```sh
python3 -m unittest discover -s deploy/k2-evidence -p 'test_*.py' -v
npm run test:scripts -- scripts/tests/k2-node-evidence-workflow.test.js
```

在 `packages/k2-node-evidence` 执行：

```sh
go test -mod=readonly -count=1 ./internal/... ./cmd/k2-assemble-artifacts
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -mod=readonly ./...
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -mod=readonly ./...
```

Linux CI 额外执行 `go test -mod=readonly -count=1 ./...`，包括 cold-init 包私有操作 fake。未修改的 Linux 根包依赖 Linux source-gateway 代码，无法在 macOS 运行。arm64 构建不增加 arm64 原生启动通道。

测试使用惰性的 ELF、镜像、parser 元数据及启动 fixture，执行真实生成器/打包器子进程并验证字节、拒绝路径、helper join 顺序、短写/回读失败、权限降低及描述符继承。编译器数据测试不执行真实 AppArmor parser。没有软件测试运行真实 PID1 入口、加载锁定策略或证明原生 systemd/CSI 运行。
