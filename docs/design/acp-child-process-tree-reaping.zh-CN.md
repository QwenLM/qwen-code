# ACP 子进程树收割

[English](acp-child-process-tree-reaping.md) | [简体中文](acp-child-process-tree-reaping.zh-CN.md)

状态：已在 PR2 中实现

提议的 PR 标题：`fix(acp-bridge): Reap ACP child process trees`

## 问题

`createSpawnChannelFactory()` 启动每个 `qwen --acp` 进程时没有为其建立
独立的进程组。`ProcessRegistry` 随后只向该直接子进程发送 `SIGTERM` 与
`SIGKILL`。当 ACP 进程启动了 hooks、shell 命令、MCP 服务器或其他孙进程时，
终止 channel 可能让这些后代在 ACP 根进程退出后仍在运行。

该缺陷不限于优雅关闭路径。`killSync()` 同样只向根进程发信号，而
`ProcessRegistry` 在根进程一发出 `exit` 时就移除其登记项。因此后续的
shutdown 或第二次信号无法触及比根进程存活更久的后代。

在 macOS 上的一次真实进程基线测试复现了以上所有场景：

| 路径          | 后代                   | 基线结果                                          |
| ------------- | ---------------------- | ------------------------------------------------- |
| `terminate()` | 普通孙进程             | 根进程在 5 秒宽限期后被杀；孙进程以 PPID 1 存活。 |
| `terminate()` | 位于独立会话中的孙进程 | 根进程被杀；孙进程以 PPID 1 存活。                |
| `killSync()`  | 普通孙进程             | 根进程立即被杀；孙进程以 PPID 1 存活。            |
| `killSync()`  | 位于独立会话中的孙进程 | 根进程立即被杀；孙进程以 PPID 1 存活。            |
| 根进程先退出  | 任一形态               | 注册表已提前释放登记项，后续终止成为空操作。      |

独立的根进程组可以修复普通孙进程的场景，包括根进程退出后仍留在组内的普通
孙进程。它无法修复调用过 `setsid()` 或以其他方式创建独立分组的后代。这类
后代在根进程谱系仍然完整时可以通过进程表快照发现，但被重新挂父之后就不行了。

## 范围

本 PR 负责 `packages/acp-bridge` 内的 ACP 子进程生命周期：

- 在标准 spawn 工厂创建 ACP 子进程时确立所有权边界；
- 在每一条既有 channel 拆除路径上终止被拥有的进程树；
- 为异步优雅路径与同步第二信号路径保留足够的清理状态；
- 保持既有 `AcpChannel.exited` 语义以及所有关于何时杀死 channel 的桥接决策。

它不改变 HookRunner 取消、端点截止时间、请求中止传播、会话所有权、空闲
channel 策略或桥接路由。那些是各自独立的 PR 边界。PR2 不依赖 HookRunner
改动中的私有辅助函数，因此两个 PR 可以独立开发。

## 生命周期契约

实现必须保持以下不变量：

1. `AcpChannel.exited` 仍与今天完全一致地报告 ACP 根进程的原始退出。后代
   清理不得延迟会话死亡的观测。
2. `AcpChannel.kill()` 只在被拥有的进程树消失后才 resolve。根进程不干净地
   退出，或在既有的 10 秒总截止时间内无法确认清理完成时，它 reject。
3. `AcpChannel.killSync()` 在返回前派发可用的最强树杀操作。它无法等待，
   因为 daemon 在强制退出进程前一刻调用它。
4. 并发的 `kill()`、注册表 shutdown、传输失败拆除与 `killSync()` 调用都是
   幂等的。
5. 注册表只从被隔离的根进程或该根进程当前谱系的经验证快照添加进程组；
   绝不从根进程退出后的历史 PID 扩张所有权。
6. `ProcessRegistry` 的既有外部用户保持直接子进程行为，除非它们显式把一个
   attach 的子进程标记为树所有者。

## 设计

### 在 attach 时声明所有权

为 `ProcessReservation.attach()` 增加可选的所有权元数据。默认仍是直接
子进程跟踪。标准 spawn 工厂只把它自己创建的那个子进程标记为被拥有的
进程树根。

在 POSIX 上，把子进程标记为树所有者要求调用方已将其生成为隔离的进程组
组长。在 Windows 上，同一元数据授权以该 PID 为根的 `taskkill /T` 操作。
保持该选项显式开启，避免把任意公开 attach 的子进程当作组长、意外向宿主的
进程组发信号。

不需要改动任何 `AcpChannel`、桥接或 daemon API。

### 建立 POSIX 进程组

`createSpawnChannelFactory()` 在非 Windows 平台设置 `detached: true`。
ACP 根 PID 由此成为其进程组 ID 和会话 ID。其 stdio 仍保持管道方式，子进程
也没有被 `unref()`，因此 channel 的传输与生命周期所有权不变。

隔离确实改变了终端信号继承：发送给宿主前台进程组的 POSIX 信号不再自动
到达 ACP 子进程。因此 `qwen serve` 将 `SIGHUP` 与 `SIGINT`、`SIGTERM`
一起路由进既有的优雅关闭与第二信号状态机。嵌入方仍需在自己的宿主生命周期
中调用 `AcpChannel.kill()` 或 `killSync()`。诸如 `SIGKILL` 这类无法捕获的
宿主崩溃无法运行任何一条清理路径，不属于本可移植修复的范围。

Windows 保持禁用 `detached`，使用下述原生进程树操作。

### 第一次信号前先做快照

对树所有的 POSIX 子进程，`terminate()` 首先获取一次有界的进程表快照，
包含 PID、PPID 与 PGID。它在内存中遍历后代，记录每个唯一的进程组。根组
始终依据 spawn 时的隔离契约被包含，即使快照辅助工具不可用。仅当根行仍然
存在并确认根进程就是其自身进程组的组长时，快照中的组才被接受。如果现存
的根行与该契约矛盾，则连临时的根组也被丢弃，拆除回退为只向直接子进程发
信号。

快照必须发生在任何信号发出之前。先杀根进程会让后代重新挂父到 PID 1，
摧毁离开根组的后代唯一可移植的所有权证据。

该辅助工具保持为 `acp-bridge` 私有，运行时间、输出、深度与进程数量都有
上界。它直接调用 `/bin/ps`，而不是通过继承的 `PATH` 解析 `ps`，因为返回
的 PGID 会授权后续信号。若该可信路径不可用，快照失败走安全的根组回退，
而不是去执行一个不可信的替代品。重新导出 Core 既有的 PID 辅助函数会把
PR2 扩大成跨包公共 API 变更，而且也无法提供 PGID 或 `killSync()` 所需的
同步快照。

### POSIX 终止状态机

`terminate()` 使用既有的 5 秒宽限期与 10 秒总截止时间：

1. 标记终止已激活，并对返回的 promise 做记忆化。
2. 对仍被拥有的谱系做快照，将其 PGID 合并进跟踪的所有权集合。
3. 向每个被拥有的进程组发送 `SIGTERM`，根组最后。仅对 ACP 根进程本身，
   以直接子进程信号作为回退。
4. 同时等待根进程原始退出与每个已知组消失。只要还有一个组存在，根进程
   退出本身不构成完成。
5. 到宽限期截止时，若原始根进程仍在隔离组中存活，再取一次仅以该根为源的
   有界快照，合并新发现的后代，向每个存活的被拥有组发送 `SIGKILL`，随后
   执行直接杀根回退。根进程退出后，绝不从历史 PID 扩张所有权，因为操作
   系统可能把它们复用给无关进程。
6. 根进程与被拥有成员消失后 resolve。到总截止时间时，携带根 PID、存活
   组与任何快照失败信息 reject。

根进程退出且 KILL 已派发后，进程组存活性辅以一次有界的进程状态快照。
这处理不复收养孙进程的 Linux PID 1 环境：僵尸可以让其 PGID 仍可寻址，
尽管它已不能再执行。只有当快照观察到某组的成员、且每个被观察成员都处于
终态时，该已知组才被移除。组缺失、状态未知或查询失败都保持存活。在
Linux 上，拥有多于一个线程的僵尸组长也保持存活，因为组长退出后其他线程
仍可执行。

`ESRCH` 表示 PID 或组已消失。`EPERM` 表示它仍存在且清理未被确认。`kill()`
pending 期间，定时器与存活性轮询保持被引用；ACP 根进程退出后，一个未决的
promise 本身不足以让 Node 保持存活。

终止状态是单调的。同步强杀在取快照前先设置 `forceKillRequested` 状态。
异步路径在每次快照或定时器 await 之后检查该状态，只能从 TERM 前进到 KILL；
在 `killSync()` 已升级整棵树之后绝不能再发送更晚的 TERM。注册表释放同样
有守卫，使并发的根退出、`terminate()` 与 `killSync()` 路径恰好各调用一次。

根进程的原始退出与注册表释放成为两个独立事件。显式终止期间，根退出落定
`AcpChannel.exited`，但树所有的注册表登记项保留到清理落定，这样
`killAllSync()` 仍能强化一个进行中的 shutdown。意外退出的根进程会在登记项
释放前触发一次对其已知根进程组的即时尽力同步杀。若清理仍在进行时终止开始，
它会等待这些已知组，而不是把根进程原始退出当作树的完成。

若初始快照不可用或被截断，实现仍会杀死隔离的根组，但不得静默声称已完整
覆盖各独立后代组。派发安全回退之后，`terminate()` 会 reject，因为无法证明
完整清理。`killSync()` 没有错误通道，因此它最多记录"尽力派发"这一级别的
保证。

若根进程在有效初始快照确立谱系之前消失，异步路径给出同样的"清理未经验证"
结果。第二次快照收窄宽限期内的普通生成竞态，但本机制是生命周期清理而非
安全沙箱：它无法阻止对抗性进程二次 fork 逃离被观测的谱系。

### POSIX 同步强杀

`killSync()` 在向根进程发信号前先取一次有界的同步 PID/PPID/PGID 快照。
它把该快照与进行中 `terminate()` 已记录的组合并，向每个已知被拥有组发送
`SIGKILL`（根组最后），然后尝试直接杀根回退。根进程退出后它不再枚举，但
仍向更早快照证明过的组发信号。

同步辅助函数与异步辅助函数共享解析与所有权验证，但使用带短超时的
`spawnSync()`。若枚举失败，它仍会杀死隔离的根组。该方法保证的是派发而非
进程退出的观测，然后立即返回给 daemon 的第二信号处理器。

### Windows 树终止

Windows 没有 POSIX `SIGTERM` 语义。异步 `terminate()` 路径启动可信的
绝对路径可执行文件 `%SystemRoot%\System32\taskkill.exe`，参数为
`/F /T /PID <rootPid>`，等待该操作完成后再以直接子进程强杀作为失败回退。
随后在既有总截止时间内等待根进程退出。taskkill 调用本身有界，不会超出该
截止时间。该路径不假装提供 TERM 宽限期。

`killSync()` 使用同一绝对路径与参数的 `spawnSync()`，使 `taskkill` 在
daemon 退出前枚举进程树。若 taskkill 无法启动或返回失败，则尝试直接子进程
`SIGKILL` 回退。不允许裸 `taskkill` 命令，因为 Windows 会通过当前目录与
`PATH` 解析它。

### 直接子进程兼容性

不带树所有权的 attach 保持当前行为：

- 根进程 `exit` 释放注册表登记项；
- `terminate()` 只向直接子进程发信号；
- `killSync()` 只向直接子进程发信号；
- 预约与已提交进程核算保持源兼容。

对树所有的子进程，已提交进程核算延伸覆盖显式的树拆除，而非止步于根进程
原始退出。这延续了既有的准入不变量：一个正在收尾的子进程在其被拥有进程
仍可能占用内存期间保持被计数。

## 失败语义

- 重复与并发的拆除调用共享一份异步状态，并可以安全地接受额外的同步强杀。
- 只要已知后代组仍存在，根进程干净退出不足以判定完成。
- shutdown 期间根进程非零或被信号退出，在后代清理之后仍是"不干净关闭"
  错误，保持当前行为。
- 快照、`ps` 或 `taskkill` 失败总是回退到最强的安全根操作。无法确认完整
  清理时，上报的错误包含失败的机制；注册表 shutdown 继续聚合子进程失败。
- 进程表解析只接受正的安全整数 PID/PGID 行，对环去重，绝不向宿主自身的
  进程组发信号。
- 进程状态查询失败按保守处理。仅含僵尸的组在 KILL 后可释放，但含有任何
  存活成员的组保持保留。

## 平台限制

可移植的 PID/PPID/PGID 枚举无法挽回这样的后代：它建立了独立会话，又在
清理开始前因 ACP 根进程退出而失去谱系。Windows 的 PID 树枚举存在同样的
根进程先行竞态。对该场景的绝对收容需要 Linux cgroup、Windows Job Object
或其他操作系统级监管者。

因此本 PR 保证清理隔离的根组，以及清理启动时仍可发现的独立组。它不得
声称能收割一个在拆除前所有权证据已消失的已守护化进程。与任何基于
PID/PGID 的生命周期清理一样，操作系统标识符复用留下不可消除的"检查到
发信号"竞态；更强的身份与收容需要操作系统监管者。增加该收容刻意不在
这个最小修复的范围之内。

## 实现面

生产代码改动应仅限于：

- `packages/acp-bridge/src/process-registry.ts`：所有权状态、有界快照、
  平台终止与注册表释放；
- `packages/acp-bridge/src/spawnChannel.ts`：POSIX `detached` 生成与所有
  权标记；
- `packages/cli/src/serve/run-qwen-serve.ts`：将 `SIGHUP` 路由进既有 daemon
  shutdown 状态机；
- 至多在 `packages/acp-bridge/src/channel.ts` 中做一次契约澄清。

不需要新增依赖、共享进程管理器抽象、Core 导出或桥接生产代码改动。

## 验证

### 单元与契约测试

- 旧式 `attach(child)` 保持直接子进程语义。
- 标准工厂在 POSIX 上使用 `detached: true`，在 Windows 上不使用。
- PID/PPID/PGID 解析有界、对环安全、去重。
- POSIX 的 TERM、宽限、重快照与 KILL 覆盖所有被拥有组。
- 有被拥有组存活时，根进程退出不 resolve `kill()`。
- Linux 仅含僵尸的组在 KILL 后落定；带存活线程的 `Z` 长与含任何非僵尸
  成员的组保持已提交。
- `ESRCH`、`EPERM`、PID 缺失、spawn 错误、快照失败与截止时间遵循声明
  的语义。
- 并发 `terminate()`、注册表 shutdown 与 `killSync()` 保持幂等。
- 显式拆除期间，根已退出的树仍可被 `killAllSync()` 触达。
- Windows 使用绝对 System32 路径、精确的 `/F /T /PID` 参数，以及启动或
  退出失败时的直接子进程回退。
- 多个子进程全部被尝试，失败保持聚合。
- `qwen serve` 将 `SIGHUP` 路由进优雅清理，drain 期间为第二信号升级保留
  监听器，并在 shutdown 后移除它。

### 真实进程测试

在 POSIX 上，一个类 ACP 根进程同时启动一个普通孙进程与一个创建独立会话
的孙进程。两者都忽略 `SIGTERM`。独立演练 `terminate()`、`killSync()` 与
根进程先行时序，断言文档化的保证与平台限制，并在 `finally` 中清理每个
记录的 PID。

### 桥接与 daemon 回归

既有的拆除决策必须继续收敛到树感知的 channel 操作上，覆盖 channel 构建
失败、初始化失败、空会话创建、传输失败、正常 daemon shutdown 与第二信号。
共享 channel 上的单个会话失败不得在另一会话仍拥有该 channel 时杀死它。

聚焦的实现验证：

```bash
(cd packages/acp-bridge && npx vitest run src/process-registry.test.ts src/process-registry.process.test.ts src/spawnChannel.test.ts)
(cd packages/cli && npx vitest run src/serve/run-qwen-serve.test.ts)
npm run build
npm run typecheck
npm run lint
git diff --check
```
