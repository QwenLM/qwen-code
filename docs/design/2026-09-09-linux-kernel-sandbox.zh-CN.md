# Linux 内核沙箱（bwrap + landlock-run）设计

[English](2026-09-09-linux-kernel-sandbox.md) | [简体中文](2026-09-09-linux-kernel-sandbox.zh-CN.md)

内部设计文档，目标是让 qwen-code 在没有容器运行时的 Linux 主机上获得内核级隔离
——弥补今天的空白：Linux 上的 `--sandbox` 实际含义是"docker/podman，或者什么都
没有"，而 `QWEN_SANDBOX=false` 是整个集成测试矩阵的默认值，因此绝大多数 Linux
用户在完全没有 OS 级约束的情况下运行 agent。

各项参照点已于 2026-09-09 对照本仓库源码，以及三个同类 agent（Codex CLI、
Claude Code、DeepSeek Harness）的公开源码逐一核实；见 § 证据。

## Phase 0 —— 已核实的现状

| 事实                                                                       | 证据                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 沙箱是整个 CLI 的重新 exec（"hop"），从不是按命令粒度                      | `packages/cli/src/llm.tsx:573-727` 依次调用 `loadSandboxConfig` → `start_sandbox` → `process.exit(0)` |
| 今天的后端只有 `docker`、`podman`、`sandbox-exec`                          | `packages/cli/src/config/sandboxConfig.ts:25-29`（`VALID_SANDBOX_COMMANDS`）                          |
| 在 Linux 上，只有显式启用沙箱时容器后端才会成为候选                        | `sandboxConfig.ts:172-174` —— `sandbox === true` 才会 push docker/podman                              |
| 仓库中不存在任何 landlock/seccomp/bwrap/unshare 隔离实现                   | 对 `packages/**/*.ts` 的 grep —— 只有无关的偶然命中                                                   |
| macOS Seatbelt：6 个内置 `.sb` profile，`(allow default)` + 禁写白名单姿态 | `packages/cli/src/serve/sandbox-macos-*.sb`；`sandbox.ts:70-77`（`BUILTIN_SEATBELT_PROFILES`）        |
| `start_sandbox` 的 sandbox-exec 分支是任何原地后端的结构模板               | `packages/cli/src/serve/sandbox.ts:229-389`                                                           |
| `SANDBOX` 环境变量标记"已在沙箱内"，被 UI/警告/预连接逻辑消费              | `sandboxConfig.ts:116`、`headlessSafetyWarnings.ts:43`、`systemInfo.ts:141`                           |
| `SandboxConfig.image` 目前对每个 command 都是必填                          | `packages/core/src/config/config.ts:776-779`、`sandboxConfig.ts:233`                                  |
| 更新后重启的环境交接按 `command !== 'sandbox-exec'` 分支（容器 vs 非容器） | `packages/cli/src/llm.tsx:578-595`                                                                    |
| vendor 平台二进制直接提交进 git，并通过 `files: [dist, vendor, ...]` 分发  | `packages/core/vendor/ripgrep/<arch>-<platform>/rg`、`git ls-files packages/core/vendor/`             |
| 集成测试矩阵的默认值是 `QWEN_SANDBOX=false`                                | 根 `package.json:57,61,64`（`test:integration:*:sandbox:none`）                                       |

对照项事实（对照 Codex CLI 源码、dsh 源码与 Claude Code 二进制证据核实；细节见
§ 证据）：

- Codex：`seccompiler` + `landlock` crate + vendored bubblewrap；Seatbelt
  `.sbpl` 采用 `(deny default)`；两个原生 Windows 沙箱后端；`codex sandbox`
  一等子命令；`SandboxPolicy` 各变体自带 `network_access`。
- dsh：优先 bwrap，回退到自写的 299 行 C11 `landlock-run`（musl 静态链接、
  先自我约束再 exec、fail-closed、报告 `full`/`partial` 强制等级、启动器失败
  退出码 125 的契约）；以平台可选 npm 包形式分发。
- Claude Code：Linux 上在无容器运行时的情况下使用 bwrap + seccomp；
  `CLAUDE_CODE_FORCE_SANDBOX`；`--no-sandbox` 本身被其自动模式规则挡住。

## 目标 / 非目标

**目标**

1. 一种 Linux 约束方案，**不需要 root、不需要守护进程、不需要镜像、不需要在
   消费端主机上有编译器**——可用于 rootless CI、共享构建机与精简容器。
2. 接入既有的 hop 架构（`loadSandboxConfig` → `start_sandbox`），并提供与
   macOS Seatbelt 路径已暴露的可写根语义一致的语义。
3. 凡显式请求过沙箱的地方一律 fail-closed；凡未显式请求的地方诚实报告强制
   等级（`full` / `partial` / `none`）。
4. 以可审查的增量交付：先显式启用，最后才翻默认值。

**非目标**

- 不引入 Starlark 式策略语言（既有的 tree-sitter AST + 规则层是命令决策平面，
  本设计是隔离平面）。
- 不内置 MITM 网络代理（Codex 那个五位数行数的 network-proxy）。既有的
  `QWEN_SANDBOX_PROXY_COMMAND` 钩子仍然是走代理的方案。
- 不做 Windows 原生沙箱（那是独立且更大的投入；真要做时以 dsh 的
  ACL/受限令牌设计为参照）。
- v1 不做按命令粒度的约束（见 D2）。
- 不改动 macOS Seatbelt profile，也不改动容器后端。

## 设计决策

### D1 —— 两个 Linux 后端：优先系统 `bwrap`，vendored `landlock-run` 作为回退

**决策。** 新增两个 sandbox command：

- `bwrap` —— 使用主机上的 bubblewrap（各主流发行版仓库里都有）。探测是
  **功能性**的：真的跑一次最小约束下的 `true`，而不是 `--version`（在
  `kernel.unprivileged_userns_clone=0` 或某个 LSM 拒绝 `mount` 的机器上，
  装了 bwrap 一样会失败）。
- `landlock` —— 使用 vendored 的 `qwen-landlock-run` 辅助程序：约 300 行 C11，
  直接面向 Landlock 原始 UAPI，用 musl 静态链接，按架构提交在
  `packages/core/vendor/landlock-run/` 下。Landlock 是一个独立的 syscall 家族，
  既不需要 user namespace 也不需要 mount 权限，因此恰好能在 bwrap 不能用的
  地方工作。

**为何是这个形态。** Node 无法像 Codex 的 Rust 那样链接 seccomp/Landlock 库；
约束必须由我们 spawn 出来的可执行文件施加。dsh 已经证明"回退辅助程序"这一模式
成本很低（299 行、单文件、除 musl 外零依赖库），且无需在消费端主机上编译即可
分发。

**为何 bwrap 优先。** 不需要新增任何要分发的字节，而且 `--ro-bind / /` 用一个
flag 就给出一个只读的主机根，再按目录覆盖出可写点。它还能 unshare PID 与
network 命名空间；这里只用到 network 那一个——D6 解释为什么不动 PID 命名空间。

### D2 —— hop 粒度（与 Seatbelt 分支一致），而不是按命令粒度

**决策。** 新后端在 `start_sandbox` 中包裹整个 CLI 的重新 exec，与今天的
`sandbox-exec` 完全一样。按命令粒度的约束（像 Codex/dsh 那样包裹每一次
`run_shell_command` spawn）明确延后。

**理由。** hop 只需要动 `sandboxConfig.ts`、`sandbox.ts`、`config.ts`（类型）、
`llm.tsx`（交接分支）与 `systemInfo.ts`。按命令粒度的约束则需要一条贯穿 core
工具调度器的策略载体、按调用的网络决策（LLM 客户端必须保持不受约束——这正是
我们的 Seatbelt `proxied` profile 存在的原因），以及一整套拒绝-升级的交互。
那是另一份设计；hop 用约 10% 的手术量拿到约 90% 的保护（agent 执行的命令无法
逃出工作区）。

**已接受的代价 —— 拒绝的可见性。** hop 约束的是整个进程，因此一次被拒的写入
到达模型时，只是 `run_shell_command` 抛出的一个裸 `EROFS`/`EACCES`，没有任何
东西标明它是一次**策略**拒绝。dsh 记录过由此产生的失效模式："一次没有升级路径
的拒绝是终局性的——模型只能放弃，而这会把操作者逼到全局配置
`danger-full-access`，从而彻底废掉沙箱。"拒绝标记加一次性升级，恰恰是按命令
粒度约束才能买到的东西，所以 v1 只做缓解而非解决——而这个缓解是对既有机制的
一次改动：

`core/src/core/prompts.ts:406-427` 已经按 `process.env['SANDBOX']` 给系统提示
分支：`'sandbox-exec'` 给出 "# macOS Seatbelt" 段落，其他任何非空值给出
"# Sandbox" 段落，未设置则给出 "# Outside of Sandbox"。两个后果：

- 不改的话，`SANDBOX=bwrap` 会落进通用分支，模型被告知自己"运行在一个沙箱
  **容器**里"——这是错的，而且那段文字点的是 `Operation not permitted`，而
  bwrap 的拒绝读作 `Read-only file system`。
- 加一个小分支后，边界就变得准确且自描述：点明后端、可写根、`EROFS`/`EACCES`
  两种写法，并指示模型把疑似约束拒绝上报给用户，而不是绕道解决。

该分支是 P0 的工作项（见 § Phase P0），不是后续跟进项。

### D3 —— vendored 二进制提交进 git，并配一道可复现性 CI 关卡

**决策。** `qwen-landlock-run` 二进制位于
`packages/core/vendor/landlock-run/{x64,arm64}-linux/qwen-landlock-run`，提交进
git——沿用既有的 ripgrep/tree-sitter 先例（`git ls-files packages/core/vendor/`）。
C 源码就放在旁边 `packages/core/vendor/landlock-run/src/qwen-landlock-run.c`，
配 `scripts/build_landlock_run.mjs`（`musl-gcc -static -O2`）。一个 CI job 在
两种架构上从源码重建，若与已提交的字节不一致则失败。

**考虑过的替代方案。**

- _平台可选 npm 包（dsh 的模式）_ —— 供应链更干净，但要多养一条发布流水线；
  qwen-code 已经为 ripgrep 付了"提交二进制"的成本，所以一套机制覆盖两者。
  如果 vendored 集合继续变大，再重新评估。
- _安装时编译_ —— 否决（dsh 的原话："一个只在恰好装了编译器的地方才存在的
  回退，不算回退"；而且我们的 `postinstall` 已经为 ripgrep 承担关键职责，
  必须保持快速）。
- _提交二进制但不加重建关卡_ —— 否决：无法验证的 blob 就是无法审查的 diff；
  重建并比对的 CI job 是让 ripgrep 式分发保持诚实的折中。

### D4 —— 强制等级的诚实性：`full` / `partial` / `none` 只报告，从不承诺

**决策。**

- 每个后端探测都报告一个强制等级：bwrap ⇒ 按构造即 `full`（功能性探测已经
  真实演练过 mount 命名空间与 bind 挂载）；landlock ⇒ 由内核 ABI 协商决定
  `full` 或 `partial`（旧 ABI 无法治理新的访问位——例如 ABI 3 之前的
  `truncate`）；容器 ⇒ `full`（其边界是运行时自己的问题）。
- 显式请求的沙箱（`--sandbox`/`QWEN_SANDBOX` 指名某个 command，或 `=true`）
  若探测失败 ⇒ `FatalSandboxError`（既有行为，保留）。**对显式请求而言，
  静默地无约束通过永远不合法。**
- 隐式缺席（Linux，未请求沙箱）⇒ 无约束运行。不为此新增任何 UI 面：
  `getSandboxEnv()` 已经会回答 `no sandbox`（`systemInfo.ts:143-148`），而
  `headlessSafetyWarnings.ts` 已经覆盖了 headless-yolo 的情形。
- 等级通过 `SANDBOX_ENFORCEMENT` 传入被沙箱化的子进程，以便 UI 渲染它
  （例如 `landlock (partial, kernel ABI 3)`）。

### D5 —— 网络策略：三种模式映射到既有的代理钩子上

**决策。** `open`（共享网络）/ `closed`（`--unshare-net`）/ `proxied`（共享网络
并向主机侧 `QWEN_SANDBOX_PROXY_COMMAND` 注入 `HTTP(S)_PROXY`）。解析顺序：

1. `QWEN_SANDBOX_NET=closed` ⇒ closed（硬拒绝，优先于代理配置）。
2. 否则设置了 `QWEN_SANDBOX_PROXY_COMMAND` ⇒ proxied。
3. 否则 ⇒ open。

这与 Seatbelt 的 profile 矩阵（open/closed/proxied）一致，且 v1 不引入新的
profile 词汇表。

`closed` 是整个网络命名空间的切断，而不是出口过滤：它同时移除 loopback，
于是 IDE companion（通过 `~/.qwen/ide` 锁文件里的端口发现，
`core/src/ide/ide-client.ts:644-678`）、主机侧监听 `:4170` 的 `qwen serve`，
以及任何 localhost MCP server 都会变得不可达。抽象命名空间的 unix socket 也是
按网络命名空间隔离的，因此解析到抽象 socket 的 X11 连接会随之失效。所以
`closed` 只对单次一发的受约束运行是正确的；§ 已核实的兼容性影响 表把这一点
记录下来，而不是藏在一个模式名后面。

### D6 —— 不用 PID 命名空间，因为 PID 存活性是关键依赖

**决策。** bwrap profile **不** unshare PID 命名空间，也不新增任何开关来打开它。
`--proc /proc` 同样不出现——但原因并不是本文档某个早期草稿给出的那个。那份草稿
声称从 user namespace 内部挂载一个新的 procfs 需要持有 PID 命名空间；在内核
7.0.0 + bwrap 0.11.1 上实测，**不带** `--unshare-pid` 的 `--proc /proc` 可以正常
挂载，所以那个说法是错的。省掉这个 flag 的真实原因是它没必要、而且略微更松：
递归的 `--ro-bind / /` 已经把主机 `/proc` 以只读方式带进来了——实测有 133 个可见
的数字条目，这已是 Node 所需的全部——而一个新的 procfs 实例会以可读写挂载。

**理由。** qwen-code 通过 PID 仲裁跨进程所有权，目前有三处：

- `cli/src/serve/conversations/conversation-runtime-ownership.ts:44-65` —— owner
  记录带 `pid`，而 `processIsAlive()` 把任何非 `ESRCH` 的结果都视为存活；
- `cli/src/serve/live/discovery.ts:147` —— 同一个谓词；
- `core/src/services/worktreeSessionService.ts:424-446` —— 同一个谓词，外加一个
  `status.hostname !== os.hostname()` 守卫，对另一台机器写下的记录保守地回答
  `active`。

这些记录位于 `~/.qwen` 之下——那是一个可写根，因此跨越约束边界共享。

在私有 PID 命名空间内，受约束 CLI 自己的 PID 是命名空间局部的（1、2、3……）。
把这个数字写进共享状态不只是没用，而是**主动错误**：主机 PID 2 是 `kthreadd`，
属 root，因此主机侧的 `kill(2, 0)` 返回 `EPERM`，而上面每一个谓词都会把它读成
_存活_。结果是一个永远不会显示为已死的 owner，于是交接与回收永远不触发——这是
静默挂起，而不是可见的失败。隔离不值得拿守护进程赖以为生的一条正确性不变式去
换，而文件系统边界才是本设计真正要做的事。

**已接受的代价。** 受约束进程能看到并向主机进程发信号，procfs 魔法链接
（`/proc/<pid>/root/…`）仍然是命名主机路径的一种方式——但只能用于*读*，因为可写
根之外的每一个写入目标仍然位于只读挂载之上，而在 Landlock 后端上，ruleset 同样
治理被重新打开的那个路径。

**将来若要加它的前置条件。** owner 记录必须先携带命名空间身份，且读取方必须把
"记录于另一个 PID 命名空间"视为*未知*，而绝不是存活——这是仲裁谓词的 fail-closed
方向。`worktreeSessionService` 的 hostname 守卫就是要照抄的形状
（`/proc/self/ns/pid` 的 inode 是标准句柄）。在那之前，一个 PID 命名空间开关就是
一把没有调用者的自伤枪，所以本设计干脆不提供任何开关。

### D7 —— 选择顺序与推进节奏

**决策。** 指名 command 永远是显式的：`QWEN_SANDBOX=bwrap` / `landlock` /
`docker` / `podman` / `sandbox-exec`。对于 `--sandbox`/`QWEN_SANDBOX=true`
（未指名），候选顺序在 P0–P2 保持不变（Linux：只有 `docker`、`podman`——对现有
用户零行为变化）。**P3** 把未指名情况下的 Linux 候选顺序翻成
`bwrap` → `landlock` → `docker` → `podman`，并（在自己的 PR + 兼容性数据支撑下）
让 Linux 沙箱像 macOS 上的 `sandbox-exec` 那样被自动检测
（`sandboxConfig.ts:169-171`），以 `QWEN_SANDBOX=false` 作为逃生舱——这是既有的
写法（`getSandboxCommand()` 在 `sandboxConfig.ts:126-132` 接受 `0` / `false` /
空值；像 `off` 这种臆造的值会被当成 command 名而被拒绝）。

**理由。** 在显式 `true` 下优先选内核后端，会改变 `--sandbox` 对 docker 用户的
含义；在 P0 里静默这么做就是一次行为破坏。等后端被证明可靠之后，这次翻转很廉价。

## Phase P0 —— `bwrap` 后端（纯 TypeScript）

### 配置面

- `packages/core/src/config/config.ts`：把 `SandboxConfig.command` 放宽以纳入
  `'bwrap'`（`'landlock'` 在 P1 随其辅助程序加入），并把 `image?: string` 改为
  可选——它只是按约定对容器 command 必填，而 `loadSandboxConfig` 已经在容器
  command 没有 image 时返回空配置来强制这一点（行为不变）。
- `packages/cli/src/config/sandboxConfig.ts`：
  - `VALID_SANDBOX_COMMANDS` += `'bwrap'`。
  - 把 `runSandboxProbe` 泛化为按 command 的探测 argv：`docker`/`podman` →
    `['version']`（不变）；`sandbox-exec` → 跳过（不变）；`bwrap` → 功能性探测
    `['--ro-bind','/','/','--dev','/dev','--die-with-parent','--','true']`
    ——与 profile 使用的命名空间相关 flag 相同，因此探测通过就意味着 profile 的
    命名空间设置会成功（D6：profile 不带 `--unshare-pid`/`--proc`）。该探测刻意
    省略 `--bind` 与 `--chdir`，因为它们取决于解析出的根，而不取决于主机能力。
  - 候选列表：P0 不变（只走指名 command 的路径）。

### `start_sandbox` 的 bwrap 分支

在 `packages/cli/src/serve/sandbox.ts` 中新增分支，结构上镜像 seatbelt 分支
（`sandbox.ts:229-389`）：

1. **可写根** —— 与 Seatbelt permissive profile 授予的集合相同，每一个都经过
   `realpathSync`（内核比较的是解析后的路径；seatbelt 分支出于同一原因已经做了
   规范化，`sandbox.ts:252-259`）：

   | 根              | 值                                                                                                   |
   | --------------- | ---------------------------------------------------------------------------------------------------- |
   | `TARGET_DIR`    | `realpathSync(process.cwd())`                                                                        |
   | `TMP_DIR`       | `realpathSync(os.tmpdir())` —— 以可写方式绑定；`/tmp` 从不被换成新的 tmpfs（见下）                   |
   | `CACHE_DIR`     | `XDG_CACHE_HOME` ?? `~/.cache`（mkdir -p，然后 realpath）                                            |
   | `QWEN_DIR`      | `Storage.getGlobalQwenDir()`（mkdir -p，realpath）                                                   |
   | `RUNTIME_DIR`   | `Storage.getRuntimeBaseDir()`（mkdir -p，realpath）                                                  |
   | git 目录        | `git rev-parse --git-dir` 与 `--git-common-dir`，当它们解析到 `TARGET_DIR` 之外时                    |
   | npm 缓存        | `~/.npm`（若存在）                                                                                   |
   | git 配置        | `~/.gitconfig`（若存在，按文件绑定）                                                                 |
   | `INCLUDE_DIR_n` | `workspaceContext.getDirectories()` 去掉 `TARGET_DIR`（无 5 个上限；argv 没有 profile 参数数量限制） |

   **为什么需要 git 那两个根。** 在 worktree 检出里 `.git` 是一个指向别处的文件，
   因此 index、`HEAD`、reflog 和 objects 全都位于工作区之外。对照本仓库自身的
   worktree 布局核实：

   ```text
   toplevel (cwd):   /…/.qoder/worktree/qwen-code/o2qocx
   --git-dir:        /…/Projects/qwen-code/.git/worktrees/o2qocx
   --git-common-dir: /…/Projects/qwen-code/.git
   ```

   没有这两个根，worktree 工作区里的每一次 `git add` / `commit` / `stash` 都会
   以 `EROFS` 失败，并把 `enter_worktree`、Arena 和 `/review` 一起拖下水——而
   worktree 是 qwen-code 的一等工作流，不是边缘情况。解析在 hop 时刻只做一次；
   非仓库的 cwd 什么也解析不出，也就不贡献任何根。注意这里顺带修补的不对称：
   六个 Seatbelt profile 同样都没有授予 git common dir，所以 macOS 今天有同一个
   洞。修 Seatbelt 不在范围内（§ 非目标），但这个缺口现在被记录下来了。

   **为什么 `/tmp` 是绑定而非 tmpfs。** 一个新的 `--tmpfs /tmp` 会与上表的
   `TMP_DIR` 行自相矛盾，并遮蔽主机放在那里的路径：`/tmp/.X11-unix`（无法启动
   GUI）与 `/tmp/ssh-*/agent.*`（`git push` 无法用 ssh-agent 认证）。既然
   `os.tmpdir()` 本来就是可写根、而主机 `/tmp` 本来就是全局可写，私有 tmpfs
   买到的很少却要付两个可见功能的代价，所以它既不作为默认值提供，也不作为开关
   提供。

   容器分支以只读方式挂载的那些路径—— `~/.config/gcloud` 与
   `GOOGLE_APPLICATION_CREDENTIALS` 指向的文件（`sandbox.ts:539-557`）——在这里
   不需要对应物：`--ro-bind / /` 已经让它们可读，而它们在容器里本来也从不可写。

   Seatbelt profile 还额外授予 `/dev/stdout`、`/dev/stderr`、`/dev/null`、
   `/dev/ptmx`、`/dev/ttys*`（`sandbox-macos-permissive-open.sb:23-27`）；bwrap 的
   `--dev /dev` 覆盖了这一集合（null/zero/full/random/urandom、tty、pts/ptmx，
   以及 std\* 符号链接）。它同时遮蔽 `/dev` 下的其他一切，包括 `/dev/snd`——因此
   受约束时语音输入不可用（§ 已核实的兼容性影响）。

   不存在的根会被跳过（bind 源缺失会让 bwrap 失败）；已被更早的根覆盖的根会被
   丢弃。

2. **argv 模板**（dsh 在 `packages/sandbox/sandbox-local/src/profiles.ts` 中使用
   的形状）：

   ```text
   bwrap
     --ro-bind / /                     # 递归：/proc /sys /run 一并以只读带入
     --dev /dev
     --die-with-parent
     [--unshare-net]                   # 仅 closed 模式
     --bind <root> <root>              # 每个可写根一对
     --chdir <TARGET_DIR>
     -- <cliArgs...>                   # process.argv，含 llm.tsx 已经做过的
                                       # stdin / session-id 注入
   ```

3. **子进程环境** —— 挂在 `spawn` 的 env 上，而不是通过 `bwrap --setenv`，这样
   一条代码路径服务两个后端（landlock 辅助程序以启动器的环境原样 exec），并且
   不依赖某个特定 bwrap 版本是否有某个 flag：
   - `SANDBOX=bwrap`（P1 起也可能是 `qwen-landlock-run`）与
     `SANDBOX_ENFORCEMENT`。
   - `NODE_OPTIONS` 按 seatbelt 分支完全相同的方式合并。
   - proxied 模式下的代理变量。
   - **删除**：`DISPLAY`、`WAYLAND_DISPLAY`、`MIR_SOCKET`。
     `shouldAttemptBrowserLaunch()`（`core/src/utils/browser.ts:52-60`）在 Linux
     上纯粹依据这三者是否存在来决策。若留着它们，沙箱内的一次 OAuth 登录会
     `xdg-open` 出一个*作为受约束子进程*的浏览器，而它随后无法写自己的 profile
     目录（`~/.config/<browser>` 不是可写根），失败的样子看起来像认证 bug。
     删掉它们让既有的"打印 URL"路径变得确定，用户在自己正常的主机浏览器里打开
     链接。

4. **代理** —— proxied 模式按 seatbelt 分支的方式启动主机侧代理
   （`sandbox.ts:321-375`：detached 方式 spawn、安装会杀掉进程组的
   exit/SIGINT/SIGTERM 处理器、等待 `localhost:8877` 响应），并把
   `HTTP(S)_PROXY` 注入**到 spawn 的 env 上**。

   seatbelt 那段代码刻意*没有*被原样复用。它构造一个 `sandboxEnv` 对象、把代理
   变量写进去（`sandbox.ts:325-341`），然后从不把它传给 `spawn`——那次调用用的是
   `{ ...process.env, ...childEnv }`（`:376-388`）。因此在 macOS 上代理变量被
   算出来又被丢掉，于是 `QWEN_SANDBOX_PROXY_COMMAND` 启动了一个受约束进程根本
   不知道其存在的代理。`noUnusedLocals` 抓不到它，因为下标赋值算作一次使用。

   那是既有缺陷，不是本阶段引入的，而修它会改变 macOS 行为——不在本处范围内
   （§ 非目标：不改动 Seatbelt 路径），改为记录在 § 待决问题 中。bwrap 分支复现
   了代理的生命周期，但把变量通过子进程环境传下去，所以 `proxied` 在新后端上
   是真的可用。抽出一个共享 helper 是 seatbelt 那个 bug 修好之后的跟进项——那时
   两个调用方才终于想要完全相同的行为。

5. **spawn 契约** —— `stdio: 'inherit'`，spawn 前 `process.stdin.pause()` /
   close 时 `resume()`，以子进程退出码 resolve ——与 seatbelt 分支一致
   （`sandbox.ts:376-388`）。

### `llm.tsx` 的交接

`llm.tsx:578-595` 按 `sandboxConfig.command !== 'sandbox-exec'` 分支来决定更新后
重启的环境交接（容器 vs 非容器）。把非容器那一侧放宽：`bwrap`/`landlock` 必须走
sandbox-exec 分支（它们是原地 hop，不是镜像——没有
`CUSTOM_SANDBOX_IMAGE_ENV_VAR`）。

### UI

`packages/cli/src/ui/systemInfo.ts` 在 **P0 无需改动**：`getSandboxEnv()` 末尾的
`return sandbox`（`:156`）已经会把未知的 `SANDBOX` 值原样渲染，因此 `bwrap` 本身
就能正确显示。强制等级后缀（`landlock (partial)`）随 P1 落地——P1 才是真正可能
产出 `full` 之外等级的阶段；更早交付这个后缀，等于为一个尚不存在的后端交付一个
不可达分支。P0 仍然在有意义的地方暴露等级：`qwen sandbox` 会从
`SANDBOX_ENFORCEMENT` 打印 `Enforcement: <level>`。

### 模型可见的边界

`packages/core/src/core/prompts.ts:406-427`：为原地内核后端加一个分支。不加的话
`SANDBOX=bwrap` 会落进通用分支，那会告诉模型它跑"在一个沙箱容器里"，并教它去找
`Operation not permitted`——对 bwrap 的拒绝而言这是错的形状。新分支点明后端、
说明可写根之外主机根是只读的、给出 `EROFS` / `EACCES` 两种写法，并带上既有分支
同样的指示：把疑似约束拒绝上报给用户，而不是绕道解决。理由见 D2。该分支只匹配
`bwrap`；P1 会把 `qwen-landlock-run` 与强制等级措辞一起加进来，原因和 UI 后缀
要等的原因相同。

实测的措辞很重要。worktree 检出里一次被拒的 `git add` 读作
`fatal: Unable to create '…/index.lock': Read-only file system`，所以该分支必须在
正文里点出 `Read-only file system`——只点 `EROFS` 这个符号名并不匹配模型实际
看到的内容。

### `qwen sandbox` 自检子命令

新增 `packages/cli/src/commands/sandbox.ts`（+ 测试），与既有 command 模块并列
注册。之所以拉进 P0 而不是延后：§ 已核实的兼容性影响 里的每一项影响，在任务
中途出错之前都是不可见的，所以后端和证明它能工作的手段必须一起交付——下面的
CI 通道与 E2E 表也都要求这一点。

- `qwen sandbox` —— 打印解析出的后端、探测结果、强制等级、可写根（含解析出的
  git 目录）与网络模式。
- `qwen sandbox <cmd>…` —— 通过解析出的后端跑一条命令并报告结果（对应
  `codex sandbox`）。
- `qwen sandbox --verify` —— 行为电池：工作区外的写入必须失败；工作区内的写入
  必须成功；worktree 检出里的 `git commit` 必须成功；主机 `/proc` 必须保持可见
  （D6 的回归守卫）；网络在 `closed` 下必须不可达、在 `open`/`proxied` 下必须
  可达。

## Phase P1 —— `qwen-landlock-run` vendored 回退

### 辅助程序（新源码，约 300 行 C11）

`packages/core/vendor/landlock-run/src/qwen-landlock-run.c`。设计参照 dsh 的
`native/system/packages/entry/src/main.c`（BSD-3-Clause；是重新实现，不是拷贝）：

- CLI 契约（钉在文件头，并从 TS 侧做单元测试）：

  ```
  qwen-landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
  qwen-landlock-run --probe
  ```

  `--ro` 授予该路径之下的读 + 执行；`--rw` 授予协商出的内核 ABI 所治理的全部
  文件系统访问。其他一切被拒绝（Landlock ruleset 是允许列表）。

- **Fail-closed**：`no_new_privs` → `landlock_create_ruleset`（从已知最高 ABI
  向下协商）→ 每个授权一次 `add_rule` → `landlock_restrict_self` → `execvp`。
  任何一步失败都以 **125** 退出，stderr 带 `qwen-landlock-run: ` 前缀，并且不
  exec。一个打不开的授权根是启动失败，绝不是被静默收窄的 profile。
- **功能性探测**：`--probe` 对自身安装一个最大化 ruleset，并且只打印一行——
  `landlock: fully enforced` 或 `landlock: partially enforced (older ABI)`——
  退出 0；当内核无法强制（ENOSYS/EOPNOTSUPP）时退出 125。`--version` 式的检查
  会漏掉那些有 syscall 但拒绝强制的内核。
- **部分强制**：在较旧 ABI 上，向 stderr 打印
  `qwen-landlock-run: partial enforcement (older Landlock ABI)` 并继续——对内核
  所治理的一切仍然是受约束的。
- UAPI 结构体/常量在本地定义（内核用户态 ABI 是稳定的；这让构建不依赖工具链头
  文件的新旧，同时这些定义本身就充当审计记录）。

### 构建与分发

- `scripts/build_landlock_run.mjs` 一次构建一种架构：

  ```sh
  musl-gcc -static -O2 \
    -o packages/core/vendor/landlock-run/<arch>-linux/qwen-landlock-run \
    packages/core/vendor/landlock-run/src/qwen-landlock-run.c
  ```

  工具链要求记录在旁（Linux 上 `apt install musl-tools`，macOS 上
  `brew install musl-cross`）。

- CI（`verify-landlock-run.yml`，ubuntu x64 + arm64 runner）：从源码重建、用
  `sha256sum` 与已提交的二进制比对、跑功能性探测、跑行为电池（拒绝 `--rw` 之外
  的写入、允许其内部的写入、在支持 Landlock 的内核上校验 `--probe` 的退出码）。
- `packages/core/package.json` 的 `files` 已包含 `vendor/` —— 无需改发布配置。

### TS 集成

- 注册：`SandboxConfig.command` 增加 `'landlock'`；`VALID_SANDBOX_COMMANDS` +=
  `'landlock'`；`runSandboxProbe` 增加 `landlock` → `[launcherPath(), '--probe']`
  这一支（辅助程序缺失或内核不强制都算探测失败，因此指名 `landlock` 的请求会以
  既有的 `FatalSandboxError` 措辞 fail-closed）。
- `packages/cli/src/utils/landlockRun.ts`（新增）：`launcherPath()`（通过
  `resolveBundleDir` 解析架构，镜像 `getBuiltinRipgrep` 在
  `packages/core/src/utils/ripgrepUtils.ts:97-111` 中的遍历规则）、
  `probe(): Promise<'full' | 'partial' | 'unusable'>`，以及
  `grantArgs(roots: {ro: string[]; rw: string[]}): string[]`。
- `start_sandbox` 的 `landlock` 分支：argv =
  `[launcherPath(), ...grantArgs({ro: ['/'], rw: writableRoots}), '--', ...cliArgs]`，
  环境继承不使用 `--setenv`（辅助程序以启动器的环境原样 exec；在 spawn 前于
  `process.env` 中为子进程设置 `SANDBOX=qwen-landlock-run` 与
  `SANDBOX_ENFORCEMENT`，与 seatbelt 分支的 env 合并方式相同）。
- 强制等级的管道：探测结果被串进子进程环境，以便 `systemInfo.ts` 能渲染
  `landlock (partial, kernel ABI 3)`。

## Phase P2 —— 在辅助程序中收紧 seccomp

**辅助程序中的 seccomp**（+约 80 行 C）：在 `no_new_privs` 之后安装一个最小 BPF
过滤器，拒绝 `ptrace`、`mount`、`umount2`、`init_module`、`finit_module`、
`delete_module`、`kexec_load`、`kexec_file_load`、`bpf`、`perf_event_open`、
`keyctl`、`iopl`、`ioperm`。这是把 Claude Code 的 `apply-seccomp` 模式折进同一个
辅助程序；它只作用于 landlock 路径。bwrap 自身除了 `--seccomp <fd>` 之外没有
seccomp 钩子，而用那个就意味着要分发一个编译好的 BPF 程序去喂它——不在本处范围。

由于辅助程序获得了它此前没有的拒绝能力，本阶段是对一个已发布的指名后端做行为
收紧，而不是纯增量：它需要一条发布说明，并为每一类被拒 syscall 加一个
`--verify` 用例。

## Phase P3 —— 翻默认值（独立 PR，以兼容性数据为前提）

1. Linux 上未指名的 `--sandbox`/`QWEN_SANDBOX=true`：候选顺序变为
   `bwrap` → `landlock` → `docker` → `podman`。
2. Linux 上自动检测沙箱（镜像 macOS 在 `sandboxConfig.ts:169-171` 的
   `sandbox-exec` 自动候选），前提是评审 § 已核实的兼容性影响 并有现场数据支撑
   ——不只是机制清单，还要有真实工作流命中每一行的频率。
   `QWEN_SANDBOX=false` 是文档化的逃生舱。
3. CI：新增 `test:integration:sandbox:bwrap` 与
   `test:integration:sandbox:landlock` 通道；保留 `sandbox:none` 通道（无约束
   路径仍受支持），但它不再是唯一被演练的 Linux 配置。

## 已核实的兼容性影响

每一行都是对照本仓库核实过的机制，而不是猜测，且只适用于两个原地后端——容器
后端与 macOS 不受影响。这张表是 P3 翻默认值时必须回答的；在那之前，它们是一个
显式启用 flag 的既有后果。

| 领域                                                                       | 影响                    | 机制                                                                                                                                                                                               | v1 中的处理                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| worktree 检出里的 git                                                      | 会完全不可用            | git dir 与 common dir 解析到 cwd 之外（布局已在 § Phase P0 核实）                                                                                                                                  | **已修** —— 两者都是可写根                                                                                       |
| 跨进程 owner 存活性                                                        | 会静默挂起              | `process.kill(pid, 0)` 返回非 `ESRCH` ⇒ 存活，而 PID 通过 `~/.qwen` 共享（`conversation-runtime-ownership.ts:44-65`、`serve/live/discovery.ts:147`、`worktreeSessionService.ts:424-446`）          | **已规避** —— 完全不用 PID 命名空间（D6）                                                                        |
| GUI 启动（OAuth 登录、`artifact` 打开）                                    | 浏览器无法在约束下运行  | `xdg-open` 子进程继承约束，而 `~/.config/<browser>` 不是可写根                                                                                                                                     | 删除 display 变量 ⇒ 确定地走打印 URL 路径                                                                        |
| `git push` 的 ssh-agent 认证                                               | 不受影响                | agent socket 常位于 `/tmp` 之下，而它保持绑定、没有被 tmpfs 替换                                                                                                                                   | ——                                                                                                               |
| 语音输入                                                                   | 不可用                  | `--dev /dev` 遮蔽 `/dev/snd`；`voice-availability.ts:50` 还需要 `PULSE_SERVER`                                                                                                                     | 已记录 —— 改用容器后端或无约束运行                                                                               |
| 自更新                                                                     | 部分受影响              | 受管更新根是 `~/.qwen/updates/npm`（`scripts/cli-entry.js:149-150`）——那是可写根，因此退出码 44 的受管流程可用；而 npm-global 的 `updateCommand`（`installationInfo.ts:350`）写全局 prefix，会失败 | 受管安装与独立安装正常更新；npm-global 用户从主机侧更新                                                          |
| IDE companion、主机 `qwen serve`、localhost MCP                            | 仅在 `closed` 下不可达  | `--unshare-net` 移除 loopback（D5）                                                                                                                                                                | `open` / `proxied` 下仍可用                                                                                      |
| 对 `~/.config`、`~/.kube`、`~/.ssh`、`/usr/local` 的写入                   | 被拒绝                  | 它们不是可写根 —— 这正是沙箱的意义                                                                                                                                                                 | 确有工作流需要时通过 `--include-directories` 单独加入                                                            |
| 会话数据、检查点、worktree、Arena、IDE 锁文件、MCP OAuth token、token 账本 | 不受影响                | 全部位于 `QWEN_DIR` / `RUNTIME_DIR` 之下（`storage.ts:193-241`、`gitWorktreeService.ts:419`、`ArenaManager.ts:136`）                                                                               | ——                                                                                                               |
| `docker.sock`、D-Bus、Wayland 及其他主机 unix socket                       | 在 bwrap 上可达（实测） | 内核的只读文件系统写检查豁免 `S_ISSOCK`（只有 `S_ISREG`/`S_ISDIR`/`S_ISLNK` 会返回 `EROFS`），因此 `--ro-bind / /` 之下的 socket 仍接受 `connect()`                                                | 在 bwrap 上**已核实** —— 位于所有可写根之外的 socket 仍接受 `connect()`；Landlock 后端留作 P1 的 `--verify` 用例 |

## 安全考量

- **规范化**：每一个可写根在进入 profile 之前都经过 `realpathSync`；bwrap/Landlock
  比较的是解析后的路径。seatbelt 分支出于同一原因做同样的事。
- **procfs 魔法链接**：**没有**被关闭，因为 profile 不 unshare PID 命名空间
  （D6）—— `/proc/<pid>/root/…` 仍是命名主机路径的一种方式。它保持为读取路径：
  重新打开的路径仍位于只读挂载之上，而在 Landlock 后端上 ruleset 也治理被重新
  打开的那个文件。要关闭它需要 D6 里那个 PID 命名空间前置条件，而目前还没有
  调用者提出这个需求。
- **只读文件系统语义比看起来更窄**：内核只对 `S_ISREG` / `S_ISDIR` / `S_ISLNK`
  的写访问返回 `EROFS`。`--ro-bind / /` 之下的 socket、FIFO 与设备节点都被豁免，
  因此主机 unix socket 仍然可连接——这是实测结论，不是假设（§ 证据）。这在这里
  是刻意的（正是它让 `docker.sock`、D-Bus 与 Wayland 保持可用），但这意味着
  "只读的根"绝不能被读作"没有任何 IPC 能出沙箱"：任何通过主机 socket 可达的
  东西，按构造都在这个边界之外。
- **setuid 提权**：在施加约束之前设置 `no_new_privs`（对非特权 Landlock 而言
  这也是强制要求）。
- **孤儿进程**：bwrap 上用 `--die-with-parent`；Landlock ruleset 是进程作用域的，
  随进程消失。
- **解析与 exec 之间的符号链接替换**：通过在 spawn 前紧邻解析来收窄；残余竞态
  与 seatbelt 路径已经接受的是同一类（在 `sandbox.ts` 中有记录）。
- **环境**：bwrap/landlock 的 hop 继承完整环境（与 seatbelt 分支对齐）。凭据剥离
  仍由既有的 `sanitize-child-env` 消费方负责；本设计不改动那个边界。
- **非目录授权**：文件授权（例如 `~/.gitconfig`）只保留与文件兼容的访问位
  （内核会对非目录上的仅目录访问返回 EINVAL —— 辅助程序据此做掩码）。
- **启动器/命令失败的归因**：启动器失败以 125 退出并带 `qwen-landlock-run: `
  前缀；而一个成功 exec 的子进程也可能以 125 退出，所以消费方必须同时要求
  状态码 125 **且**有该前缀 —— 这与 dsh 的 CLI 契约钉下的规则相同。

## 测试计划

按阶段拆分，因为各阶段作为独立 PR 交付。某个阶段的测试与它同批写就——下面没有
任何一项被推到更后的阶段。

**P0 —— 单元测试（`packages/cli`，vitest）**

- `sandboxConfig.test.ts`：`bwrap` 按名被接受；非法名仍然 `FatalSandboxError`；
  按 command 的探测 argv 选择；bwrap 功能性探测失败会以"已安装但无法运行"呈现；
  探测缓存行为不变。
- `sandbox.test.ts`：bwrap argv 构造 —— 根的顺序、嵌套根去重、缺失的根被跳过、
  git dir / common dir 只在落到 `TARGET_DIR` 之外时加入且非仓库 cwd 下不加入、
  任何配置下都没有 `--unshare-pid` / `--proc` / `--tmpfs`、`--unshare-net` 只在
  closed 模式出现、子进程环境携带 `SANDBOX` / `SANDBOX_ENFORCEMENT`、proxied
  模式下代理变量确实出现在子进程环境上（即避开的那个 seatbelt bug），以及三个
  display 变量被删除。
- `prompts.test.ts`：新的 `SANDBOX=bwrap` 分支被选中并点出 `EROFS`；既有的
  `sandbox-exec` 与容器分支保持当前文本（快照）。
- `sandbox.command.test.ts`：`qwen sandbox` 的输出形状；`--verify` 会把一个失败
  用例报告为失败（无法失败的电池什么也证明不了）。

**P0 —— 集成测试**

- `test:integration:sandbox:bwrap` 通道；GitHub workflow 在 ubuntu runner 上安装
  `bubblewrap`。Fake-LLM-server 测试在约束内原样运行（工作区写入 + 到 fake
  server 的网络）。

**P1 —— 单元测试**

- `landlockRun.test.ts`：探测行 → `full` / `partial` / `unusable` 的映射；
  `grantArgs` 的形状；架构解析（mock platform/arch，沿用
  `ripgrepUtils.test.ts` 的模式）。
- `sandbox.test.ts`：landlock argv = 启动器 + 授权 + `--` + cliArgs。
- `systemInfo.test.ts`：`landlock (partial, …)` 的渲染，外加守卫 `:156` 原样
  透传的无后缀用例。
- `prompts.test.ts`：`SANDBOX=qwen-landlock-run` 选中内核沙箱分支，且 `partial`
  措辞只在等级如此时出现。

**P1 —— 构建关卡与集成测试**

- `verify-landlock-run.yml`：从源码重建 → sha256 与已提交二进制比对 → 功能性
  探测 → 行为电池，两种架构都跑。
- `test:integration:sandbox:landlock` 通道。

**P2**

- 每一类被拒 syscall 一个 `--verify` 用例，外加一个证明辅助程序对允许的
  syscall 仍能成功 exec 的电池用例（否则一个拒绝一切的 seccomp 过滤器也能通过
  那些拒绝用例）。

**P3**

- `sandboxConfig.test.ts`：Linux 上未指名的 `--sandbox` / `QWEN_SANDBOX=true`
  按新的候选顺序解析；`QWEN_SANDBOX=false` 仍然禁用一切；自动检测在非 Linux 上
  不触发。

**E2E（手工，P3 之前每个版本执行）**

| 检查项                                               | 期望                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| 在无 docker 的 Linux VM 上 `qwen --sandbox bwrap`    | 能启动；状态行显示 `bwrap`                                 |
| 在 **worktree** 检出内：`git commit`                 | 可用（git 根的回归守卫）                                   |
| 一个受约束会话持有时再起第二个 CLI                   | owner 交接仍然触发（D6 的回归守卫）                        |
| 内部：`touch /usr/local/bin/x`                       | EROFS                                                      |
| 内部：`touch ./x && rm ./x`（工作区）                | 可用                                                       |
| 内部：`ls /proc`                                     | 主机进程可见（没有 PID 命名空间 —— D6）                    |
| `QWEN_SANDBOX_NET=closed`：模型 API 调用             | 快速失败并给出清晰的代理提示                               |
| proxied：经 `QWEN_SANDBOX_PROXY_COMMAND` 的 API 调用 | 可用                                                       |
| `kernel.unprivileged_userns_clone=0` 的机器          | 指名 `bwrap` ⇒ "已安装但无法运行"；指名 `landlock` ⇒ 可用  |
| 内核 < 5.13（无 Landlock）                           | `landlock` 探测 ⇒ unusable；显式请求 ⇒ `FatalSandboxError` |
| Ctrl-C / CLI 崩溃                                    | 没有遗留的受约束孤儿进程                                   |
| `qwen sandbox --verify`                              | 电池通过                                                   |

## 推进节奏与兼容性

- P0：任何平台的默认行为都不变；`bwrap` 可按名使用。全部是新增 ——
  `VALID_SANDBOX_COMMANDS`、一个 `start_sandbox` 分支、类型放宽、交接分支放宽、
  提示词分支，以及 `qwen sandbox` 子命令。
- P1：新增 vendored 二进制（约 70 KB × 2 种架构）与 `landlock` 指名 command；
  默认行为不变。
- P2：用 seccomp 收紧 landlock 后端 —— 这是 P3 之前唯一改变一个已发布指名后端
  行为的阶段；需要发布说明。
- P3：唯一改变默认行为的阶段；独立 PR、独立设计评审、独立发布说明。

**流程说明。** `packages/cli/src/config/sandboxConfig.ts` 与
`packages/core/src/config/config.ts` 都命中 `packages/*/src/config/**`，因此每个
阶段都触及 AGENTS.md 双层关卡下的核心基础设施。各阶段都不是大范围的
`refactor`，所以都不会被硬阻断，但外部作者在此提交的 PR 按规则（而非按判断）
上报维护者。把工作拆成 P0–P3 也让每个 PR 都留在 CONTRIBUTING.md 的体量阈值之内。

## 待决问题

1. **WSL2**：Landlock ABI 的可用性随 WSL2 内核版本而变；探测能正确处理，但 P3
   的自动默认需要把 WSL2 纳入兼容性矩阵。
2. **Snap/Flatpak 约束下的主机**：userns 可能连 root 都被限制；landlock 回退能
   覆盖大多数此类情况，但对"两个都不可用"的主机，其错误信息需要同时点出两个
   失败原因。
3. **收紧写集合的 profile**：macOS 矩阵里有 `restrictive-*` profile（97 行的
   `.sb` 文件）；Linux 是否需要在 v1 就有一个对应的更窄根集合，还是可以等 profile
   统一那项工作，是一个 P3 的范围界定问题。
4. **按命令粒度的约束**：Codex 级别的按调用策略（自动批准的命令走只读、批准后
   走工作区可写）需要 D2 中描述的工具调度器手术。等 P0–P3 的使用数据出来后，
   值得单独立一份设计。
5. **Landlock 与 socket 文件**：在 bwrap 后端上，只读根之下的主机 unix socket
   是可达的（实测，§ 证据）。一个不授予 socket 所在目录任何访问权的 Landlock
   ruleset 是否会阻断 `connect()`，目前仍未确定，而它决定两个后端是否具有相同的
   IPC 面 —— 这是一个 P1 的 `--verify` 用例，而不是一个假设。
6. **Seatbelt 的 git 目录缺口**：六个 macOS profile 同样都没有授予 git common
   dir，因此在 `--sandbox sandbox-exec` 下，worktree 检出里的 `git commit` 今天
   本就应该失败。若能复现，那是一个独立的 bug 修复（一个 profile 参数，不是设计
   变更），不应被打包进本项工作。
7. **Seatbelt 的代理环境丢弃**：`sandbox.ts:325-341` 往一个 `sandboxEnv` 对象里
   填了代理变量，而 `:376-388` 从不把它传给 `spawn`，因此 macOS 上的
   `QWEN_SANDBOX_PROXY_COMMAND` 启动了一个受约束进程看不见的代理。这同样是独立
   修复 —— 它改变 macOS 行为、需要自己的回归测试，所以刻意不在此处打包。
8. **`XDG_CACHE_HOME` 指向 `/proc` 下时的无法解释的挂起**：在验证 VM 上实测，
   把 `XDG_CACHE_HOME` 指向 procfs 内一个不存在的路径（`/proc/nope/cache`）会让
   进程卡在一个连 `timeout` 的信号都打不断的状态。该根的 `mkdir` 与 `realpath`
   都在 `try`/`catch` 内，而针对一个普通不可写路径（`/usr/local/nope-cache`，
   属 root）的同一测试表现正确 —— 该根被丢弃、启动继续 —— 所以挂起不在解析逻辑
   里。此处只作记录不作解释：它需要一次 procfs 层面的调查，而且没有任何现实配置
   会走到它。

## 证据

- Linux 上的实机验证，2026-09-10 —— Lima VM，内核 `7.0.0-28-generic`，
  bubblewrap 0.11.1，git 2.53.0，`unprivileged_userns_clone=1`，Landlock 出现在
  `/sys/kernel/security/lsm` 中。探测脚本曾位于
  `.qwen/scripts/verify-bwrap-assumptions.sh`，而 `.gitignore` 按仓库约定排除该
  目录，因此它不属于本次改动 —— 它产出的测量结果改为记录在下方，而
  `qwen sandbox --verify` 是那些值得重复执行的检查的、已提交且有测试的继任者。
  该脚本演练了本文档中的十项主张：九项通过，一项失败（D6 中的 `--proc` 主张，
  已在上文就地修正）。经测量确认：文档中的探测 argv 能启动；可写根之外的写入
  返回 `EROFS`；一个 `--bind` 根是可写的；不带 `--unshare-pid` 时主机 PID 保持
  可见（133 个数字 `/proc` 条目）；位于所有可写根之外的一个主机 unix socket 仍
  接受 `connect()`；只绑定 worktree 时，worktree 检出里的 `git add` 以
  `Unable to create '…/index.lock': Read-only file system` 失败，而一旦把 git dir
  与 common dir 也绑定进来就成功；`/dev/snd` 在内部被遮蔽而在主机上存在；
  `--unshare-net` 阻断出站解析。
- 本仓库：Phase 0 中的 file:line 引用，均于 2026-09-09 在本分支核实。D2、D5、D6
  与 § 已核实的兼容性影响 背后的影响面排查于 2026-09-10 补充，覆盖
  `cli/src/serve/conversations/conversation-runtime-ownership.ts:44-65`、
  `cli/src/serve/live/discovery.ts:147`、`core/src/core/prompts.ts:406-427`、
  `core/src/utils/browser.ts:25-70`、`core/src/utils/secure-browser-launcher.ts:151-181`、
  `core/src/ide/ide-client.ts:644-678`、`core/src/config/storage.ts:160-241`、
  `core/src/services/gitWorktreeService.ts:419`、
  `core/src/agents/arena/ArenaManager.ts:128-140`、
  `cli/src/ui/voice/voice-availability.ts:50`，以及本检出的 worktree
  `git rev-parse` 布局。
- Codex CLI（本地克隆，最高 tag `rust-v0.153.4`）：
  `codex-rs/linux-sandbox/src/{bwrap,landlock}.rs`、
  `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`（`(deny default)`）、
  `codex-rs/Cargo.toml`（`seccompiler = "0.5.0"`、`landlock = "0.4.4"`）、
  `codex-rs/vendor/bubblewrap/`、
  `codex-rs/protocol/src/protocol.rs:983-1023`（`SandboxPolicy`）、
  `codex-rs/cli/src/main.rs:145`（`codex sandbox` 子命令）。
- dsh（`deepseek-ai/deepseek-harness`，MIT；`native/system` 为 BSD-3-Clause）：
  `native/system/packages/entry/src/main.c`（299 行）、
  `native/system/docs/cli-contract.md`、
  `packages/sandbox/sandbox-local/src/profiles.ts`（bwrap argv 形状）、
  `packages/sandbox/sandbox/src/index.ts`（`SandboxEnforcement` 联合类型，以及
  `denialSignatures` 与 `runnerFailureRules`）、
  `.agents/notes/implemented/feature/2026-07-06-sandbox.md`（考虑过的替代方案）。
- Claude Code 2.1.266（二进制 + CLI 证据）：来自 `@anthropic-ai/sandbox-runtime`
  的 bwrap + `apply-seccomp`；`CLAUDE_CODE_FORCE_SANDBOX`。
