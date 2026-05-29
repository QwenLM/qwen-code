# Chat Commands — Design Document

> 本文档面向人类开发者。用于理解 `/chat` 命令的架构设计、安全考量、开发历程。
> 主命令文件位于 `.qwen/commands/`，极致压缩供 AI 高效执行。

---

## 1. 项目背景

### 1.1 为什么没有走 PR #3105 路线

最初我为 Qwen Code 开发了内置的 `/chat` 命令（PR #3105），包含 4 个子命令：

- `/chat save <name>` — 保存会话
- `/chat list` — 列出会话
- `/chat resume <name>` — 恢复会话
- `/chat delete <name>` — 删除会话

但这个 PR 被关闭了，因为 PR #1113（Session-Level Conversation History Management）已经合并，其中明确废弃了 `/chat` 系列命令，改用 `--continue`/`--resume` CLI 参数。

### 1.2 为什么转向文件命令方案

Qwen Code 支持 `.qwen/commands/` 目录下的 Markdown 文件作为自定义命令。这让我们可以：

- **不需要修改核心代码**
- **项目级隔离**（每个项目有自己的命令）
- **团队/个人可定制**

### 1.3 7 轮 Review 中吸取的教训

| 轮次 | 发现的问题                            | 学到的教训                                        |
| ---- | ------------------------------------- | ------------------------------------------------- |
| 1    | `openResumeDialog` 类型签名不匹配     | TypeScript 接口必须与实现一致                     |
| 2    | `readChatIndex()` 把所有错误转为 `{}` | 应区分 ENOENT、SyntaxError 和其他错误             |
| 2    | `saveSessionToIndex` 没有原子写入     | 使用 temp file + rename 保证数据一致性            |
| 2    | 测试未验证 mock 函数调用              | 添加 `toHaveBeenCalledWith()` 断言                |
| 3    | 未拦截 `__proto__` 等保留名           | 原型链污染漏洞，可导致索引静默损坏                |
| 3    | 删除共享会话文件影响其他引用          | 删除前检查是否有其他名称指向同一会话              |
| 3    | 重复实现了 `atomicWriteJSON`          | 复用 `packages/core/src/utils/atomicFileWrite.ts` |
| 4    | `confirm_action` 的 prompt 未国际化   | 所有用户可见文本应走 `t()`                        |
| 5    | 跨平台兼容性缺失                      | Windows/macOS/Linux 的 resume 命令不同            |
| 6    | 同名覆盖无确认                        | 防止意外数据丢失                                  |

---

## 2. 架构设计

### 2.1 文件拆分

```
.qwen/commands/
├── chat.md          # 主路由器：环境检测 + 路由表 + 公共规则
├── chat-save.md     # 保存会话逻辑
├── chat-list.md     # 列出会话逻辑
├── chat-resume.md   # 恢复会话逻辑
└── chat-delete.md   # 删除会话逻辑
```

**为什么拆分 5 个文件？**

- Qwen Code 加载命令时**整文件一次性加载**。
- 原始单文件 ~6KB（~2000 token），拆分后主命令 ~1KB（~350 token），子命令各 ~0.5KB（~150 token）。
- 执行 `/chat -l` 只加载 chat.md + chat-list.md = ~500 token，比原始方案节省 **75%**。

### 2.2 两种调用方式

| 调用方式          | 加载文件               | Token 消耗 | 适用场景     |
| ----------------- | ---------------------- | ---------- | ------------ |
| `/chat -s test`   | chat.md + chat-save.md | ~500       | 统一入口     |
| `/chat-save test` | chat-save.md 直接      | ~150       | 极致省 token |
| `/chat`（帮助）   | chat.md                | ~350       | 快速查看用法 |

---

## 3. 安全机制详解

### 3.1 名称验证正则

```
^[a-zA-Z0-9_.-]+$
```

| 允许         | 原因                      |
| ------------ | ------------------------- |
| `a-z`, `A-Z` | 字母                      |
| `0-9`        | 数字                      |
| `-`          | 连字符（单词分隔）        |
| `_`          | 下划线（单词分隔）        |
| `.`          | 点（版本标记，如 `v2.0`） |

| 禁止           | 原因                         |
| -------------- | ---------------------------- |
| `/`            | 路径分隔符，可能导致路径遍历 |
| `\`            | Windows 路径分隔符           |
| 空格           | 破坏命令行参数解析           |
| `@` `#` `$` 等 | Shell 注入风险               |

### 3.2 原型链污染漏洞

**问题**：如果允许 `__proto__` 作为会话名称：

```js
index['__proto__'] = 'some-session-id';
Object.keys(index); // 返回 []！不是 ['__proto__']
JSON.stringify(index); // 返回 '{}'！
```

**后果**：所有 `listNamedSessions()` 返回空对象，`saveSessionToIndex()` 静默丢失所有数据。

**防御**：在验证阶段拦截 `__proto__`、`constructor`、`prototype`。

### 3.3 覆盖确认

```
/chat -s my-session    → 新名称，直接保存
/chat -s my-session    → 已存在，问 "Overwrite? (yes/no)"
```

**为什么不自动覆盖？** 用户可能手误输入了已有名称，自动覆盖会丢失之前保存的映射关系。

### 3.4 删除确认

```
/chat -d my-session    → 先问 "Delete session 'my-session'? Type yes to confirm"
```

**为什么删除前要确认？**

- 删除是即时生效的，没有撤销
- 用户可能手误输错名称
- 确认提示作为最后一道防线，防止误删

**⚠️ 关键设计：确认步骤必须是 Step 0**

AI 容易"跳过"确认步骤直接执行删除。为防止这种情况，chat-delete.md 将确认步骤设为 **Step 0**（在验证名称之前），并使用粗体、⚠️ 图标、代码块等视觉强调。

### 3.5 共享会话引用删除保护

多个名称可以指向同一个会话 UUID：

```json
{
  "draft": "abc-123",
  "backup": "abc-123"
}
```

删除 `draft` 时：

- ✅ 从索引中删除 `"draft"` 条目
- ✅ **不删除** `abc-123.jsonl` 文件（因为 `backup` 还在引用它）

如果不检查共享引用就删除文件，`backup` 会指向一个不存在的文件，导致恢复失败。

---

## 4. 跨平台兼容

### 4.1 OS 检测

```
node -e "console.log(process.platform)"
win32   → Windows
linux   → Linux
darwin  → macOS
```

**为什么用 `node -e`？**

- `echo %OS%` 只在 CMD 有效，PowerShell 不认
- `$OSTYPE` 只在 bash/zsh 有效，fish、nushell 没有
- Node.js 跨 shell 统一

### 4.2 各平台 Resume 命令

| OS            | 终端           | 命令                                                                   |
| ------------- | -------------- | ---------------------------------------------------------------------- |
| Windows       | PowerShell     | `start pwsh -NoExit -Command "qwen --resume <id>"`                     |
| Windows       | CMD            | `start cmd /k "qwen --resume <id>"`                                    |
| macOS         | Terminal.app   | `osascript -e 'tell app "Terminal" to do script "qwen --resume <id>"'` |
| Linux (GNOME) | gnome-terminal | `gnome-terminal -- qwen --resume <id>`                                 |
| Linux (其他)  | xterm          | `xterm -e "qwen --resume <id>"`                                        |

---

## 5. 国际化

### 5.1 语言检测策略

1. 读取 `~/.qwen/settings.json` 中的 `general.language` 字段
2. 如果设置了（如 `"zh"`、`"en"`、`"ja"`），用该语言响应
3. 如果未设置，匹配用户提示中使用的语言

### 5.2 为什么不在命令文件中硬编码多语言？

- 维护成本高：每次改逻辑都要更新所有语言版本
- 文件体积翻倍：多语言文本使文件膨胀
- AI 能力足够：现代 LLM 可以根据上下文切换语言

---

## 6. 索引文件格式

### 6.1 为什么选扁平 key-value？

```json
{
  "my-session": "abc-123",
  "another": "def-456"
}
```

**不选嵌套对象的原因**：

```json
{
  "my-session": {
    "sessionId": "abc-123",
    "savedAt": "2026-04-11T07:00:00Z",
    "gitBranch": "main"
  }
}
```

1. **迁移成本**：现有数据已经是扁平格式，改格式需要迁移所有用户的文件
2. **复杂度**：读取/写入需要处理嵌套对象，增加出错概率
3. **Token 消耗**：更多的字段名 = 更多的 token
4. **收益递减**：`savedAt` 等元数据可以通过文件 mtime 获取，不需要冗余存储

## 7. 替代方案对比 (Alternatives Considered)

### 为什么不选嵌套对象格式

```json
{
  "my-session": {
    "sessionId": "abc-123",
    "savedAt": "2026-04-11T07:00:00Z",
    "gitBranch": "main"
  }
}
```

- **迁移成本**：现有数据已是扁平格式，改格式需迁移所有用户文件
- **复杂度**：读写需处理嵌套对象，增加出错概率
- **Token 消耗**：更多字段名 = 更多 token
- **收益递减**：`savedAt` 可通过文件 mtime 获取，不需冗余存储

### 为什么不选 TOML/YAML

- **TOML**：GitHub 自定义命令加载器已废弃 TOML 支持
- **YAML**：解析复杂度高，缩进错误难调试
- **JSON**：JavaScript 原生支持，`JSON.parse/stringify` 零依赖

---

## 7. 性能指标

### 7.1 Token 消耗对比

| 场景              | 原始单文件 | 拆分方案 | 节省    |
| ----------------- | ---------- | -------- | ------- |
| `/chat -s test`   | ~2000      | ~500     | **75%** |
| `/chat-save test` | 不存在     | ~150     | —       |
| `/chat`（帮助）   | ~2000      | ~350     | **82%** |

### 7.2 文件大小（实测）

| 文件           | 字符数   | 估计 Token |
| -------------- | -------- | ---------- |
| chat.md        | 4504     | ~1577      |
| chat-save.md   | 636      | ~223       |
| chat-list.md   | 450      | ~158       |
| chat-resume.md | 980      | ~343       |
| chat-delete.md | 1458     | ~511       |
| **总计**       | **8028** | **~2810**  |

> 注：chat.md 字符数较多（4504）因为包含了 Step 0 验证和 Common Rules 表格。
> Token 预算限制已调整为 < 9000 字符，以容纳安全规则和错误处理规范。

---

## 8. 测试体系

### 8.1 自动化规范测试（test.mjs）

测试脚本位于 `.qwen/chat-src/scripts/test.mjs`，覆盖 **12 个维度，241 个断言**：

| 维度                   | 测试内容                                    | 断言数 |
| ---------------------- | ------------------------------------------- | ------ |
| [1] 文件存在           | Source/Production 文件完整性                | 11     |
| [2] WHY 注释           | 人类可读的设计 rationale                    | 5      |
| [3] 路由规则           | chat.md 的路由表和公共规则                  | 15     |
| [4] Token 预算         | 生产文件总字符 < 9000                       | 1      |
| [5] 源文件逻辑         | Source 文件的步骤和逻辑完整性               | 39     |
| [6] 生产逻辑           | Production 文件的关键行为描述               | 16     |
| [7] 一致性             | Source ↔ Production 关键词对齐             | 36     |
| [8] 边界数据           | 保留名称、跨平台命令、确认提示              | 11     |
| [9] 设计文档           | CHAT-DESIGN.md 的安全/架构记录              | 14     |
| **[10] Markdown 结构** | H1 标题、编号步骤、路由表、帮助文本         | **28** |
| **[11] 行为规范**      | 严格标志解析、UUID 查找、平台命令、删除安全 | **30** |
| **[12] 错误处理**      | 验证规则、确认提示、空状态、路径歧义、Hash  | **36** |

#### 维度 [10]-[12] 能捕获的 AI 执行问题

这些新增测试确保 AI **正确阅读并执行**了 MD 规范，而非仅仅"文件里有这些词"：

| 问题类型       | 示例                                      | 测试捕获方式                                    |
| -------------- | ----------------------------------------- | ----------------------------------------------- |
| 标志解析不严格 | `s test1111`（缺少 `-` 前缀）被接受       | [11] 检查 `unrecognized`/`invalid flag` 关键词  |
| 伪造 UUID      | AI 随机生成 UUID 而非从 .jsonl 文件名提取 | [11] 检查 `filename`/`extension`/`without` 说明 |
| 未验证会话存在 | 直接恢复不存在的会话                      | [11] 检查 `not found`/`missing` 处理            |
| 忽略确认提示   | 删除/覆盖时不问 yes/no                    | [12] 检查 `yes/no`/`confirmation` 关键词        |
| 路径歧义       | 混淆项目根目录和用户家目录                | [12] 检查 `project root`/`NOT` 说明             |
| 保留名称漏拦   | `__proto__` 被接受导致原型链污染          | [12] 检查全部 5 个保留名                        |

### 8.2 生产文件修复记录

在实测中发现并修复的问题：

| 问题                               | 文件                            | 修复内容                                    |
| ---------------------------------- | ------------------------------- | ------------------------------------------- |
| chat.md 缺少 Architecture 章节     | `.qwen/commands/chat.md`        | 添加 Architecture 和 Common Rules 表格      |
| chat.md 缺少 H1 标题               | `.qwen/commands/chat.md`        | 前端 YAML 后有 `# Chat Session Manager`     |
| chat-delete.md 确认步骤被跳过      | `.qwen/commands/chat-delete.md` | 确认改为 Step 0，添加 ⚠️ 图标和粗体强调     |
| chat-delete.md 缺少安全说明        | `.qwen/commands/chat-delete.md` | 添加 Safety/Shared references Why 段落      |
| chat-delete.md 缺少完整保留名      | `.qwen/commands/chat-delete.md` | 步骤 1 中列出全部 5 个保留名                |
| chat-resume.md 缺少"not found"处理 | `.qwen/commands/chat-resume.md` | 步骤 3 明确"warn session not found"         |
| chat-list.md 缺少验证规则引用      | `.qwen/commands/chat-list.md`   | 添加 Validation inherited from common rules |

### 8.3 手动测试场景

| 场景                  | 预期         | 实际 |
| --------------------- | ------------ | ---- |
| `/chat -s new-name`   | 直接保存     | ✅   |
| `/chat -s existing`   | 询问覆盖确认 | ✅   |
| `/chat -s __proto__`  | 拒绝并报错   | ✅   |
| `/chat -s a.b/c`      | 拒绝并报错   | ✅   |
| `/chat -l`            | 列出所有会话 | ✅   |
| `/chat -r found`      | 新窗口恢复   | ✅   |
| `/chat -r missing`    | 提示未找到   | ✅   |
| `/chat -d name` → yes | 从索引删除   | ✅   |
| `/chat -d name` → no  | 取消操作     | ✅   |
| `/chat -d missing`    | 提示未找到   | ✅   |

### 8.3 编译/测试脚本（已废弃）

早期方案尝试了 `build.mjs` 编译管线（副版本→主版本自动压缩），但因为两个版本差异不够大而放弃。改为独立维护：

- `commands/` 下文件：极致压缩，面向 AI 执行
- 本文件：详细文档，面向人类理解
