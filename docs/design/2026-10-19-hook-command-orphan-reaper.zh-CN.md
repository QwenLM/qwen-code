# Hosted Hook 命令孤儿回收

[English](2026-10-19-hook-command-orphan-reaper.md) | [简体中文](2026-10-19-hook-command-orphan-reaper.zh-CN.md)

## 问题与范围

Issue [#14502](https://github.com/QwenLM/qwen-code/issues/14502)（由 FG13 轮次 [#14449](https://github.com/QwenLM/qwen-code/issues/14449) 发现）记录了 Hosted Hook 命令运行期间 Runtime worker 可能死亡。SIGKILL、V8 堆 OOM 中止或原生崩溃都不会执行 worker 的任何 JS 处理器。命令的 cgroup 单元（`qwen-hook-<uuid>`）会保留前台进程与已脱离的后代；单元名只存在已死 worker 的内存里，生产中没有任何东西能找到、杀掉或删除它。孤儿进程可以在记录已为 `recovery_blocked`/`outcome_unknown` 之后继续修改 Workspace。

本切片在既有 cgroup launcher 上加入 Hook 专用的父进程死亡回收。launcher 本身就是单元成员；worker 消失时它写 `cgroup.kill`，内核会杀掉包括 `setsid` 后代在内的所有成员。它不新增 Broker/Java 侧回收，不把未知结果变成已结算，也不删除空的单元目录。

## 决策

- `HookCommandCgroup.launch(..., { reapOnParentExit: true })` 设置 launcher 环境标记。launcher 每 100 ms 检查一次 `process.ppid`；若启动时已被 PID 1 收养则立即回收，之后父进程变化时写 `cgroup.kill` 并退出。内核会杀掉 launcher 与整个单元，因此「从不写 stdout 的前台命令」与已脱离的后代都会消失。
- 当前台命令退出而单元仍有成员时，launcher 在委派根下创建一个临时 sibling reaper 单元并把自己移入，继续作为 reaper 存活，直到原单元为空才按前台退出码结束。移动后 `waitForEmpty()` 只度量剩余成员；drain 期间 worker 死亡仍会写 `cgroup.kill`。drain 在开始轮询前先检查一次 `populated 0`，launcher 退出后 worker 会删除空的 reaper sibling，因此成功命令不留下目录。
- 取消与超时在升级宽限期内保留 reaper。启用标记时 launcher 忽略 `SIGTERM`：已被覆盖的 launcher 是 worker 在 `cgroup.kill` 升级前死亡时唯一剩下的 reaper。Hook runner 对原单元与其 reaper sibling 都尚未覆盖的 launcher 仍在 `terminate()` 前直接停止，因此与首次入组竞争的取消不会留下「稍后入组并 spawn」的进程；`terminate` 完成后才把停止 launcher 作为最终清理。launcher 在重新抬升结束命令的 `SIGTERM` 前移除该忽略处理器，退出证据仍保留命令的信号。
- Hook runner 只在 `waitForProcessTree` 命令路径上启用。后台 Shell 不启用：H3 有意让它们跨 worker 重启存活并按名字重挂。`survivesParentExit` 的 Hook（`MessageDisplay`、`StopFailure`、`SessionDelete`）使用独立 supervisor，不会创建这个单元。
- 相比 issue 里的两种设计：launcher 已在单元内，因此不需要可持久化的单元名或产品状态，Java 控制面也不需要新增 cgroup 代码；回收发生在唯一活过 worker 的进程里。空目录与未知结果仍在；清扫与 abandonment 路由属于后续。

## 行为与验收

- launcher 测试由一个 worker 持有 launcher，杀掉 worker，断言 launcher 写出了 `cgroup.kill`；第二个用例让 launcher 在其 worker 已退出（ppid 1）后才启动，断言立即回收；第三个让前台先退出、留下 detached 后代，并在 drain 期间杀掉 worker；第四个向 launcher 发送 `SIGTERM`，断言它活过这轮清扫，然后在宽限期内杀掉 worker，断言它仍写出 `cgroup.kill`。启用标记且命令以 `SIGTERM` 结束时，launcher 仍以该信号退出。默认 launch 不带标记，后台 Shell 的生命周期不变。
- Hook runner 的取消用例断言：已被覆盖的 launcher（在原单元或其 reaper sibling 中）先 `terminate` 再停止，而未被覆盖的 launcher 在 `terminate()` 之前就直接停止。
- Hook runner 套件与既有进程树取消用例保持全绿。
- 在带真实委派 cgroup root 的 Linux Hosted 车道上，原 `HookRunner` 复现（worker SIGKILL、堆 OOM、原生崩溃）应显示单元被清空；可观察量是 `populated 0`。
- `packages/core` 的类型检查与 lint 通过。

## 限制

- 正常路径会删除空的原单元与其 reaper sibling；worker 死亡（`cgroup.kill`）会留下两者，worker 启动时清扫 `populated 0` 的 `qwen-hook-*` 单元属于后续。
- 记录仍是 `recovery_blocked`/`outcome_unknown`：杀掉进程只能限制影响，无法结算没有幸存者观察到的结果。
- 只覆盖 local-process 的 Linux cgroup 路径；非 Linux 的 Hook 命令本来就已被 cgroup 守卫拒绝。
- 如果 worker 自身就是 PID 1（容器 init），launcher 启动时的 `ppid === 1` 判断无法区分「worker 已死」与「父进程本来就是 1」，会把已启用的 Hook 在启动时回收。Hosted worker 拓扑不以 PID 1 运行 worker；以 PID 1 运行的部署不得启用该路径。
- 如果自定义 subreaper 在 launcher 启动前收养了它，启动时的 reparent 可能观察不到；正常的 worker/Harness 拓扑会 reparent 到 PID 1，且间隔检查仍覆盖运行中的死亡。
- drain 期间创建 reaper 单元需要委派根允许子单元；如果拒绝，launcher 回退到立即退出，该 drain 窗口不被覆盖；同一回退也让取消宽限期失去 reaper；空的 reaper 单元由 worker 启动清扫移除。
- 本切片不改 Broker/Java，也不引入可持久化的单元名。
