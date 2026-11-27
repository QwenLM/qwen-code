# Mod 读取环境变量和设置，以及 telemetry

[English](2026-11-27-mod-env-settings-telemetry.md) | [简体中文](2026-11-27-mod-env-settings-telemetry.zh-CN.md)

状态：提议中。在 #13749 中跟踪。依据 Claude Code 2.1.332 的插件 API 声明，接续[按 Claude Code 2.1.332 编写的 Mod](2026-11-26-mod-claude-code-2-1-332-shapes.zh-CN.md)。

## 问题与现状

很多 Mod 一开始就要知道自己运行在什么环境里：

- 用 `$.env.get` 判断终端或 CI；
- 用 `$.settings.read` 读一项设置；
- 用 `$.telemetry.log` 和 `$.telemetry.mark` 记录某个功能用得怎么样。

Qwen Code 还没有这些方法。每次调用都会抛出 `Mod API not supported`，发起调用的 hook 就失败了，这个 Mod 要画的内容或要给的回答也跟着没了。实测记录见[基线](#基线)。

命令的 `presentation` 还缺 `isColorless`。Mod 靠这个字段判断回答里要不要去掉转义码。

## 目标与非目标

目标：

- `$.env.get`、`$.settings.read`、`$.telemetry.log` 和 `$.telemetry.mark` 在所有运行 Mod 的宿主里都按合同的形状作答，并作为 API 事件经过其他插件的 hook。
- Mod 不能通过这些方法读到会话里的凭据。
- 终端不显示颜色时，`presentation.isColorless` 存在。

非目标：

- `$.env.set`。它会改变之后每个子进程继承的环境，放到文件和进程那一片做。
- 把 telemetry 发到任何地方。
- 让 hook 改变会话实际使用的设置。

## 兼容合同

以下依据 2.1.332 的声明。

1. **`$.env.get(name)`**：解析为变量的值；变量未设置时为 `undefined`。对应事件 `env.get` 携带 `{ name }`，`name` 固定不可改。回答是 `{ value }`（字符串或 `undefined`）或 `{ deny }`。
2. **`$.settings.read(args?)`**：
   - 不带参数时，解析为所有来源合并后的设置。
   - 带 `{ source }` 时，解析为这一个来源加载时的设置。没有设置的来源回答 `{}`。
   - 带 `{ key }`（可同时带 `source`）时，解析为上述对象的这个顶层键，没有则为 `undefined`。这是对整个对象读取结果的投影，不单独触发事件。
   - 来源有 `user`、`project`、`local`、`flag` 和 `policy`，优先级从低到高。
   - 对应事件 `settings.read` 携带 `{ source?, layers }`。`layers` 按优先级从低到高，为每个有设置的来源列出一项 `{ source, settings }`；读取单个来源时只含这个来源的一层。
   - `source` 和 `layers` 归宿主所有：调用方传入的 `layers` 会被替换，改了其中任何一个的 hook 会被跳过。
   - 回答是 `{ value }`（一个设置对象）或 `{ deny }`。
3. **`$.telemetry.log(entry)`**：
   - entry 是一条第一方记录 `{ to?: 'anthropic', event, props? }`，或一条 collector 记录 `{ to: 'collector', event, attributes, loggedAt, span? }`。
   - 第一方记录省略 `to` 时，在任何 hook 看到它之前就按 `anthropic` 补上。
   - 属性值是数字、布尔值，或 `{ value, of }`，其中 `value` 必须是 `of` 里的一项。
   - attribute 的值是字符串、数字、布尔值或字符串列表。
   - `to` 固定不可改。回答是 `{ value: undefined }` 或 `{ deny }`。
4. **`$.telemetry.mark(entry)`**：接收 `{ feature, kind, reason?, props? }`，`kind` 取 `ok`、`sad` 或 `bad`。回答形状与 `telemetry.log` 相同。
5. **两个 telemetry 调用**在所有 hook 作答后解析为 `undefined`；有 hook 拒绝时调用被拒绝。
6. **`CommandPresentation.isColorless`**：终端不显示颜色时为 `true`；其他情况和 headless 运行时不出现。
7. **`$.session.version().qwen.methods`**：只在宿主能回答 `env.get` 和 `settings.read` 时列出它们。store 的方法也是只在宿主保存 store 时才列出。

## Qwen 的设计决定

- **凭据不交给 Mod。** Claude Code 原样传递环境变量和设置，不做过滤。但在 Qwen Code 里，这两处存着模型供应商的 key、设置中的 `apiKey` 和 MCP 服务器的 token。Mod 可以把读到的内容发给模型、写进 prompt 或存进自己的 store，所以一个从不索要凭据的 Mod，不应该能读到凭据。
  - 检查过的 Mod 读的是 `HOME`、`TERM`、`CI`、`TMUX` 这类终端和 CI 变量，以及 `enabledPlugins`、policy 来源这类设置，没有一个读凭据，所以遮住凭据不会让它们出错。
  - 按名字判断凭据。把变量名或设置键按 `_`、`-` 和驼峰拆开，含有 `TOKEN`、`SECRET`、`API_KEY`、`ACCESS_KEY`、`PRIVATE_KEY`、`CREDENTIAL`、`PASSWORD`、`PASSPHRASE`、`AUTHORIZATION`、`DSN` 或 `CONNECTION_STRING` 等词的，就是凭据。完整列表就是 daemon 遮蔽 worker 诊断信息时已有的那条规则，这次抽出来共用。
  - 任一设置来源在 `envKey`、`credentialEnv` 或 `apiKeyEnv` 中指定的变量，以及在 `security.auth.apiKey` 等凭据字段中引用的变量，都按凭据处理。
  - 对凭据以及值包含至少四个字符的已识别凭据的变量，`$.env.get` 都回答 `undefined`，包括通过设置复制凭据的别名。变量未设置时也得到同样的回答。
  - 已写入进程环境的凭据别名会保持遮蔽，直到其环境变量值发生变化。仅重载设置、CLI 以继承的环境重新启动，或 daemon 将工作区环境交给 ACP 子进程时也保留此遮蔽。
  - `$.settings.read` 去掉任意层级下凭据键对应的字符串，包括顶层 `env` 里的这些变量。每个 MCP 服务器的 `env` 和 `headers` 整个去掉，因为它们的名字没有规律可循。
  - 设置在加载时会解析 `$VAR` 和 `${VAR}`，所以凭据的值可能出现在普通键下，比如一条命令或 MCP 服务器的 `args`。因此 `$.settings.read` 还会去掉任意层级下包含被遮住变量的值（四个字符及以上）的字符串。宿主同时检查当前环境和展开时实际使用的值。加载工作区环境或重新加载设置时，两者可能不同。
  - 只去掉字符串。这类名字下的数字或开关（比如 `model.sessionTokenLimit`）是限额，不是秘密。
- **来源对应到 Qwen Code 的作用域。**
  - `user` 是 `~/.qwen/settings.json`。
  - `project` 是工作区的 `.qwen/settings.json`。文件夹不受信任时这些设置不生效，所以不列出。
  - `policy` 是系统设置文件。它覆盖其他所有作用域，正如托管策略那样。
  - `local` 和 `flag` 在 Qwen Code 里没有对应物，回答 `{}`。
  - 系统默认文件是优先级最低的作用域，但不对应 Mod 知道的任何来源。它计入合并结果，但不作为一层列出。
  - 合并结果就是会话实际使用的那份，不是 Mod 能从各层自己折叠出来的。原因是 Qwen Code 的合并会去掉工作区的受限设置，部分键也有各自的合并规则。
- **hook 的回答只到达调用方。** Claude Code 在自己合并设置时也会触发 `settings.read`，因此 hook 能改写引擎实际使用的设置。Qwen Code 只在 Mod 调用时触发。让沙箱里的插件修改权限、供应商或 MCP 服务器，比读取它们是大得多的决定；检查过的 Mod 也都不需要。
- **telemetry 只记日志，不发送。** Qwen Code 没有为插件准备的第一方记录；运维方的 collector 也只接收 Qwen Code 自己记录的内容。两个调用都会：
  - 校验 entry；
  - 运行 hook；
  - 把 entry 写进调试日志，形如 `telemetry.log (not sent): …` 或 `telemetry.mark (not sent): …`。

  这样 Mod 作者能看到自己的 Mod 会上报什么。telemetry 与 `$.ui.log` 共用 100,000 字符的额度。条目超出剩余额度时仍然接受调用。只有写入调试日志的条目才扣减额度。

- **`env.get` 不做字面名字检查。** Claude Code 要求名字必须是字符串字面量，好让它的校验器列出模块读了哪些变量。Qwen Code 没有这样的校验器。凭据靠上面的规则挡住，规则不依赖读取模块源码。
- **`isColorless` 跟随 `NO_COLOR`。** 设置了 `NO_COLOR` 时两种终端 UI 都不显示颜色，Qwen Code 也没有 `--no-color` 参数。终端在每条命令运行时读取这个变量，所以这个字段反映的是命令运行时看到的环境。
- **补全碰到用量上限时立即失败，现状已是如此。** 让 Mod 等一次它取消不了的重试，只会白白占着它的 hook。Qwen Code 对 Mod 的补全本来就只发一次、不重试，碰到配额错误时回答 `{ isAnswered: false, reason: 'api-error', error: 'billing_error' }`，与声明一致。现有单测已覆盖配额这种情况。

## 宿主接口

每次读取，worker 都向宿主请求，自己从不接触环境变量或设置文件。这样凭据规则留在宿主一侧，任何宿主也都能提供自己的实现。

- `ModRuntime.createGroup` 接收一个 `reads` 宿主：
  - `env(name)`：返回字符串或 `undefined`；
  - `settings()`：返回 `{ layers, merged }`，每层是 `{ source, settings }`。
- 没有 `reads` 宿主时：
  - `env.get` 和 `settings.read` 以 `This host gives Mods no environment or settings.` 拒绝；
  - `$.session.version()` 里不列出它们；
  - 它们的 hook 被跳过。
- worker 发送 `{ type: 'read', id, read }`，运行时回复 `{ type: 'read-result', id, value?, error? }`。值大到放不进宿主消息时，只让这次调用失败，不影响会话。
- 设置读取可包含已校验的来源。指定来源时，运行时只发送该层。该来源没有设置时发送空的层列表。
- CLI 的宿主对 `process.env` 和会话已加载的设置应用凭据规则。将来的 Harness 宿主用它自己的环境和设置提供这两个函数即可。
- telemetry 和 `isColorless` 不需要宿主提供新东西。telemetry 走现有的日志通道；`isColorless` 随终端本来就传递的 `presentation` 一起传。

## 基线

用全局安装的 Qwen Code 0.27.4、隔离的 `HOME`，以及一个逐个调用这些方法的 Mod 命令，观察到：

| 调用                                                                         | 观察结果                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `$.env.get('HOME')`、`$.env.get('OPENAI_API_KEY')`                           | 抛出 `Mod API not supported: $.env.get`。                  |
| `$.settings.read({ key: 'general' })`、`$.settings.read({ source: 'user' })` | 抛出 `Mod API not supported: $.settings.read`。            |
| `$.telemetry.log({ event, props })`、`$.telemetry.mark({ feature, kind })`   | 抛出 `Mod API not supported: $.telemetry.log` 和 `.mark`。 |

## 验证与验收

- 单元测试：
  - 每个方法的回答，以及经过其他插件 hook 的情况；
  - 改了 `name` 或 `layers` 的 hook 被跳过；
  - 未知来源、不是字符串的键、带自由文本的 telemetry entry 被拒绝；
  - telemetry 只进调试日志；被拒绝时调用被拒绝；
  - 没有 reads 的宿主拒绝两种读取调用，也不列出它们；
  - CLI 宿主的凭据规则：变量及其别名、设置键、`env`、供应商指向的变量、MCP 的 `env` 和 `headers`、包含已解析凭据的字符串（包括环境值变化后），以及不受信任的文件夹；
  - `NO_COLOR` 下的 `isColorless`。
- 集成测试（`integration-tests/cli/mods-env-settings-telemetry.test.ts`）在构建好的 CLI 上安装一个 Mod fixture。它的命令读取 `HOME`、一个凭据变量、设置和单个来源，并记录 telemetry。测试检查：
  - 各项回答；
  - 输出里没有凭据；
  - 这次运行没有发出模型请求。

## 风险与待定问题

- 规则可能遮住不是凭据的内容：以字符串形式读的 `SESSION_TOKEN_LIMIT`，或者恰好包含某个被遮住变量的值的设置。需要读被遮住变量的 Mod 目前绕不过这些规则。
- 规则会漏掉两类凭据：
  - 直接写在普通键下、背后没有变量的凭据，比如写进 MCP 服务器 `args` 或 `url` 的 token，或带密码的代理 URL；
  - 名字不符合任何规则的变量里的凭据，比如在 MCP 设置之外使用的 `GITHUB_PAT`。

  第二类可以在设置的 `envKey` 里写上这个变量名来补上；第一类是设置文件本身的内容，仍然读得到。

- `local` 和 `flag` 读到 `{}`，可能让期待 Claude Code 里那些来源的 Mod 感到意外。Qwen Code 没有这样的文件。
