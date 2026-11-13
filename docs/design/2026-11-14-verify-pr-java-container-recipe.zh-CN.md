# /verify-pr Java 容器配方

[English](2026-11-14-verify-pr-java-container-recipe.md) | [简体中文](2026-11-14-verify-pr-java-container-recipe.zh-CN.md)

**状态：提案。** 边界声明（`boundary.json`、checker 强制、记录在案的宿主豁免）随本次变更落地；下面的容器配方是它所指向的后续工作。

## 问题

`/verify-pr` 执行不可信的 PR 代码，要求与 CI 同等的隔离：无凭据的容器或 VM。skill 的本地 Docker 配方使用 `node:22-bookworm`，其中没有 JDK 也没有 Maven。因此 Java 重 PR（`packages/managed-agent-server/` 下的任何改动）的验证轮没有现成的容器路径。

实测后果：PR #16866 的连续两个本地轮次（r10、r11）把整个 Java 电池、变异矩阵和 JS 套件都跑在维护者的宿主机上——没有 `--require-isolation`、没有容器、没有豁免，两份报告也都没有边界行。仅靠文字规则没能阻止这种静默降级。本次变更让降级变得可见（checker 拒绝没有 `boundary.json` 的轮次）；本设计要消除的是降级的理由。

## 现状

- CI 的 `SDK Java` 车道（`.github/workflows/sdk-java.yml`）跑在 Temurin JDK（矩阵 `java`）、Maven `3.9.11`、作业级 Maven 仓库（`-Dmaven.repo.local`）和配置好的镜像源（`.github/scripts/configure-maven-mirror.sh`）上。按 skill「容器是车道自身运行时的活样本」规则，它就是本地配方应当采样的运行时。
- 本地 JS 配方以 `--network none` 跑 `node:22-bookworm`，配每轮一次性 bearer 模型代理，不挂载任何宿主凭据。
- 今天的本地 Java 轮次复用宿主预置的每臂 Maven 仓库（`m2repo-head`、`m2repo-prev`）以及宿主的 JDK 21 + Maven——快，但在任何边界之外。

## 目标

- Java 重本地轮次能把编译、电池和变异矩阵跑在无凭据边界内，宿主 SSH 密钥、云配置、`gh` token、模型密钥一概不可见。
- 边界能通过 `verify-pr-prepare.mjs --require-isolation`（`QWEN_VERIFY_CREDENTIAL_FREE=1`，无凭据信号）。
- 与 CI 车道运行时对齐：Temurin 21、Maven 3.9.11。

## 非目标

- 边界内不跑 MySQL/Hosted 集成层；那些门禁仍归合并后 CI 权威，与今天一致。
- 不改 CI 车道本身。
- 不做通用多语言镜像；纯 Node 轮次沿用现有配方。

## 方案

在 skill 中增加第二份配方，当增量触及 `packages/managed-agent-server/` 时选用：

1. **镜像。** `maven:3.9.11-eclipse-temurin-21`（自带车道的 Maven 与 JDK）。按 digest 钉住，与 JS 配方钉 `node:22-bookworm` 一致。
2. **离线 Maven 仓库。** 宿主（可信侧）用 PR head 的 pom 跑 `mvn dependency:go-offline` 预置每轮仓库，使用宿主正常的镜像源配置。容器只挂载该仓库目录——绝不挂 `settings.xml`（可能带镜像源凭据）——并以 `-Dmaven.repo.local=/m2 --network none` 运行。离线解析保住无凭据边界：无网络即无外泄路径，容器内也没有镜像源鉴权。
3. **可信脚本、PR 克隆、模型代理。** 与 JS 配方同一布局：脚本来自可信克隆，轮次跑在独立 PR 克隆里，任何模型驱动步骤走宿主侧 `verify-pr-model-proxy.mjs` 中继。Java 电池本身不需要模型访问。
4. **声明。** 门禁通过后轮次写入 `{"mode":"container","detail":"maven:3.9.11-eclipse-temurin-21, --network none, offline m2, credential-free"}`。

## 设计决策与理由

- **离线预置优先于受限出网。** 只放行 Maven 镜像源看似更简单，但出网白名单是第二信任面（DNS、重定向、镜像源被攻陷），且 CI 车道的镜像脚本是宿主侧配置。预置仓库加 `--network none` 复用 JS 配方已评审过的边界形状。代价：每轮一个预置步骤（分钟级；同一 PR 的轮次间在 pom 集合不变时复用仓库目录即可跨轮缓存——与 skill 对安装和构建已有的复用规则相同）。
- **自带镜像优先于 node 上加 JDK。** 在 `node:22-bookworm` 上叠 JDK 能让混合 PR 共用一个容器，但会偏离 CI 车道运行时，并增大轮次必须信任的镜像。混合轮次可以在 Java 镜像里跑 JS 套件（经钉住的安装带上 Node），或跑两个容器；该选择留给实现。

## 约束

- 容器看不到任何宿主凭据；挂载的仓库只有依赖 jar。
- `--require-isolation` 必须在内部 exit 0；仅有容器标记不算通过（既有规则）。
- 预置步骤在宿主上以维护者正常的 Maven 配置运行，属可信操作；不得执行 PR 代码（只做解析）。

## 风险

- **预置不全。** `dependency:go-offline` 会漏掉懒解析的插件，离线构建随后在轮次中途失败。缓解：大声失败、从失败模块重新预置，未解决前把缺口记入 _Not covered_——绝不静默回退宿主执行。
- **仓库复用陈旧。** 为别的 head 构建的复用仓库可能掩盖依赖变化。缓解：适用 skill 既有的「为此 head 构建」复用规则；以 pom diff 判定。
- **镜像漂移。** digest 钉住加文档化的刷新步骤，与 JS 配方一致。

## 验证计划

- 一个真实 Java 重轮次（某个 `managed-agent-server` PR）在配方内跑编译 + 电池 + 至少一条变异；门禁 exit 0，`boundary.json` 记录 container 模式。
- A/B 一致性：同一电池在同一 head 上的计数与宿主运行一致（配方改变的是边界，不是测量）。
- 负对照：边界之外 `--require-isolation` 仍 exit 4。

## 验收标准

- skill 携带 Java 配方，与 JS 配方同样的可信克隆 / PR 克隆 / 代理布局。
- Java 轮次能在不于宿主执行任何 PR 代码的情况下完成，报告的 `**Boundary.**` 行写明镜像与网络策略。
- 豁免路径对无法使用配方的轮次（如依赖数据库的复现）仍然可用且记录在案。

## 开放问题

- Java + JS 混合轮次：一个装好 Node 的容器，还是共享产物目录的两个容器？
- 预置步骤归 `verify-pr-prepare.mjs`（宿主侧）还是单独的配方脚本？
