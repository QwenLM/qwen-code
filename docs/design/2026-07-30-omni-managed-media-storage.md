# Omni 受管媒体存储设计

## 状态

- 状态：Draft
- 范围：Qwen Code 实验分支中 Omni 多模态资源与中间产物的物理存储管理
- 关联设计：
  [多模态文件识别与元数据提取架构设计](./2026-07-29-multimodal-file-recognition-and-metadata.md)、
  [Omni 多模态数据处理 Policy 编排架构设计](./2026-07-29-omni-multimodal-policy-orchestration.md)、
  [Omni 多模态 Memory 架构设计](./2026-07-29-omni-multimodal-memory.md)

## 1. 背景

前三篇设计反复引用"受管本地文件 / Omni 管理目录 / managed storage"，但没有任何
一篇定义它的物理形态。它至少要同时承载四类文件：

1. URL 下载与 inline 解码的本地化结果（识别设计 §6.1、§7）；
2. Policy Tool 的衍生产物：音轨、切片、关键帧、降采样图、转写文本（Policy 设计
   §6.2）；
3. Policy 执行失败后被隔离的 quarantined 产物（Policy 设计 §9）；
4. 被 Memory active 记录长期引用、需要跨 session 存活的衍生物（Memory 设计
   §13：_artifact 生命周期不得早于仍引用它的 active Memory 记录_）。

第 4 条决定了这不能是一个"会话结束即清理的临时目录"：Memory 是跨 session 的，
它引用的媒体文件也必须跨 session 存活。本设计定义目录布局、写入协议、生命周期
与垃圾回收，作为其余三篇的公共物理底座。

## 2. 目标与非目标

### 2.1 目标

- 为四类文件定义统一的、按 project 隔离的目录布局；
- 用内容寻址（SHA-256）保证对象不可变、天然去重，与 Memory 设计 11.3 的
  content-hash 复用键对齐；
- 定义 staging → 提交 / 隔离的原子写入协议，与 `OmniPolicySucceeded` 的事务
  边界一致；
- 定义崩溃恢复：启动时清理半成品，不留下 Memory 可见的孤儿引用；
- 定义 GC：以 Memory active 记录为根的 mark-and-sweep，加保留期与容量预算；
- 配置进入 `omni.storage`，纳入 resolved Omni config hash。

### 2.2 非目标

- 不设计 Memory 图数据本身的存储后端（Memory 设计 §13 单独决定）；
- 不改变现有 session artifact store 的职责（它仍服务 UI metadata）；
- 不提供跨 project 共享、远端同步或多机存储；
- 不做加密存储；实验分支按本地开发机信任模型处理。

## 3. 位置与隔离

存储根目录固定为 project 作用域：

```text
<projectRoot>/.qwen/omni/
```

- 与 Memory 设计 §13 的"以 project/workspace 为隔离边界"一致：不同 project 的
  对象、staging 与 quarantine 互不可见，GC 也只在本 project 内运行；
- 目录创建时写入自忽略文件（`.qwen/omni/.gitignore` 内容为 `*`），保证媒体
  对象不会进入版本控制；
- Omni 写入链路只在 trusted workspace 激活；未信任 workspace 中不创建该目录，
  也不执行任何 fixed policy（与 Policy 设计 §12.1 的 trust 合并语义一致）；
- 目录权限 `0700`；内部只允许普通文件与目录，发现 symlink 一律拒绝并告警。

## 4. 目录布局

```text
.qwen/omni/
├── .gitignore                 # 内容为 *，自忽略
├── objects/                   # 内容寻址对象库（不可变，已提交内容的唯一存放地）
│   └── sha256/
│       └── ab/
│           └── ab3f…e9.mp4    # <sha256 前 2 位>/<完整 sha256>.<按检测 MIME 的扩展名>
├── downloads/                 # URL 本地化进行中的 .part 文件
│   └── <downloadId>.part
├── staging/                   # policy invocation 的工作目录（提交前）
│   └── <invocationId>/
│       ├── out-audio.wav
│       └── out-keyframe-01.jpg
└── quarantine/                # 失败 invocation 被隔离的产物（可调试、有界）
    └── <invocationId>/
```

### 4.1 objects：内容寻址对象库

- 对象以完整内容 SHA-256 命名，写入后不可变；扩展名取自统一识别的
  `detectedMimeType`，便于 ffmpeg/ffprobe 与人工调试直接识别；
- 同一份字节在任何来源出现（两个 File 内容相同、policy 结果 cache hit）都只
  存一份物理对象——这正是 Memory 设计 11.2/11.3"跨 File 复用底层 artifact、
  不合并图节点"的物理实现：File/lineage/provenance 属于 Memory 图，字节属于
  对象库；
- `ToolArtifact.managedId` 与 `artifactRef.managedId` 即对象键
  （`sha256:<hash>`），对模型与协议层是 opaque ID，真实路径不外泄；
- 对象写入协议：先写同目录 `.tmp` 文件，流式计算 hash，完成后原子 rename 到
  最终 hash 路径；目标已存在（去重命中）时直接丢弃 `.tmp`。

### 4.2 downloads：URL 本地化

- 识别设计 §7 的 `.part` 文件统一放在此处，`downloadId` 为随机标识；
- 下载完成、重新 sniff/probe/hash 之后按 4.1 协议晋升到 `objects/`，`.part`
  删除；
- 大小许可（100 MiB 门槛）中断的 `.part` 保留以支持续传，但受 §6 的启动清理
  与保留期约束。

### 4.3 staging：policy 工作目录

- FixedPolicyOrchestrator / Scheduler 在每次 MediaPolicyTool invocation 前创建
  `staging/<invocationId>/`，并把它作为 Tool 唯一允许的输出目录注入；
- Tool 写完产物返回后，产物在 staging 内完成识别、hash 与 descriptor 校验
  （Memory 设计 §6.4 的 staging 语义）；
- `OmniPolicySucceeded` 提交顺序固定为：**先把全部产物晋升到 `objects/`，再
  提交 Memory 事务**。这样 active Memory 记录引用的对象必然已存在；反向顺序
  可能在崩溃时留下"Memory 指向不存在文件"的坏引用。晋升成功但 Memory 提交
  失败时留下的是无引用孤儿对象，由 GC 回收，无正确性风险；
- 提交或隔离后删除该 invocation 的 staging 目录。

### 4.4 quarantine：失败隔离

- invocation 失败（Tool error、产物校验失败、部分 required 缺失）时，整个
  staging 目录移动到 `quarantine/<invocationId>/`，保留原始文件名与一份
  `reason.json`（失败原因、tool、policyId、时间）供实验调试；
- quarantine 永不被识别、不进入 Memory、不能被召回或重新绑定为 session
  resource（Memory 设计 §15）；
- 受独立的保留期与容量预算约束（§7 配置），超限时按最旧优先删除。

## 5. 写入者与职责边界

| 写入者              | 允许写入的区域                                           | 说明                            |
| ------------------- | -------------------------------------------------------- | ------------------------------- |
| 识别服务（本地化）  | `downloads/`、`objects/`                                 | URL 下载、inline 解码落盘与晋升 |
| Policy Tool         | 仅注入的 `staging/<invocationId>/`                       | 不允许写 objects 或 workspace   |
| Orchestrator/bridge | `objects/`、`quarantine/`                                | 晋升与隔离，唯一的状态迁移者    |
| Memory / Recall     | 只读 `objects/`                                          | 通过 managedId 解析，不写入     |
| GC                  | 删除 `objects/`、`downloads/`、`staging/`、`quarantine/` | 见 §6                           |

用户原始输入的本地文件**不复制进对象库**：它们留在原位置，Memory 以
`localPath + sha256` 记录身份（识别设计 §6.5）。只有"Qwen Code 自己生成或
下载的字节"才进入 `objects/`。这避免大视频在磁盘上双份存放；代价是用户文件
被移动/删除后 Recall 返回 `artifact_unavailable` gap，这是 Memory 设计 §12 已
定义的正常路径。

## 6. 生命周期与垃圾回收

### 6.1 启动恢复

每次启动（或首次触碰 Omni 链路时）执行一次恢复扫描：

1. 删除 `staging/` 下所有目录——它们属于未完成的 invocation，对应的
   `OmniPolicySucceeded` 必然未提交（提交成功即已删除 staging），Memory 中不
   存在引用；
2. 删除超过保留期的 `downloads/*.part`（续传窗口内的保留）；
3. 按预算清理 `quarantine/`；
4. 校验 `objects/` 中随机抽样对象的文件名与实际 hash 一致（廉价的损坏探测，
   不做全库校验）。

### 6.2 mark-and-sweep GC

- **根集合**：Memory store 中全部 active 记录引用的 managedId（含历史版本仍
  被 provenance 引用的对象）+ 当前运行 session 的 MediaResourceRegistry 正在
  使用的对象；
- **清扫对象**：不在根集合中、且自晋升起超过 `retentionDays` 的对象；宽限期
  保证"晋升成功但 Memory 提交失败"的孤儿和跨进程 race 不被立刻误删；
- **触发时机**：启动恢复后异步执行；超过 `maxTotalBytes` 时提前触发，仍超限
  则从最旧的无引用对象继续删除；**有引用对象永不删除**，即使超预算——此时
  告警并停止新的衍生物产生（等价于 Policy 设计 §8.4 的预算停止语义）；
- GC 与 Memory 的一致性：先从 Memory 确认无引用，再删除文件；不存在"先删
  文件再改记录"的窗口。

## 7. 配置

```jsonc
{
  "omni": {
    // 受管媒体存储配置；全部纳入 resolved Omni config hash。
    "storage": {
      // 无引用对象自晋升起的保留天数；到期后可被 GC 清扫。
      "retentionDays": 14,
      // objects 区域的总容量软预算；超限提前触发 GC 并告警。
      "maxTotalBytes": 21474836480,
      // 中断下载 .part 的续传保留窗口（小时），超期启动时清理。
      "partRetentionHours": 48,
      // 失败隔离区配置。
      "quarantine": {
        // 隔离产物保留天数，供实验调试。
        "retentionDays": 7,
        // 隔离区容量上限，超限按最旧优先删除。
        "maxBytes": 5368709120,
      },
    },
  },
}
```

校验：所有数值必须为正；`maxTotalBytes` 不得小于 transport guard 单媒体上限的
10 倍（防止配置出一个装不下正常实验产物的库）。scope 合并沿用 Omni 统一语义。

## 8. 上传缓存

投递层统一采用 DashScope 官方临时上传（Policy 设计 §10.3），本存储为其维护
上传缓存——对象字节到 48h 有效 oss:// URL 的映射：

```text
uploads: (sha256, model) → {
  ossUrl: "oss://dashscope-instant/…",
  uploadedAt: string,
  expiresAt: string,   // uploadedAt + urlTtlHours（默认 47h，对官方 48h 留余量）
}
```

规则：

- 缓存 key 包含 model：官方文档声明文件与模型绑定（实测更宽松，但按文档保守
  处理），换模型触发重传；
- 缓存 miss 或过期时，upload service 从 `objects/` 读取字节重传，写回新条目；
- **oss URL 只存在于上传缓存**，Memory、执行记录与任何持久协议都只引用
  sha256——URL 是投递缓存，不是身份；
- 对象被 GC 删除时，联动删除其全部 uploads 条目；反向不成立（缓存过期不影响
  对象）；
- 缓存的持久化形态与 Memory store 同级决定（同一后端或独立轻量表均可），但
  必须在进程重启后存活——否则每次重启都重传全部媒体；
- 上传缓存不参与对象引用计数：uploads 条目不能阻止 GC。

## 9. 失败语义

| 场景                         | 行为                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| 对象晋升时目标 hash 已存在   | 去重命中，丢弃临时文件，复用现有对象                                     |
| 晋升成功、Memory 提交失败    | 孤儿对象留在 objects，GC 宽限期后回收                                    |
| 晋升中途崩溃                 | 残留 `.tmp` 启动时清理；不存在半个可见对象                               |
| staging 目录在提交前崩溃残留 | 启动时整目录删除，Memory 无引用                                          |
| 对象文件被外部删除/损坏      | Recall 返回 `artifact_unavailable` gap；抽样校验发现损坏时同样降级并告警 |
| quarantine 超预算            | 最旧优先删除，只影响调试可见性                                           |
| objects 超预算且全部有引用   | 告警并拒绝新衍生物产生，不删除有引用对象                                 |
| 上传缓存条目指向已 GC 对象   | 条目联动删除；投递时按 miss 处理                                         |
| 缓存未过期但服务端已失效     | 投递收到 Provider 错误后使该条目失效并重传一次；仍失败则 fail closed     |
| 发现 symlink 或非普通文件    | 拒绝该路径并告警，不跟随                                                 |

## 10. 与现有机制的关系

- **session artifact store**（daemon-session-artifacts）：继续承担 UI 展示与
  session 级 metadata，其 session-scoped ID 与本存储无关；Omni artifact 的
  UI 展示仍可经现有 `artifacts` 通道，但物理文件归本存储管理；
- **`ToolArtifact.storage: 'managed'`**：Omni 场景下 `managedId` 语义固定为
  本存储的对象键；
- **workspace 文件**：Policy Tool 不写 workspace；`storage: 'workspace'` 的
  artifact 仅用于用户显式要求落到工作区的场景，不受本存储 GC 管理；
- **Memory store**：引用关系的唯一权威；本存储不维护独立引用计数或 manifest，
  避免双账本漂移。

## 11. 验收标准

- 同一字节内容从两个来源进入，`objects/` 只存一份，两个 File 的 Memory 记录
  各自完整；
- policy 多产物提交是"全部晋升 + 一次 Memory 事务"，杀进程后重启不存在
  Memory 指向缺失文件的引用；
- 失败 invocation 的产物完整出现在 `quarantine/` 且带 reason.json，不可被召回；
- 启动恢复清理 staging/.tmp/过期 .part，不触碰有引用对象；
- GC 只清扫无引用且超保留期的对象；把 Memory 记录删除后对应对象在保留期后
  被回收；
- 超容量预算时告警并停止新衍生物，有引用对象仍在；
- `.qwen/omni/` 不进入 git status；未信任 workspace 不创建该目录；
- 模型与协议层可见的只有 `sha256:<hash>` 形式的 managedId，任何返回中不出现
  真实路径。

## 12. 实现阶段确认的细节

- 抽样完整性校验的比例与频率；
- `downloads/` 续传元数据（ETag/offset）的存放形式；
- GC 与多进程并发（同一 project 开多个 Qwen Code 实例）的锁策略——初版可用
  目录锁 + "GC 只在持锁进程执行"；
- 对象库是否需要按媒体类型分区统计（实验报表用途）。
