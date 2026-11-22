# web-shell boot 重试：熬过 network-change abort 风暴

[English](2026-11-09-web-shell-boot-retry-storm-backoff.md) | [简体中文](2026-11-09-web-shell-boot-retry-storm-backoff.zh-CN.md)

状态：提案

## 问题陈述

`web-shell E2E Smoke` 车道在共享 ARM64 自建池上变红，原因与失败 PR 的 diff 无关。签名是：某个分片丢掉 10–20 条用例、全是可见性与导航超时，而跑同一份构建产物的兄弟分片在别的宿主上通过。

Run [42546153793](https://github.com/QwenLM/qwen-code/actions/runs/42546153793) 的 job `128934179292`（shard 4/4，runner `ecs-qwen-hz6-16`）是一个证据完整的样本：`11 failed | 10 flaky | 80 passed (19.5m)`，而 shard 1–3 分别在 `ecs-qwen-hz1-21`、`ecs-qwen-hz2-31`、`ecs-qwen-hz3-2` 上以 12.6–14.7 分钟通过。

失败**不是**首屏慢。上传的 47 份 `error-context.md` 里有 41 份是同一个终态页面：

```yaml
- heading "Web Shell 加载失败 / failed to load"
- paragraph: 'A required resource failed to load: unknown error (http://127.0.0.1:36657/main.tsx). …'
- button "重新加载 / Reload"
```

该面板一旦画出，这次 boot 就已经死透，后续每条断言都只能耗尽自己的预算。抬可见性超时修不了它——这也正是此前把 `expect.timeout` 从 10 s 抬到 20 s 之后车道仍在流血的原因。

## 现状

机制由该 job 的 21 份重试 trace 确立：

1. 共享宿主上的兄弟容器改动其网络接口。Chromium 的 network-change 通知器触发，把**所有在途请求**以 `net::ERR_NETWORK_CHANGED` abort。21 份 trace 中 19 份带该 `_failureText`；单条用例最多损失 648 个 `script` 请求。
2. smoke 套件经 **vite dev server** 启动，一次 boot 约为 900–5500 个模块请求、跨数秒——暴露窗口很宽。
3. `client/e2e/utils/bootRetry.ts` 已经会重载被这样杀掉的 boot，但它用 `setTimeout(…, 0)` 安排重载，且只允许 `MAX_BOOT_RELOADS = 2`。在被追踪的那条用例里，三次入口模块尝试起始于 `01:55:24.631`、`01:55:25.536`、`01:55:27.599`，而 abort 风暴覆盖 `01:55:24`–`01:55:27`。**三次尝试全部烧在同一个风暴里。** 每次 `main.tsx` 响应都是 `200 OK`；真正失败的是它的 import 图，而 descendants import 失败的 module script 会把 error 报在顶层元素上，这就是 watchdog 点名 `main.tsx` 的原因。
4. 预算耗尽后，`client/index.html` 的 boot watchdog 画出兜底面板。该盒子被明确设计为终态且 sticky，并会卸载 watchdog。

Chromium 将此视为 [wontfix](https://stackoverflow.com/questions/44678168/docker-and-chromium-neterr-network-changed)，且未提供关闭该通知器的开关，因此无法要求浏览器停止产生这些 abort。

## 目标

- 让一次 boot 能熬持续数秒的 abort 风暴，使分片不再因自己没造成的宿主网络抖动而失败。
- 保持每条既有断言仍然有意义。重试预算保持有界，并继续被测试钉住。

## 范围边界

- **不**把 dev server 换成构建产物 preview。那样能更大幅度缩小暴露窗口，但 boot-retry 场景存在的目的正是演练 dev-server 模块图加载失败；去掉 `/main.tsx` 就去掉了它们的被测对象。
- **不**抬可见性或单用例超时。页面是终态，不是慢。
- **不**做专用网络隔离池。那是 [#15967](https://github.com/QwenLM/qwen-code/issues/15967)，仍是治本方案；本改动是它落地前降低车道流血频率的仓库内缓解。

## 提议的方案

只改 `client/e2e/utils/bootRetry.ts` 与钉住其预算的场景。

1. **把重试拉开。** 用确定性的递增退避 `BOOT_RELOAD_BACKOFF_MS = [500, 1_500, 3_500]` 取代零延迟重载。这样后续尝试会落在杀死前一次的那个窗口之外，而不是排在它后面。
2. **把预算抬到 `MAX_BOOT_RELOADS = 3`**（四次尝试）。三次尝试已被证明装得进一个实测风暴；由退避阶梯延后的第四次会落在风暴之后。该预算由退避数组的长度推导，二者只有一个来源。
3. **新文档提交时取消待发的重载。** 最长 3.5 s 的延迟打开了零延迟版本没有的窗口：等待期间由测试驱动的导航，否则会被过期定时器重载。若 boot 计数器在定时器触发前推进，则丢弃该次重载。
4. **导出这两个常量**，让场景从实现推导期望次数，而不是把 `3` 再写一遍字面量。
5. **给「不应发生重载」的断言补静默窗口。** 退避把误重载推迟了一个第一级退避，原本紧贴 `load` 读取的文档计数会漏掉它。四处这类断言改为先等 `BOOT_RELOAD_BACKOFF_MS[0] + 500`，使这些钉子在退避下仍然承重。

## 设计决策与理由

- **先退避，再加预算。** 只加预算仍会让尝试聚在一起：四次立即重试跨越的秒数与三次大致相同。把尝试推过风暴的是间隔；多出来的那次尝试则是给间隔一个落点。
- **为什么是这几个数。** 非 boot-retry 的场景用套件 20 s 的 `expect` 预算断言可见性，计时起点是 `goto` 所等待的 `load` 事件。阶梯总共等待 5.5 s，为四次短促的失败 boot 在该预算内留出余量。更长的阶梯会把这条 flake 换成可见性超时。
- **不加抖动。** 套件必须保持确定性；随机延迟会让新场景的结果取决于抽签。
- **风暴时长锚定现场，而不是从阶梯推导。** 若从退避推导，阶梯一缩短风暴也跟着缩短，用例会在真实四秒风暴重新困死 boot 时继续通过。它固定为 5 s，阶梯必须熬过它；因此缩短阶梯会让用例变红，而不是悄悄把球门挪走。
- **推导被钉住的计数。** `an entry module that never loads stops after the reload budget` 与 `a second install on the same page does not double the reloads` 断言精确的尝试次数。它们现在从 `MAX_BOOT_RELOADS` 计算该值，静默窗口则从最大退避推导，因此常量与它的钉子不会各自漂移。

## 约束

- 整个阶梯必须在未覆写它的场景所用的 20 s `expect` 预算内跑完。
- 证明「不再重载」的静默窗口必须超过最大退避，否则它会在已安排的重载变得可观测之前就到期。
- 重试必须继续只认当前 boot 的主框架 `script` 请求；排除 fetch、子框架与离开中文档请求的既有场景必须原样保持绿。

## 风险

- **仍然有界。** 比阶梯更长的风暴仍可能困死一次 boot。本改动降低发生率，不会让车道免疫，#15967 依然必需。
- **退避会花掉可见性预算。** 在冷到单次 boot 就逼近预算的宿主上，多出的 5.5 s 可能改以可见性超时的形式出现。boot-retry 场景使用的 40 s 预算能吸收它；通用套件的 20 s 是吃紧的那一侧。
- **真正坏掉的入口模块现在更晚才报出来**，同样晚 5.5 s，才轮到断言 watchdog 面板。

## 验证计划

- 新增一个在进程内复现风暴的场景：在固定墙钟窗口内 abort 每个主框架 `script` 请求，随后放行模块图。它断言 shell 挂载成功且不残留兜底面板。这把退避与预算一起钉住——去掉任一个，尝试就会聚拢或在窗口内耗尽。
- **变异见证：** 恢复零延迟重载，以及单独恢复 `MAX_BOOT_RELOADS = 2`；新场景两次都必须变红，同时不相关的场景保持绿作为对照。
- 在 `mobile-chromium` 上反复重跑 boot-retry spec 文件，证明结果稳定。
- `npm run build`、`npm run typecheck`、`npm run lint`，以及 web-shell 单元套件。
- **需明确说明的本机缺口：** 本机跑不了 `mobile-webkit` 工程（缺 `libx264` 等运行库），WebKit 覆盖留给 CI。

## 验收标准

- 新增风暴场景在改动后反复通过，并在两种变异下失败。
- 所有既有 boot-retry 场景仍通过，断言除了改为从导出常量推导的预算计数外逐字未变。
- build、typecheck、lint 干净。
- 本设计的两个语言版本保持一致。

## 待定问题

- 阶梯是否需要再加一级，取决于来自 #15967 池的证据；此处刻意不做投机。
- 应在决定「更多仓库内缓解是否值回其延迟代价」之前，重新测量本改动后车道的残余失败率。
