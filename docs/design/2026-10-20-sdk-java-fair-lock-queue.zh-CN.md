# SDK Java 宿主机锁：FIFO 票据队列

[English](2026-10-20-sdk-java-fair-lock-queue.md) | [简体中文](2026-10-20-sdk-java-fair-lock-queue.zh-CN.md)

## 问题

`.github/workflows/sdk-java.yml` 通过 `flock --wait` 把所有 self-hosted 的
Maven 步骤串行在一个文件 `~/.cache/qwen-code-ci/sdk-java-tests.lock` 上。
2026-10-18/19 和 2026-10-20 共享 ECS 池反复饥饿：job 在 2400 秒、随后
3600 秒、再随后 5400 秒的预算内等满后失败，一条测试都没有执行，而且至少
三台物理宿主机同时中招（#14566、#14743）。

`flock(2)` 不为等待者排队。锁释放时会唤醒所有睡眠中的 waiter，而内核
唤醒没有任何顺序，所以在持续有新任务到达时，某个 waiter 可能每次都
抢不到锁，被无上限地饥饿。等待预算只约束单次尝试，不约束等待总时长：
2400 → 3600 → 5400 秒只降低失败概率。至少三台宿主机各自挂着多个
runner 注册抢同一把锁，需求随到达率增长而容量一次只能放一个 ——
没有任何常数预算能兜住这个队列。

## 目标与非目标

- 目标：让等待变得确定。一个 waiter 的最坏等待时长是排在它前面的
  工作量，而不是一场唤醒抽签。
- 目标：其余语义不变。锁仍按 step 边界自动释放；固定的基础设施
  签名错误文案（`lock not acquired within`）保留，`qwen-autofix.yml`
  里的重跑分类器不受影响。
- 非目标：降低总占用。按套件分片锁、限制每台宿主机注册数、加机器，
  都是正交工作，可以后续再做；有了公平性，这些工作的剩余价值才
  变得可衡量，而不是紧急。
- 非目标：修改 5400 秒预算或 150/280 分钟的 job 上限。

## 设计

### 在现有锁外面加一个票据队列

新增一个以 source 方式引入的辅助脚本
`.github/scripts/sdk-java-lock.sh`，替换两处取锁点原来的
`exec 9>lock; flock --wait` 内联块。

- 票据放在 `<lock>.queue/`。每个获取者在 fd 8 上的 `flock` 保护下
  对计数器文件做读取-递增-写入，并在释放该锁之前发布自己的票据，
  因此后发的票不可能先于前一张可见。
- 只有持有最小活动顺序号的 waiter 才尝试拿锁 —— 用一次阻塞式
  `flock --wait` 等满剩余预算。池子是混合编队的：main 和旧分支仍跑
  原生 `flock --wait`，切成小片反复重进内核等待队列的队首会在每次
  释放时输给一直阻塞着的 waiter。只进入一次才能保住到达顺序。
- 票据携带 owner 的 PID。被取消或被 kill 的 step 会留下孤儿票；
  下一次队首检查会回收 owner PID 已死且 mtime 超过 10 秒的票，也会
  回收 mtime 超过 1800 秒的票 —— 即使那个 PID 已被复用到活进程上。
  活着的 waiter 每轮循环都会 touch 自己的票，所以 mtime 陈旧就说明
  owner 已经离开；无人触碰的队首不会把空闲的锁永久堵死。
- 成功后立刻删除票据：内核已经持有锁之后，持有者不再需要排队位置，
  而 trap 在 `return` 之后也看不到辅助脚本的局部变量。锁仍以 fd 9
  留在 step 的 shell 里，因此它仍会在 step 边界自动释放 —— 这个
  辅助脚本改变的是**获取顺序**，而不是释放语义。
- 超时则打印
  `::error::sdk-java host lock not acquired within N minutes as queue ticket S`
  并返回 1，维持既有错误文案契约。
- 可观测性：第一次等待时打印自己的票据号与剩余预算，之后最多每
  分钟一次，让挂死能够从日志归因，而不是沉默。
- 在这里 fail-closed 比回退更糟：`release-sdk-java.yml` 续跑既有
  tag 时会检出那个不可变的 commit，它可能早于本辅助脚本。因此两处
  站点在脚本文件不存在时回退到它们替换掉的裸
  `flock --wait 5400 9`，而不是在 Maven 之前直接失败并让发布永久
  卡死。

### 为什么是公平性，而不是其他方案

- 按套件分片：只降低排队频率，每个分片仍然是一把无序唤醒的裸
  flock，而且依赖一个未经验证的假设 —— 并发套件在同一宿主机上
  安全（这池子刚把一次构建 OOM 过）。
- 限制每台宿主机注册数：需要仓库之外的池拓扑改造，而且每台宿主机
  内部仍然是同样的无界唤醒竞争。
- 加一台宿主机：至少三台同时饥饿过，机器数量已被证明不是瓶颈。

### 有意接受的残余失败模式

- owner 已死但 PID 被一个长寿命进程复用的票，会活到那个进程退出，
  排其后的 waiter 仍按现有预算超时。这与今天的最坏情况相同，不是
  新引入的。
- 计数器锁的老化对"在临界区内被 kill"的极端情况最坏是一分钟；
  在一个拉取级预算里损失一分钟。

## 验证计划

- 辅助脚本的单元行为由 `scripts/tests/sdk-java-lock.test.js` 钉住
  （仅 POSIX）：两个 waiter 的 FIFO 顺序、过期 owner 的回收、超时
  签名与票据清理，`flock` 以 PATH stub 注入。
- 工作流的 pin 随机制迁移：`scripts/tests/sdk-java-workflow.test.js`
  现在 pin 的是 source 该辅助脚本和三处 `sdk_java_lock_acquire 5400`
  预算，`.size-baseline` 记录工作流的新尺寸。
- 真实宿主机上的浸泡验证就是 CI 本身：合并后第一批池上运行要么
  按票序拿到锁，要么带着可归因的票据号超时。

## 验收标准

- `sdk-java.yml` 的三处取锁点都以 5400 秒通过该辅助脚本获取。
- `npx vitest run scripts/tests/sdk-java-lock.test.js
scripts/tests/sdk-java-workflow.test.js scripts/tests/workflow-size.test.js`
  通过。
- 错误文案仍包含子串 `lock not acquired within`，因此
  `qwen-autofix.yml` 的 `INFRA_FAILURE_SIGNATURES` 保持匹配。

## 未决问题

- 队列深度是否值得作为指标上报；本设计落地的最低限度可观测性
  是每分钟封顶的等待日志行。
