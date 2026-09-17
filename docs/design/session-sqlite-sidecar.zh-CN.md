# 会话列表与 transcript 导航的 SQLite sidecar 索引

- 状态:草案(feature flag 控制,默认关闭)
- 关联 issue:#11433(设计讨论)、#11493(评估中发现的缓存准入悬崖)
- 日期:2026-09-10
- 英文版:[session-sqlite-sidecar.md](./session-sqlite-sidecar.md)

## 1. 问题陈述

会话读取目前由两套发生在每次进程启动时的"内存 + 文件"机制提供,索引数据每次都要重新推导:

1. **会话列表**(`SessionService.listSessions`,
   `packages/core/src/services/sessionService.ts:2520`):每次调用做
   `readdirSync` + 逐文件 `statSync` + 全量 mtime 排序;填充一页还要逐个
   打开候选文件读首行。`MAX_FILES_TO_PROCESS = 10000` 会在超过一万个文件
   后直接截断枚举。
2. **transcript 索引**(`SessionTranscriptReader.buildIndex`,
   `packages/core/src/services/session-transcript-reader.ts:1939`):索引缓存
   未命中时,要先把整个快照扫描并逐行解析,才能服务任何分页操作。缓存是
   进程内的(32 条 / 64MiB / 5 分钟 TTL,`:397`),而且它的字节预算是在
   **准入**路径上执行的、不做 LRU 淘汰(`:2278`)——一旦工作集的索引估算
   合计超过 ~64MiB,就退化为"每次读取 = 全量重扫"(#11493)。超过 256MiB
   的快照被直接拒绝(`:89`)。

在 main @ `19ba03fb70` 实测(Node 22,形状真实的合成语料;harness 在
`.qwen/bench-sqlite/`,方法已发到 #11433):

| 负载                                 | 当前实现              | 成本根源               |
| ------------------------------------ | --------------------- | ---------------------- |
| 列表首页,1k / 5k / 10k 会话          | 14.9 / 28.9 / 50.7 ms | O(N) stat + 排序       |
| 列表翻完全部,1k / 5k / 10k(size=100) | 0.42 / 3.0 / 8.3 s    | O(N) 打开文件 + 读首行 |
| turn 页,11–202MB 会话,冷             | 29–365 ms(~1.8ms/MB)  | 全文件扫描 + 解析      |
| turn 页,热但索引缓存超预算           | **每次** 350–450ms    | 准入拒绝,无 LRU 淘汰   |
| daemon 重启 + resume/attach          | 每个会话全量重扫      | 进程内缓存丢失         |

已被生产部署确认的负载:多天级长会话(数百 MB)、channel 单会话持续
增长、daemon 频繁重启伴随 resume/attach、2–4 vCPU 小规格主机(内存里的
索引驻留更加昂贵)。

## 2. 方案设计

JSONL transcript 保持为**唯一权威存储**。每个项目目录下放一个 SQLite
数据库作为**可重建的 catalog/索引 sidecar**。它随时可以被删除:所有读
路径自动回退到今天的行为,索引从 JSONL 尾部惰性增量重建。

### 2.1 Provider 抽象

```
packages/core/src/services/session-index/
├── types.ts            # SessionIndexProvider 接口 + 选项/结果类型
├── config.ts           # 进程级配置 + 驱动探测 + store 单例
├── sqlite.ts           # node:sqlite 驱动实现
```

- provider 提供两个能力:`listSessionsPage`(catalog 分页,替代扫描式
  填充)与 `sessionTurnIndex`(单会话 turn 起点 + 字节偏移,替代
  `buildIndex` 的 turn 导航路径)。
- "文件扫描 provider"是隐式的:SQLite provider 不可用时走的就是今天的
  代码路径——"provider 返回 null"**就是**回退,模式同
  `getPty.ts` 可选依赖先例(动态 import,失败返回 null)。
- **进程级配置**(`configureSessionIndexing({ mode })`)在有 settings 的
  进程入口调用一次,模式同 `Storage.setRuntimeBaseDir()` 静态模式——覆盖
  全部 ~40 个绕过 `Config` 的 `new SessionService(cwd)` 调用点,以及
  `SessionService` 内自持 reader(`sessionService.ts:833`)与直接构造
  reader 的位置。

### 2.2 设置开关

```jsonc
// settings.json
{ "experimental": { "sessionIndex": "file" } } // "file"(默认)| "sqlite"
```

- 在 `packages/cli/src/config/settingsSchema.ts` 声明(唯一真源,模式同
  `experimental.agentTeam`),经 `scripts/generate-settings-schema.ts` 重新
  生成 JSON schema。
- CLI(`packages/cli/src/config/config.ts` 的 `loadCliConfig`)与 daemon
  启动(`packages/cli/src/commands/serve.ts`,直接 loadSettings、不经过
  loadCliConfig)都把它翻译成 `configureSessionIndexing()`。
- 上游默认关闭。开关选择的是"provider",不是存储格式:双向切换都不迁
  移任何数据。

### 2.3 驱动选型

`node:sqlite`,每进程动态 import 一次:

- 零依赖、零字节、零供应链 diff;Node ≥22.13 免 flag(实测 22.23),Bun
  ≥1.4 实测可用——即当前全部分发形态(npm、standalone-node、
  standalone-bun preview)。
- import 失败(Node 22.0–22.12 或实验 API 变动)→ provider 返回 null →
  回退文件扫描。默认关闭 + 回退语义使驱动风险对未开启用户不可见。
- `better-sqlite3` 是备案 Plan B(两种分发形态都已有原生 addon 打包先
  例:esbuild externals + 按架构拷贝 prebuild,见
  `scripts/create-standalone-package.js`),刻意不启用:为一个可选特性引
  入新的供应链面不值得。
- wasm SQLite 被否决:Node 侧持久化 VFS 不成熟,"内存库 + 整库落盘"
  会让增量同步的写成本优势消失。

### 2.4 数据模型

`projects/<projectDir>/sessions.index.sqlite`(WAL,`synchronous=NORMAL`):

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
-- schema_version;不匹配 => 整库删除重建

CREATE TABLE sessions(           -- 会话目录,驱动列表分页
  sessionId     TEXT PRIMARY KEY,
  fileName      TEXT NOT NULL,
  mtimeMs       INTEGER NOT NULL,
  sizeBytes     INTEGER NOT NULL,
  startTime     TEXT,
  firstPrompt   TEXT,
  customTitle   TEXT,
  gitBranch     TEXT,
  cwd           TEXT,            -- 与今天同语义的 project 归属过滤
  recordCount   INTEGER NOT NULL,
  indexedBytes  INTEGER NOT NULL -- 字节检查点:索引覆盖 [0, indexedBytes)
);
CREATE INDEX sessions_mtime ON sessions(mtimeMs DESC);

CREATE TABLE records(            -- 单会话记录偏移,驱动 turn 导航
  sessionId  TEXT NOT NULL,
  seq        INTEGER NOT NULL,   -- 文件内行序
  uuid       TEXT NOT NULL,
  parentUuid TEXT,
  type       TEXT NOT NULL,
  subtype    TEXT,
  turnStart  INTEGER NOT NULL DEFAULT 0,
  offset     INTEGER NOT NULL,
  length     INTEGER NOT NULL,
  PRIMARY KEY(sessionId, seq)
) WITHOUT ROWID;
CREATE INDEX records_uuid ON records(sessionId, uuid);
```

实测体积:DB ≈ JSONL 的 6–24%(数百 MB 长会话 6.4%;一万小会话语料
24%)。全量构建一万会话 / 42 万记录 = 3.9s 一次性;追加 ~60 条记录的增
量追平 = 2.3ms。

### 2.5 一致性协议

sidecar 精确知道自己覆盖了权威数据的哪一段:

1. **追加**:`indexedBytes <= size` → 只扫 `[indexedBytes, size)` 到最后
   一个完整行;单事务插入;推进检查点。(JSONL 追加的记录从不原地重写;
   尾部半行在下一次 flush 补齐前被排除。)
2. **收缩/替换**:`indexedBytes > size` → rewind:删除该会话全部行并从
   零重建。永不尝试对着文件"修" sidecar。
3. **服务前校验**:读路径对目标文件做一次 `stat`(与现有代码同一个系
   统调用),比对 `mtimeMs/sizeBytes`;不一致先增量同步。
4. **崩溃窗口**:进程死于 JSONL append 与索引更新之间 → 下次 sync 看
   到 `indexedBytes < size` 自然追平。事务中途崩溃原子回滚;检查点永远
   不声明未覆盖的字节。
5. **派生 turn 缓存**:`readTurnIndexPage` 额外持久化每个会话的派生导
   航 turns(`turns_cache`),按导出时的 `indexedBytes` 检查点键控——后
   续翻页 = 一行读取 + 少量 `pread`。追加越过检查点即整体失效;会话行
   被删除(GC、rewind 重建)时同步删除。
6. **目录同步(仅列表)**:每次调用都按文件名对账(readdir 只取名,加
   GC 删除),逐文件 stat 扫描用 TTL(默认 30s)限速;TTL 窗口内新建的
   文件立即索引,turn 读路径总是 stat 校验自己的目标文件——陈旧有界,
   永不结构性失控。
7. **损坏/打开失败/schema 不匹配**:删除 DB 文件,本次请求回退文件扫
   描,惰性重建。只记 debug 日志;索引问题永不让用户看到错误。

并发:WAL 下读不阻塞写;单写者经"每进程一条共享连接 + busy_timeout"
执行,daemon 持有长寿命写入;CLI 短进程自开连接,最坏是短暂 busy 重试
后回退。store 内部用 promise 队列串行所有 sync,杜绝单连接上交错的
`BEGIN … await … COMMIT`。

### 2.6 读路径集成

| 路径                                        | 有 provider                                                                                                                                                                                                                            | 任何 provider 故障     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `SessionService.listSessions`               | 名称对账 + `sessions` 表窗口化 keyset 分页(每窗 SQL `LIMIT`,mtime 降序;等值 mtime 并列与 legacy 严格 `<` 同样跳过)                                                                                                                     | 与今天完全相同的扫描   |
| `SessionTranscriptReader.readTurnIndexPage` | `turns_cache` 命中 → 窗口切片 + `pread` 选定 JSONL 段(uuid/sessionId 校验,不符抛 `SessionTranscriptSnapshotUnavailableError`);未命中 → 用与 `buildIndex` 相同的规则从 `records` 行派生、落盘、服务。256MiB 上限同样强制执行,同类型错误 | 现有 `buildIndex` 路径 |
| `SessionTranscriptReader.readPage`          | **本 PR 不变**(仍走内存索引)                                                                                                                                                                                                           | —                      |

`readTurnIndexPage` 的输出在 parity 套件(`session-index/parity.test.ts`)
中按字段逐项对照:双向 snapshot 续页、glued-line fragments、
append-after-cache 失效、sweep 间新建会话可见性。串行 sync 队列与
in-flight store 单例保证 daemon 并发路由落在同一条安全写时间线上。

### 2.7 与 daemon catalog cache 及 #11493 的关系

- daemon 的持久 JSONL catalog cache("cache 不是文件系统事务")与本设计
  同哲学;开关打开时 daemon 列表改走 provider,JSON catalog 仍是默认。
  两者都是可重建 sidecar,无需迁移。
- #11493(字节预算准入不淘汰)与本文正交、值得独立修复;开关开启后它
  不再承重,因为热路径不再依赖进程内缓存(进程内缓存降级为 L1,s,持久
  索引是 L2)。

## 3. 涉及文件

- **新增**:`packages/core/src/services/session-index/{types,config,sqlite}.ts`
  (及 collocated 测试)
- `packages/core/src/services/sessionService.ts` — `listSessions` 中的
  provider 查找
- `packages/core/src/services/session-transcript-reader.ts` —
  `readTurnIndexPage` 中的 provider 查找(写路径内联同步 hook 评估后放
  弃:读路径 stat 校验已把陈旧限制在正确边界内)
- `packages/cli/src/config/settingsSchema.ts` — `experimental.sessionIndex`
  (+ 重新生成 `packages/vscode-ide-companion/schemas/settings.schema.json`)
- `packages/cli/src/config/config.ts`(`loadCliConfig`)与
  `packages/cli/src/commands/serve.ts`(daemon 启动)— settings →
  `configureSessionIndexing()`
- 测试:provider parity 套件、故障注入(损坏 DB、截断 JSONL、半行、
  schema 不匹配)

## 4. 范围边界

- **不做**权威 SQLite 生命周期存储(issue 方案三):prompt 日志、状态版
  本、undo 事件保持 append-only JSONL。
- **不做** `readPage` / 由 SQL 全量物化 `SessionIndex`(后续;内存索引缓
  存继续服务记录级分页)。
- **不做**全文搜索 / FTS5。
- **不迁改** daemon catalog 语义;ACP / vscode 经现有 daemon 路由透明继
  承。
- **无迁移/回填命令**——首次使用时惰性增量建索引。

## 5. 待回答问题

1. sweep TTL 默认值(30s)——上线后按 daemon 遥测调整。
2. `node:sqlite` 在 Node 24 线的稳定性声明在翻转默认值前需复查;若 bun
   的 OpenTUI flavor 转正,需为 sidecar 加 bun CI 冒烟。
3. 遥测:`session_index.sync_duration_ms` / `session_index.fallback_total`
   待开关有真实用量后随快速跟进补上(回应 issue 的"先测量"要求)。
