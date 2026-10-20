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
`.github/scripts/sdk-java-lock.sh`，替换三处取锁点原来的
`exec 9>lock; flock --wait` 内联块。

- 票据放在 `<lock>.queue/`。每个获取者从一个由计数器锁目录保护的
  计数器取下一张顺序号（`mkdir` 是原子进入；死在临界区内的持有者
  一分钟后会被人老化清掉）。
- 只有持有最小活动顺序号的 waiter 才尝试拿锁 —— 用的是切成 5 秒
  小片的阻塞式 `flock --wait`，而不是 `--nonblock` 轮询。池子是混合
  编队的：main 和旧分支仍跑原生 `flock --wait`，轮询的队首每次释放
  都会输给这些老 waiter 得到的内核唤醒（本 PR 第一次真机运行就是
  ticket 1 在队首等满了 5400 秒预算）。阻塞的队首与老 waiter 站在
  同一内核唤醒集合里；FIFO 顺序在使用本脚本的 run 之间生效，合并
  之后就是所有 run。
- 票据携带 owner 的 PID。被取消或被 kill 的 step 会留下孤儿票；
  下一次队首检查会回收 owner PID 已死且 mtime 超过 10 秒的票（活着
  的 waiter 每轮循环都会 touch 自己的票，所以 mtime 能跳过正在创建
  中的票；PID 被回收复用单独也无法清掉票）。
- 两个类别共享同一把物理锁。`fast` 是 PR 反馈 lane，`normal` 是
  approval 和 main 的 full-tier 工作。队首取排序后的第一张票，fast
  票排在最前，所以 fast job 最多只等当前正在跑的那一次持锁，而不是
  排在一串 full-tier 长任务后面。normal 票等待超过
  `SDK_JAVA_LOCK_PROMOTE_AFTER`（默认 1200 秒）后会把自己改名进 fast
  类别，因此持续的 PR 流量也无法饿死 full tier。
- 成功后锁仍以 fd 9 留在 step 的 shell 里，因此它仍会在 step 边界
  自动释放 —— 这个辅助脚本改变的是**获取顺序**，而不是释放语义。
  EXIT/INT/TERM trap 负责丢弃票据。
- 超时则打印
  `::error::sdk-java host lock not acquired within N minutes as queue ticket S`
  并返回 1，维持既有错误文案契约。
- 可观测性：第一次等待时打印自己的票据号，之后最多每分钟一次，
  让挂死能够从日志归因，而不是沉默。

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
  （仅 POSIX）：两个 waiter 的 FIFO 顺序、fast 先于 normal 的顺序、
  aging 提升、过期 owner 的回收、超时签名与票据清理，`flock` 以
  PATH stub 注入。
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
