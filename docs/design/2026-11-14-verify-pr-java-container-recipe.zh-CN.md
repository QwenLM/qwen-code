# /verify-pr Java 容器配方

[English](2026-11-14-verify-pr-java-container-recipe.md) | [简体中文](2026-11-14-verify-pr-java-container-recipe.zh-CN.md)

**状态：提案。** 边界声明（`boundary.json`、checker 强制、记录在案的宿主豁免）随本次变更落地；下面的容器配方是它所指向的后续工作。

## 问题

`/verify-pr` 执行不可信的 PR 代码，要求与 CI 同等的隔离：无凭据的容器或 VM。skill 的本地 Docker 配方使用 `node:22-bookworm`，其中没有 JDK 也没有 Maven。因此 Java 重 PR（`packages/managed-agent-server/` 下的任何改动）的验证轮在本地配方里没有现成的容器。沙箱化 CI 车道已为触及 `packages/sdk-java/` 或 `packages/managed-agent-server/` 的 diff 准备 Temurin JDK 21 + Maven 3.9.11；缺的是本地路径。

实测后果：PR #16866 的连续两个本地轮次（r10、r11）把整个 Java 电池、变异矩阵和 JS 套件都跑在维护者的宿主机上——没有 `--require-isolation`、没有容器、没有豁免，两份报告也都没有边界行。仅靠文字规则没能阻止这种静默降级。本次变更让降级变得可见（checker 拒绝没有 `boundary.json` 的轮次）；本设计要消除的是降级的理由。

## 现状

- CI 的 `SDK Java` 车道（`.github/workflows/sdk-java.yml`）跑在 Temurin JDK（矩阵 `java`）、Maven `3.9.11`、作业级 Maven 仓库（`-Dmaven.repo.local`）和配置好的镜像源（`.github/scripts/configure-maven-mirror.sh`）上。按 skill「容器是车道自身运行时的活样本」规则，它就是本地配方应当采样的运行时。
- 本地 JS 配方跑 `node:22-bookworm`，不挂载任何宿主凭据，经 Docker 网桥访问宿主侧每轮一次性 bearer 模型代理；其边界是无凭据，而非离线。
- 今天的本地 Java 轮次复用宿主预置的每臂 Maven 仓库（`m2repo-head`、`m2repo-prev`）以及宿主的 JDK 21 + Maven——快，但在任何边界之外。这些宿主预置目录**不是**本配方的合法种子：它们由 PR 代码在维护者机器上填充，因此配方用自己的 `m2repo-sbx-<arm>` 命名，并要求首次边界预置前先移除这些旧目录。

## 目标

- Java 重本地轮次能把编译、电池和变异矩阵跑在无凭据边界内，宿主 SSH 密钥、云配置、`gh` token、模型密钥一概不可见。
- 选择可选预置溯源门禁时，门禁必须通过 `verify-pr-prepare.mjs --require-isolation`（`QWEN_VERIFY_CREDENTIAL_FREE=1`，无凭据信号）。明确选择无门禁预置时，则记录 `gate: null` 与操作者或实测启动器的具体边界事实，这些观测本身并不是边界证明。无论选择哪条预置路径，都必须在任何 PR 插件或预置执行之前完成 step 4 的宿主/VM 执行批准。
- 与车道的**一个**单元格对齐——Linux Java 21 腿（Temurin 21、Maven 3.9.11）。车道在同一作业上跑五个 JDK/OS 单元格（Ubuntu 的 Java 11/17/21 加 macOS/Windows 的 21）；17 与 11 腿不在电池范围内，记入 _Not covered_，除非增量触及 SDK 基线（`qwencode` SDK 钉在 Java 11）。电池镜像的 `maven-compiler`/surefire target 在轮次报告中写明。

## 非目标

- 边界内不跑 MySQL/Hosted 集成层；那些门禁仍归合并后 CI 权威，与今天一致。
- 不改 CI 车道本身。
- 不做通用多语言镜像；纯 Node 轮次沿用现有配方。

## 方案

在 skill 中增加第二份配方，当增量触及 `packages/sdk-java/` 或 `packages/managed-agent-server/` 时选用——这两条路径承载 Java 源码。CI 车道的 Java 门（`managed-agent-gate-scope.mjs`）匹配更广的集合：它还对 `packages/cli/src/serve/`、`packages/core/src/managed-runtime/`、hosted 集成助手与 e2e 脚本触发——这些能在不触及 Java 源码的情况下破坏 Managed Agent 套件。仅落在这些更广路径上的增量沿用 JS 配方，Java tier 留给 CI——本配方不声称镜像该门的完整触发集：

1. **镜像。** 自带车道 Maven 与 JDK 的 Maven 镜像，如 `maven:3.9.11-eclipse-temurin-21`。实现时核实确切 tag 存在并按 digest 钉住（JS 配方按 tag 引用 `node:22-bookworm`；Java 配方应更严）。**预置/门禁**镜像仅在运行可选的预置溯源门禁时，还须自带 digest 钉住的 Node：隔离门禁是 Node 程序（`node /trusted-scripts/verify-pr-prepare.mjs --require-isolation --artifact-dir …`），原版 Maven 镜像不带 Node（R16-6）。waived 声明的发布不需要这份记录，该 Node 要求只属于可选预置门禁。预置与门禁在这同一个 Maven+JDK+Node 镜像内运行（可信脚本挂 `/trusted-scripts`），使门禁的 `observed`/`credentialFree` 佐证的正是执行 PR Maven 代码的那个容器。离线**电池**镜像仍是原版 Maven+JDK（电池不需要 Node）；「不做 Java+Node 衍生镜像」的非目标针对电池镜像，而非预置/门禁镜像。若模型 turn 跑在独立的 `node:22-bookworm` 容器，该容器需自己的无凭据边界，但不为 waived 发布增加电池门禁记录。**nonce 绑定（R16-1，#17371）。** 产生容器门禁记录时，它只携带 `nonceSha256`；明文存于门禁容器的 `$HOME/.qwen-verify-nonce`，checker 只读**一份**记录与**一个**哈希，除非轮日志有一行 `container-nonce:` 其 sha256 与之匹配，否则拒绝 `mode:"container"`。每容器门禁记录只是 `checkBoundary` 证据——并不使 nonce 绑定成倍增加。`container-nonce:` 行只有 `mode:"container"` 声明才需要。这里的离线电池使用 prepare 的 `waived` 声明，因此既不为发布 echo container nonce，也不另造门禁记录。若电池不能跑在门禁容器内，必须在任何预置、模型 turn 或电池执行 PR 代码之前完成 step 4 的宿主批准；不得先预置再补授权。门禁容器的佐证不能替代电池记录在案的边界（R3-6）。
2. **离线 Maven 仓库，在边界内预置。** 宿主侧不对 PR 的 pom 跑任何 Maven goal：`mvn install` 会走完整默认生命周期，PR 绑定到 `compile`/`test` 的插件执行会在维护者机器上运行——下面的剥离清单覆盖的是项目模型期扩展，覆盖不到绑定生命周期的 `<build><plugins>` 执行。正确做法：宿主准备净化副本（剥离清单见下），**预置在凭证隔离、仅允许配置镜像出网的容器内运行**，产出的仓库拷贝出来。仅镜像出网是强制的，不是假设：预置的 settings 用 `<mirrorOf>*</mirrorOf>`（车道的 `<mirrorOf>central</mirrorOf>` 不会重定向 pom 声明的 `<repositories>` 条目），剥离清单从每个 pom 移除 `<repositories>`/`<pluginRepositories>`，预置容器的出网由宿主防火墙规则在 iptables `DOCKER-USER`（FORWARD）链**与**网桥接口的 INPUT 链规则共同限制到配置镜像，镜像经一个**默认拒绝、仅白名单镜像一个目的地**的 sidecar/正向代理可达。内部专用预置网络（`docker network create --internal`）单独**不够**：`--internal` 丢弃 FORWARD（出子网）流量，但从预置到宿主在该子网上的网桥网关地址的包经 INPUT 本地投递、由宿主服务应答——故方案 A 仍需 INPUT 链规则挡住宿主侧监听（含绑定网桥网关时的宿主侧模型代理）。`DOCKER-USER` 只过滤 FORWARD，单独用它挡不住预置访问宿主自身的服务。Docker 本身没有出网白名单能力，Maven settings 也约束不了在项目生命周期内执行的代码，所以围堵必须点名真正执行它的那一层、覆盖两个方向，且 sidecar 不能是无白名单的开放 CONNECT 转发器（无白名单=可达一切）。预置**先**安装车道与消费方实际使用的那一个 SDK 模块 `packages/sdk-java/qwencode`（对该模块的 pom 跑 `mvn install -DskipTests -Dgpg.skip=true -Dmaven.javadoc.skip=true`，与 CI 车道在自己作业边界内所做一致；`packages/sdk-java` 没有根 reactor，managed-agent 构建只解析 `qwencode-sdk`），**然后**对消费方 pom 跑 `mvn dependency:go-offline`：managed-agent 构建从本地仓库解析 SDK，新预置缺了就无法解析，go-offline 必须看到已安装的 jar，复用预置里陈旧的则会对着错误的 jar 编译。复用键在本配方各处是同一条规则：**仅当 pom 集合、SDK 源码、臂（head 对 base）与「在边界内预置」的溯源均未变化时才复用预置仓库**；任一变化即重新预置，与 skill 对安装和构建适用的「为此 head 构建」复用规则相同，且重新预置从**空的** `m2repo-sbx-<arm>` 目录开始——往旧目录里预置会让更早 head 的 artifact 仍可解析，离线电池可能在新种子会失败的地方通过。配方用**自己的**目录名 `m2repo-sbx-head` 与 `m2repo-sbx-base`，区别于配方前的宿主预置 `m2repo-head`/`m2repo-prev`：宿主预置目录不是合法种子（由 PR 代码在维护者机器上填充），首次边界预置前必须移除；每个边界种子写一个 `seed.json` 标记，没有该标记的目录视为不存在。运行了可选预置门禁时，标记记录 `credentialFree: true`，且 `gate` 含有**该次**预置运行完整的 `boundary-gate.json` 对象；不得复制更早种子或另一臂的门禁输出，仅仅为了让这个字段存在。未运行门禁时，标记改为记录显式的无门禁值和操作者或实测启动器实际观察到的事实，例如 `{"credentialFree":true,"gate":null,"attestation":{"container":"<image@digest>","boundary":"<operator/measured-launcher observation>","mirror":"<mirror and enforced allowlist>"}}`。只有这些观察支撑无凭据声明时，无门禁种子才可写 `credentialFree: true`，否则它不是合法的边界种子。这种操作者／实测启动器佐证只记录容器、标记或启动器测量及镜像围堵，不是容器边界的证明；门禁可选不等于可以无条件宣称 credential-free。两种形式都只描述预置容器；发布使用 step 4 由 prepare 生成的 `waived` 声明，不要求独立离线电池提供 container nonce 或门禁记录。head 种子装 head 的 SDK jar，base 种子装 base 的，各自从该侧的净化副本构建；共用一个种子会让可信 base 臂解析到 head 构建的 jar，掩盖 jar 携带的任何回归。`.mvn/` 刻意**不**作复用键维度：剥离清单总是移除它，`.mvn/` 变化影响不到种子；编辑 `.mvn/` 的 PR 拿到的种子 jar 不带该配置，轮次记录这一偏差，而不是重新预置出字节相同的产物。按车道的 Maven 3.9.11 默认行为预置——**不要**传 `-Dmaven.legacyLocalRepo=true`：Maven 3.9 拒绝该标志。种子的 `_remote.repositories` 溯源标记记录每个 artifact 由哪个镜像服务；拷出仅限种子自己的 SDK 安装与 `dependency:go-offline` 写入的路径（仓库树的前后清单），对照解析树核验，且清单记录每个 artifact 的服务镜像，使溯源在下一步之后仍在：拷出随后**剥掉** `_remote.repositories` 标记，**并**剥掉车道同样清理的可变解析器状态——`*.lastUpdated`、`resolver-status.properties`、`maven-metadata-*.xml*`、`*.part`、`*.part.lock`、`*.tmp`——使一次漏查不会作为负缓存条目混入电池、压制重新解析（清单把它们记为已排除）。拷出与拷入一样**不解引用符号链接**（`docker cp` 原样复制链接）：PR 插件可能把 jar 留成指向宿主绝对路径（`/root/.ssh/id_rsa`）的符号链接，宿主上后续任何解引用步骤会把凭据内容写进产物树——因此拷出对照解析树核验时**不跟随逃出树外的链接**，任何逃逸符号链接一律拒绝。电池不挂任何 `settings.xml`，种子的镜像 id 在那里没有对应物；留着标记会让离线解析拒绝那些「记录中的仓库不在电池配置里」的 artifact。残余风险如实写明而非隐藏：预置期间执行的 PR 构建插件仍可能在种子容器内把伪造 jar 装到真实依赖坐标上，清单无法归属作者——围堵靠仅镜像出网加 base 臂的独立种子，而不是「每个 jar 都来自镜像」的证明。电池容器**只读**挂载本臂的预置仓库——绝不挂 `settings.xml`（可能带镜像源凭据）——并以 `-o -Dmaven.repo.local=/m2 --network none` 运行——比 JS 配方更严（JS 配方为模型代理保留网络），因为 Java 电池不需要模型访问。`-o`（离线）标志才是把种子缺口变成「点名坐标的解析错误」（「无法在模块 Y 解析 X——重新预置」）的开关；`--network none` 只是围堵，不是离线开关，缺 `-o` 时漏查的 artifact 会以传输噪音加只读写失败警告的形式出现。必须写入的行（安装变异 SDK jar 的变异）拿自己的仓库副本与自己的 `-Dmaven.repo.local`，正如 skill 的变异规则已要求；写入轮次使复用键失效，共享种子因此永远不会持有变异 jar。离线解析保住无凭据边界：无网络即无外泄路径，容器内也没有镜像源鉴权。
3. **可信脚本、PR 克隆、模型代理。** 与 JS 配方同一布局：脚本来自可信克隆，轮次跑在独立 PR 克隆里，任何模型驱动步骤走宿主侧 `verify-pr-model-proxy.mjs` 中继。离线电池容器够不到该代理，因此轮次自己的模型 turn 跑在另一个接代理的容器里（JS 配方的形状），或者不跑；电池本身不需要模型访问。各容器由**运营方持有的宿主机中继**驱动：宿主代表轮次对电池容器跑 `docker exec` 并回传输出。中继的契约固定在运营方一侧，绝不取自请求：容器名与所有标志来自中继自己的配置；命令以 argv 数组传递，中继与 `docker exec` 之间没有 shell；点名其他容器或携带 `--privileged`、`--pid`、`--net`、`--volume`、`--user` 的请求一律拒绝；监听器绑定网桥/回环地址并带每轮一次性 token。（或者由运营方直接手敲 `docker exec` 行，这把 socket 留在可信侧。）轮次永远拿不到 Docker socket——那会把宿主 root 交给不可信 PR 代码，而 `--require-isolation` 仍 exit 0（门禁检查环境与凭据信号，不检查 socket）。
4. **预置前执行批准。** 在 step 2 执行任何 PR 编写的插件、扩展或预置之前，先授权独立离线电池真正能记录的 execution。以 PR clone 为 cwd 运行可信 prepare，完整写出当前坐标，例如：`node <trusted-clone>/scripts/verify-pr-prepare.mjs <n> --repo <owner>/<repo> --execution host --round <r> --reason <text> --context-out <host snapshot> (--trust-pr-head | --approval <url> --state-root "<trusted-dir>")`。`<r>` 是本轮正整数轮次号；从 container 改为 host 时保留现有 in-flight 注册，不得仅为再次 prepare 而 release。local-trust 用 `--trust-pr-head` 且不带 state root；他人 fork 则先注册当前 head/round，由维护者评论标记携带该 current registration 的 nonce，prepare 在 watch-state 锁内复核。`--approval` 与 `--state-root` 必须一起给出，之后的 `--complete`（或真正放弃轮次时的 `--release`）沿用同一可信 root，并通过 `--registration-nonce <nonce>` 重复同一 start 的 nonce。预置门禁不是运行独立电池的授权；批准失败时不得运行任何 PR 插件、预置或电池。
5. **声明。** 可选预置门禁（`--require-isolation --artifact-dir <round-dir>`）可在预置容器写下 `boundary-gate.json` 溯源记录，但 `boundary.json` 已由 step 4 的 prepare 生成。离线电池读不到预置容器的 `$HOME/.qwen-verify-nonce`，本配方保留 prepare 的 `waived` executionApproval，不声明 `mode:"container"`，发布也不要求电池的 `container-nonce:` 行或电池门禁记录（R4-2）。门禁检查后不得把已批准声明重写成 container，也不得在门禁或电池后手写豁免。watch 重验证在切换模式时保留同一注册，评论批准点名该注册的 nonce，并在同一注册上执行 `--complete`。

   prepare 的 `--reason` 必须点名轮次用到的**每一个**容器——包括预置容器，它是唯一有出网、且 PR 编写的 Maven 插件在其中执行的那个：预置容器（仅镜像出网）、离线电池容器，以及轮次用模型时跑模型 turn 的接代理容器，各带镜像与网络策略。例如：`--reason 'Java battery cannot echo the seed gate nonce; seed: maven:3.9.11-eclipse-temurin-21, mirror-only egress; battery: same image, --network none, offline m2; model turns: node:22-bookworm via host proxy; credential-free'`。没有模型 turn 的轮次也要点名预置与电池两个容器。不得另外添加 `detail` 字段或编辑 prepare 写出的声明：发布时 checker 会把它与宿主持有的 `executionApproval` 深度对账，而后者没有该字段。

## 设计决策与理由

- **预置在边界内，电池离线。** 预置需要镜像，因此跑在仅允许镜像出网的无凭据容器里——出网白名单是第二信任面（DNS、重定向、镜像源被攻陷），所以只限于预置阶段；电池本身对拷出的仓库以 `--network none` 运行。宿主绝不对 PR pom 跑 goal：绑定生命周期的插件执行也是 PR 代码，任何剥离清单都无法穷举。代价：每轮每臂一个预置步骤（分钟级；同一 PR 的轮次间在 pom 集合与 SDK 源码均未变化时复用该臂的仓库目录即可跨轮缓存——与 skill 对安装和构建已有的复用规则相同）。
- **自带镜像优先于 node 上加 JDK。** 在 `node:22-bookworm` 上叠 JDK 能让混合 PR 共用一个容器，但会偏离 CI 车道运行时，并增大轮次必须信任的镜像。离线**电池**镜像仍是原版 Maven+JDK（跑电池不需要 Node），通用 Java+Node 电池衍生镜像是声明的非目标；混合轮次在 JS 配方的容器里跑 JS 套件、在本容器里跑 Java 电池，经宿主共享产物目录。**预置/门禁**镜像只在**明确选择运行预置门禁**时才需要内置 digest 钉住的 Node，使基于 Node 的隔离门禁能在预置 PR Maven 代码的同一容器内运行（R16-6）。明确选择无门禁预置时，普通 Maven+JDK 镜像已经足够；离线电池本身不需要任何 Node 衍生镜像。不能因为存在可选门禁，就把它重新理解为所有镜像的强制要求。

## 约束

- 容器看不到任何宿主凭据；共享预置仓库只有依赖 jar，只读挂载——写入行用自己的副本（见第 2 步），共享种子因此永远不会持有轮次安装的产物。
- 明确选择预置门禁时，`--require-isolation` 必须在内部 exit 0；仅有容器标记不算通过（既有规则）。明确无门禁预置时则记录 `gate: null` 与操作者或启动器实测的边界事实，不宣称已经运行或通过了门禁。
- 宿主侧不执行任何 PR 代码——连「只做解析」也不行：宿主只准备净化副本、拷出仓库，对 PR pom 的每个 Maven goal 都在预置容器内运行。净化副本**不解引用符号链接**（`cp -a` / `rsync -a`，绝不用 `-L`），目标逃出树外的符号链接一律拒绝：解引用副本会把宿主文件内容写进随后挂载进容器、且内含 PR 编写 Maven 代码的树。副本移除**整个 `.mvn/` 目录**：启动器会加载核心扩展、`jvm.config`（在 JVM 启动前拼进 `MAVEN_OPTS`——里面的 `-javaagent:` 会在预置期间运行）与 `maven.config`。同时处理在预置模型中**有效**的 pom 声明构建扩展（`<build><extensions>`，以及不在非激活 profile 内、带 `<extensions>true</extensions>` 的 `<build><plugins>` 中的 `<plugin>`）。拒绝只限定有效扩展：本配方要安装的 SDK pom（`packages/sdk-java/qwencode/pom.xml`）在其激活 build 里声明了 `central-publishing-maven-plugin` 带 `<extensions>true</extensions>`，车道能成功加载它，一刀切拒绝会拒掉配方赖以存在的那个 pom。由于预置跑在无凭据、仅镜像出网的容器内——模型扩展在那里受到的围堵与配方已接受的绑定生命周期执行完全相同——有效扩展**记入拷出清单**而非直接拒绝；只有会指向任意主机的扩展（与被剥离的 `<repositories>`/`<pluginRepositories>` 结合）才拒绝。净化器是分区段感知的：`packages/managed-agent-server/pom.xml` 在非激活的 `central-release` profile 里声明同一插件，它无效，保持不动。绑定生命周期的 `<build><plugins>` 执行无法穷举，这正是预置必须在边界内而非宿主上运行的原因。可信镜像配置留在宿主侧；预置容器拿到的是带 `<mirrorOf>*</mirrorOf>` 的无凭据镜像配置，绝不是宿主的 `settings.xml`。

## 风险

- **预置不全。** `dependency:go-offline` 会漏掉懒解析的插件，离线构建随后在轮次中途失败。缓解：大声失败、从失败模块重新预置，未解决前把缺口记入 _Not covered_——绝不静默回退宿主执行。
- **仓库复用陈旧。** 为别的 head 构建的复用仓库可能掩盖依赖变化，陈旧的 SDK jar 会对着错误的代码编译。缓解：适用 skill 既有的「为此 head 构建」复用规则，并以上面唯一的复用键判定——pom 集合、SDK 源码与臂必须均匹配；任一变化即重新预置，写入轮次直接使复用键失效。base 臂绝不解析 head 种子。
- **种子溯源。** 预置期间运行的 PR 构建插件可能把伪造 jar 装到真实依赖坐标上；拷出清单限制了离开种子的内容，但无法归属作者。缓解：仅镜像出网、base 臂的独立种子，并把残余风险记入 _Not covered_——绝不声称每个 jar 都来自镜像。
- **镜像漂移。** digest 钉住加文档化的刷新步骤。

## 验证计划

- 一个真实 Java 重轮次（某个 `managed-agent-server` PR）在首次预置之前成功运行 step 4 的 prepare，再在配方内跑编译 + 电池 + 至少一条变异。`boundary.json` 保留 prepare 生成、与宿主 context 一致的 `waived` executionApproval；任何预置门禁退出码/记录都只是预置溯源，独立离线电池不声明 `mode:"container"`，也不要求再产出 container nonce 或门禁记录。
- A/B 一致性：同一电池在同一 head 上的计数与基线运行一致（配方改变的是边界，不是测量）。宿主基线本身是一个记录了维护者批准的 `waived` 轮次——checker 拒绝宿主执行的任何其他模式——或者基线也在边界内跑。
- 负对照：边界之外 `--require-isolation` 仍 exit 4。
- 负对照（预置）：一个夹具 pom，其构建扩展在被加载时写标记文件；另一个夹具，其绑定到 `compile` 的 `<build><plugins>` 执行写标记文件。净化副本以**拷入**（`docker cp`）而非绑定挂载进入预置容器，因此边界内的写入留在容器里。每个夹具有**各自的**预期结果，因为剥离清单能移除构建扩展、却刻意移除不了绑定生命周期的执行：
  - 构建扩展夹具：先跑**未净化**副本，断言正向见证（标记在容器内存在、宿主副本上没有——写入路径触发了且拷入围住了它）；再跑净化副本，断言容器内**没有**标记——剥离移除了触发器。
  - 绑定生命周期 `<build><plugins>` 夹具：标记在**两个**阶段都存在于预置容器内（该执行无法被剥离）、且两个阶段宿主副本上都没有——这是边界围堵的正向对照，不是剥离清单的对照。对这个夹具断言「容器内没有标记」在设计上不可满足。
- 正向对照（净化器）：两个真实仓库 pom——`packages/sdk-java/qwencode/pom.xml`（激活扩展）与 `packages/managed-agent-server/pom.xml`（非激活 profile 扩展）——通过净化器并成功预置，证明拒绝只限定有效扩展、不会拒掉配方赖以存在的 pom。

## 验收标准

- skill 携带 Java 配方，与 JS 配方同样的可信克隆 / PR 克隆 / 代理布局。
- Java 轮次能在不于宿主执行任何 PR 代码的情况下完成，报告的 `**Boundary.**` 行点名轮次用过的每个容器，各带镜像与网络策略。
- 由 prepare 生成并记录的豁免路径对无法使用配方的轮次（如依赖数据库的复现）仍然可用且记录在案。

## 开放问题

- 预置步骤归 `verify-pr-prepare.mjs`（宿主侧）还是单独的配方脚本？
