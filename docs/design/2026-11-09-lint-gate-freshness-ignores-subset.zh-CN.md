# 把基线侧新增全局 eslint ignores 视为不致过期的门禁改动

[English](2026-11-09-lint-gate-freshness-ignores-subset.md) | [简体中文](2026-11-09-lint-gate-freshness-ignores-subset.zh-CN.md)

状态：已实现并本地验证，尚未合入

## 问题陈述

`Check lint gate freshness` 会在基线分支于本分支上次纳入之后改动了门禁定义文件时判定 PR 失败。它是 `Lint & Static` lane 的第二大红灯来源：在最近的 60 个失败 `Qwen Code CI` run 样本中（2026-11-08 17:00Z – 2026-11-09 01:20Z），有 30 个 `Lint & Static` 变红，其中 9 个失败在这一步。

逐一读出九份日志里的真实触发源后可以确认，这些红并不是这个检查当初要抓的东西：

| 触发提交                 | 红次数 | 实际改动                                                               |
| ------------------------ | ------ | ---------------------------------------------------------------------- |
| `1888aaf49d52`（#16200） | 9/9    | `eslint.config.js`：往全局 `ignores` 数组加了一条                      |
| `0dd106d42fd4`（#16659） | 1/9    | `ci.yml`：往 `HELPER_TESTS` / `HELPER_TESTS_DEP_FREE` 追加一个测试文件 |
| `65e1f1aeaaa8`（#16551） | 1/9    | `ci.yml`：外部 PR 的 runner 路由                                       |

九次中有两次同时点名 `eslint.config.js` 与一个 `ci.yml` 提交，因此计数之和大于九。九次全部点名了 #16200。

占主导的触发源 #16200 加的正是这些：

```
       'packages/**/dist/**',
+      // Built host bundle; the glob above needs a literal `dist` segment.
+      'packages/web-shell/dist-managed-host/**',
```

新增一条全局 ignore 会把文件移出 lint 范围。尚未纳入它的分支所 lint 的是基线门禁所 lint 范围的**超集**，因此它的绿只会更强，不会更弱。然而检查仍然判它失败；又因为该 lane 只 checkout 分支 head，同一个 commit 重跑永远不可能转绿。唯一补救是合入 `main` 再推送，重启整个矩阵。

## 现状

`.github/scripts/check-lint-gate-freshness.mjs` 中的 `findStaleGateFiles()` 对每个门禁文件花两次 API 调用：

1. `GET /repos/{repo}/commits?path={file}&sha={baseRef}&per_page=1` —— 基线侧触碰该文件的最新提交。
2. `GET /repos/{repo}/compare/{candidateSha}...{headSha}` —— 交换方向的三点 compare，其 `ahead`/`identical` 状态表示分支已包含该提交。

`diverged` 或 `behind` 即为过期。`main()` 在任何 API 错误上 fail open，因此 GitHub 的服务波动不会把所有 PR 扣为人质。

包含性只是真正重要性质的**代理指标**。这个检查存在的意义，是不让分支的绿在基线已经移动过的门禁下被认证（#11117 在 `main` 上把 Prettier lane 从 `--write` 翻成 `--check`，而 #11216 的分支仍在用 `--write` 验证）。包含性在一个方向上过度放行，在另一个方向上过度拒绝：它会拒绝一个绿仍然充分的分支，也就是上面这种情形。

`eslint.config.js` 中有三个 `ignores: [` 数组。第一个在第 58 行，是首个 config 对象内的全局数组；第 313 行与第 437 行的数组各自作用于单个 config 对象。

## 目标

- 当基线侧的 `eslint.config.js` 改动只是新增全局 ignores、且分支排除的范围不多于基线时，不再判该分支失败。
- 继续判失败于任何可能让分支的绿变得不充分的基线侧改动，包括基线侧**移除**一条全局 ignore。

## 范围边界

范围内：`.github/scripts/check-lint-gate-freshness.mjs` 及其同目录测试套件。

`.prettierignore` 在评审中加入范围。它是第 7 个门禁文件，决定 `prettier --check` 覆盖哪些文件（`scripts/lint.js` 的 `PRETTIER_CONFIG_FILE` 列了它），且最近三次提交——`e7fe14ee83`（+4/-0）、`9ebd2de171`（+3/-0）、`f3af3dd857`（+1/-0）——全是纯新增。同一条跑步机在它上面照样运行，因此收窄改为按文件分派的表，而不是写死一个文件名。

明确排除：

- 其余七个门禁文件，包括 `ci.yml`。切 `ci.yml` lint 段的方案做过原型并被证据否决：在实测的两个分支上，base 到 head 的全部差值都落在 lint 段内（就是 `HELPER_TESTS` 那几行），因此切片结论仍为过期。它对观测到的 9 次红的修复率是 0。
- 五个 config 作用域的 `ignores` 构造。它们留在逐字节比对的 remainder 中，因此对它们的任何改动仍判分支失败。
- `GATE_FILES` 不变；两个被收窄的文件都保留在清单中。
- `main()` 的 fail-open 策略不变。

## 方案

对过期结论增加一道**后置过滤**，通过 `NARROWINGS` 表按文件分派，表中有 `eslint.config.js` 与 `.prettierignore` 两项。不在表中的文件保持整文件包含性判定。

1. 原样执行现有的包含性判定逻辑。
2. 对判定为过期、且文件在表中的条目，取该文件在 `candidate.sha`（基线侧）与 `headSha`（分支侧）两处的文本。
3. 抽取它的范围清单。对 `eslint.config.js` 是第一个 `ignores: [...]` 块，得到条目列表与 **remainder**——移除了整个该块之后的文件。对 `.prettierignore`，整个文件就是范围：每个非空、且不在第零列以 `#` 开头的行都是模式，没有 remainder。只剥**尾随**空白——对 prettier 实测，`foo.js` 与 ` foo.js` 忽略的是不同文件，两端都 trim 会把不同模式归并，可能认证一个范围比基线更窄的分支；同理 `  # foo` 仍是模式。
4. 若任一侧存在会重新纳入文件的模式（见下），拒绝收窄。
5. 当分支的模式集合是基线的子集、且（对 `eslint.config.js`）两份 remainder 逐字节一致时，移除该条目。
6. 任何失败——取文本出错、锚点缺失，或条目行形状不符预期——都保留该条目。

### 为什么子集方向才是安全方向

Lint 范围是 `tree \ ignores`。分支的绿认证了 `tree \ branch_ignores` 中的每个文件。该认证覆盖基线门禁所要检查的范围，当且仅当

```
tree \ base_ignores  ⊆  tree \ branch_ignores
⟺  branch_ignores  ⊆  base_ignores
```

所以分支排除的范围必须**不多于**基线。

- #16200：`base = old ∪ {new}`，`branch = old`。子集成立，分支新鲜。这就是观测到的误报。
- 基线移除一条 ignore：`base = old \ {x}`，`branch = old`。子集不成立，分支保持过期。保护得以保留。

这是一个精确的集合条件，不是启发式，也不是「看起来安全」的提交白名单。

### 前提：条目必须是纯排除性的

上面的恒等式把每条条目都当作「把文件移出范围」。负向条目（`!glob`）恰恰相反——它把文件**重新纳入**——所以一旦有负向模式，集合代数就不再能从条目成员关系推出。

在本仓库的 eslint 9.29.0 上通过 `lintFiles` 实测，`src/keep.gen.ts` 中放入真实的 `no-var` / `no-debugger` 违规：

| 全局 ignores                         | 实际 lint 文件数 | 错误数 |
| ------------------------------------ | ---------------- | ------ |
| `['**/*.gen.ts', '!**/keep.gen.ts']` | 1                | 2      |
| `['**/*.gen.ts']`                    | 0                | 0      |

第二个列表是第一个的子集，但第一个会 lint 一个第二个根本不检查的文件。对这一对做收窄，就会认证一个「绿不足以覆盖基线门禁」的分支。因此只要任一侧存在以 `!` 开头的条目，检查就拒绝收窄。

只扫基线侧其实已经足够——若 head 是子集且含负向条目，base 必然也含它——所以 head 侧情形是被包含的，不单独写用例。

守卫还拒绝**任何含反斜杠的条目**，而不只是开头的感叹号。抽取器读的是源码文本，消费端求值的是解码后的模式，因此 `'\x21**/keep.gen.ts'` 会被原样捕获、`startsWith('!')` 判否，却仍会解码成一个负向模式。对抽取器实测：把该条目放在基线侧时，remainder 一致、子集判定通过、只看感叹号的守卫不触发——分支会被判为新鲜。这里不能靠解码解决：那意味着求值分支可控的文本，而免依赖 lane 没有解析器。遇到任何反斜杠就拒绝，是便宜的 fail-closed 形式，也顺带覆盖 `.prettierignore` 路径上 gitignore 的 `\!` 转义。

`eslint.config.js` 今天没有任何负向条目，因此该守卫在当前流量上零成本。

反例是 `lintFiles` 的实测，刻意不用 `isPathIgnored`。本设计的早期稿子曾声称 `isPathIgnored` 把两种形状都报为 ignored，那是错的，原因在探针而不在 API：配置里只有 `{ ignores: [...] }` 时没有任何 config 对象匹配 `.ts`，ESLint 因「缺少匹配配置」而视为 ignored。补上 `files: ['**/*.ts']` 后，`isPathIgnored` 能正确区分（负向 `false`、普通 `true`）。它对目录级剪枝的形状仍然失明，因此守卫引用的是 `lintFiles`。

### 为什么 remainder 必须逐字节一致

子集判定只谈论全局 ignores 数组。`eslint.config.js` 的其余每一个字节——规则严重度、plugin 接线、五个 config 作用域的 `ignores` 构造、overrides——都按精确比对处理。因此一次既新增 ignore 又收紧规则的基线侧改动仍然过期。

### 为什么只取第一个 `ignores` 块

全局数组是文件中的第一个。取第一个块会把五个 config 作用域构造留在 remainder 里，按字节比对。这是刻意保守的：作用域 ignore 的改动不做分析，直接像今天一样判分支失败。一条 meta-test 通过断言抽出的块包含 `node_modules/*`，钉住它确实是全局块。

### 用文本抽取，而非求值或 YAML/JS 解析

`.github/scripts/check-lint-gate-freshness.test.mjs` 同时列在 `HELPER_TESTS` 与 `HELPER_TESTS_DEP_FREE` 中。后者在任何依赖安装之前运行，因此脚本的 import 闭包必须只有 `node:` 内置模块。这里无法 import 解析器，而 import `eslint.config.js` 本身会执行分支可控的代码。

抽取按行锚定：

- 块从第一条匹配 `^\s*ignores:\s*\[\s*$` 的行开始，到下一条匹配 `^\s*\],?\s*$` 的行结束；
- 块体内，空行与 trim 后以 `//` 开头的行跳过；
- 其余每一行 trim 后必须匹配 `^'((?:[^'\\]|\\.)*)'\s*,?\s*(?:\/\/.*)?$`，并贡献其捕获的字面量。

把字面量锚定在行首，正是阻止尾随注释里的散文被读成条目的手段。任何不符合预期的行返回抽取失败，而不是一个静默变短的列表；收窄随即保留过期结论。

### 收窄内部 fail closed

取文本或抽取失败就地捕获并保留过期条目，而不是上抛给 `main()` 的 fail-open 处理。上抛会连同其他所有门禁文件的结论一起丢弃，把一次可选 refinement 上的偶发 curl 失败变成整体放行。收窄是一项优化，不能具备削弱门禁的能力。

### 取内容使用 raw media type

两次取内容请求 `Accept: application/vnd.github.raw`。contents API 的 JSON 表示对超过 1 MB 的文件返回空的 `content` 字段；用 raw body 可避免文件增长后静默关闭这项收窄。

## 涉及文件

| 文件                                                                 | 改动                                      |
| -------------------------------------------------------------------- | ----------------------------------------- |
| `.github/scripts/check-lint-gate-freshness.mjs`                      | ignore 块抽取器、raw 取文本接缝、后置过滤 |
| `.github/scripts/check-lint-gate-freshness.test.mjs`                 | 收窄用例、抽取器钉子、变异见证            |
| `docs/design/2026-11-09-lint-gate-freshness-ignores-subset.md`       | 本设计的英文版                            |
| `docs/design/2026-11-09-lint-gate-freshness-ignores-subset.zh-CN.md` | 本设计的中文版                            |

## 约束

- import 闭包保持只有 `node:` 内置模块。
- 本就新鲜的分支不得付出额外 API 调用；两次取文本只发生在本来就要判失败的结论上。
- 导出的 `GATE_FILES` 清单被现有用例钉住，不得改动。
- 该套件在 `node:test` 下运行，不是 vitest。

## 风险

- **自指。** 这个脚本本身就是门禁文件，因此合入它会像任何其他门禁改动一样，让所有在途 PR 红一次。PR 描述必须点明，避免由此产生的红被读成回归。
- **抽取器漂移。** 一次把多条条目放到同一行、或改用双引号的重排版会让抽取失败并静默恢复今天的行为。代价是失去这项优化，绝不会失去保护。一条 meta-test 会对树中真实的 `eslint.config.js` 运行抽取器，使这样的重排版让套件变红，而不是悄悄关闭收窄。
- **重复条目。** 子集判定基于成员归属，忽略重数。ignores 数组中重复的 glob 在语义上是惰性的，因此这不改变范围论证。

## 验证计划

实现前针对真实 GitHub API 采集的基线：

- 未改动的树上，同目录套件 9/9 通过。
- 对七个观测到仅因 `eslint.config.js` 变红的分支，按其真实 head SHA 做了探针。七个全部报告 `compare=diverged`（今天：过期），且七个全部呈现 base 23 条 ignores 对分支 22 条、remainder 逐字节一致、head 独有条目集为空——因此 proposed 规则把七个全部转为新鲜。

实现后：

- 同目录套件的单元测试，用 `node --test .github/scripts/check-lint-gate-freshness.test.mjs` 运行。
- 变异见证：移除后置过滤、去掉 remainder 相等这一合取项、去掉子集这一合取项、以及反转子集方向，都必须各自让一条点名的用例变红。
- 针对实现后的脚本重跑七分支真实探针。

## 验收标准

- 唯一差距是基线侧新增全局 ignores 的分支，不再报告任何过期门禁文件。
- 缺少基线侧**移除**全局 ignore 的分支，仍把 `eslint.config.js` 报为过期。
- 基线侧对 `eslint.config.js` 任何其他部分的改动，包括五个 config 作用域 ignores 构造，仍报为过期。
- 任一侧存在负向（`!`）或反斜杠转义的条目时阻止收窄，即使 head 列表是 base 列表的子集。
- `.prettierignore` 上同样三条结论成立：基线新增放行、基线移除仍过期、负向行阻止收窄。
- raw media type 与 `main()` 的 `fetchText` 接线各自被钉住：改回 JSON media type 或删掉接线会让点名用例变红，而不是在 fail-closed 的 catch 后面静默失效。
- 取文本失败或抽取失败保留原过期结论。
- 其他门禁文件的行为与之前完全一致，且不产生额外 API 调用。
- `GATE_FILES` 不变，同目录套件通过。

## 待决问题

无。
