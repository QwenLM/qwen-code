# FileChanged hooks

[English](file-changed-hooks.md) | [简体中文](file-changed-hooks.zh-CN.md)

## 问题与当前状态

业务集成需要观察 Qwen Code、Shell 命令、编辑器或其他进程写入的文件。
工具完成 hook 无法覆盖所有写入来源。现有设置、扩展和 skill watcher
仅服务于各自组件，没有通用文件变化 hook。Memory files 是其中一种用途，
不需要另设一类事件。

## 提议行为

新增 `FileChanged`，输入包含通用 hook 字段，以及绝对路径 `file_path` 和取值为
`add`、`change` 或 `unlink` 的 `event`。通知描述变化发生后的文件系统观察结果，
不能否决或撤销写入、识别写入者或向模型注入上下文。即使共享目录由另一个会话
写入，session ID 仍表示监听会话。

静态注册使用 matcher 指定会话工作目录中的字面文件名，以 `|` 分隔，例如
`.envrc|.env`。省略、空字符串、`*` 和 `.*` 不注册静态路径，但可接收会话共享监听集合中的事件，包括动态路径。事件筛选使用 basename 和现有 hook matcher 规则。静态注册不解释 glob，
也不递归扫描整个工作区。
静态根仅接受不含路径分隔符的字面文件名（包含点文件）；正则或 glob 元字符
不产生静态根。已存在的目录和无法检查的路径不注册，尚不存在的文件仍可监听
创建事件。静态文件发现监听父目录，但在遍历前排除无关条目。递归目录请通过显式 `watchPaths` 注册。会话工作目录迁移完成前会
重新定位静态根；显式绝对动态根保持不变。初始化时禁用监听的 bootstrap
配置仍保持禁用。

执行成功的同步 `SessionStart` 和 `FileChanged` 输出可通过 `hookSpecificOutput.watchPaths`
提供绝对文件或目录路径。目录递归监听，包括未来新增的子文件。递归发现默认跳过
`.git` 和 `node_modules` 子树，但显式注册其中的路径仍会生效。解析显式注册的符号链接后，
仅处理普通文件和目录，不限制发现深度。发现过程监听最近的
已存在父目录，使多层缺失路径和删除后重建的根能够在之后出现。只有请求的文件和
目录后代产生通知，无关子目录在遍历前排除；发现过程可能枚举已有祖先目录的条目。按 hook 执行顺序，
最后一个显式提供且有效的列表替换之前的动态列表；空列表清空，省略或非法列表
保持不变。静态路径继续保留。异步 hook 输出不注册路径。

递归发现忽略文件名以 `.<12 位小写十六进制字符>.tmp` 结尾的原子写入临时文件，
即使重命名延迟或失败后文件仍存在。显式注册的文件仍可观察，同样后缀的目录仍会
遍历，其他 `.tmp` 文件正常产生通知。

初始目录扫描不回放。最近写入的 native 文件系统事件可能在注册后才到达。
显式文件和目录注册会解析符号链接（包含祖先路径中的链接），通知仍使用配置中的
路径拼写。多个已注册别名指向同一目标时，每个别名各收到一条通知。刷新注册时会
重新解析目标；链接改指其他目标后需要刷新。递归根内发现的符号链接仍不遍历。
复用已有 chokidar 依赖，在写入稳定后报告事件。静态注册在
HookSystem 初始化时等待 watcher 就绪，无需额外配置 SessionStart hook；
动态注册等待就绪再返回 SessionStart。重新配置仅提供尽力而为的观察，不是事务或
变更日志。

## 组件与归属

| 组件                                                       | 变化                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| Hook 类型、planner、event handler、展示元数据              | 添加事件、输入和 basename 匹配                                |
| HookSystem                                                 | 拥有 watcher、消费输出，按监听 runtime/session 的归属执行通知 |
| Client 会话启动生命周期                                    | 仅配置 FileChanged hook 时也执行内部 watcher 初始化           |
| FileChangedWatcher                                         | 管理静态与动态路径、串行回调、销毁时关闭并取消                |
| Config                                                     | 关闭时仅销毁自己拥有的 hook system，校验显式 bus 输入         |
| CLI 设置与生成 schema、hook UI、ACP 元数据、SDK 事件 union | 在已有配置和展示入口识别事件                                  |
| Hook 文档                                                  | 说明注册、memory 目录示例和限制                               |

首版支持本地非托管会话。SSH execution environment、Shell sandbox worker 和
managed execution engine（包含 ACP）及 managed dispatcher 不创建宿主文件 watcher。远程绝对路径不能被解释为宿主路径。
托管 runtime 的支持需要在实际文件系统拥有者处另行设计。本功能不新增 daemon
route 或 memory API。

ACP workspace/bootstrap 和 MCP reconnect 初始化加载 hook registry，但禁用文件监听；
实际会话 Config 拥有各自的订阅。Session hook manager 的变更（含 skill 注册及移除）无需 reload
即可刷新监听会话的静态根路径。

Hook reload 和启用/禁用会更新静态根路径；事件通过当前可信 registry 筛选。
关闭时停止接收、取消运行中的 hook 命令、丢弃排队通知并释放 watcher。
会话轮换时丢弃旧会话的动态根路径和排队事件，并在新会话的首轮之前将静态根
重新绑定到新监听会话。旧 SessionEnd 延迟完成不能停止替换后的 watcher。即使没有
运行 SessionStart hook，轮换后的 reload 或 skill 注册也可建立当前会话的监听归属。
已结束会话保持停止监听，直到新会话或显式 SessionStart；初始化时的禁用选项仍有效。
派生 Config 不拥有第二个 watcher。监听或 hook 执行失败记录日志，
不改变原始文件操作。

## 范围与决策

- 复用 chokidar 以及已有 hook runner、registry、信任校验和超时处理，
  不新增 memory 持久化链路。
- 仅注册 hook 显式要求的路径。不隐式注册 memory 目录、不提供 memory
  启用/禁用事件，输入不包含文件内容。
- 在 FileChangedWatcher 内解析显式注册路径，并将观察结果映射回配置的别名。
  这样 basename 匹配和排队事件不依赖目标的真实路径，也无需启用递归跟随链接。
- 仅投递文件的 `add`、`change`、`unlink` 事件，不投递目录自身的 `addDir` 和
  `unlinkDir`。如需观察监听根目录自身的生命周期，集成方应自行检查文件系统状态
  （例如 `stat`）并对账；子文件的 `unlink` 不能证明根目录已删除。
- Hook 写入被监听文件可能触发自身；业务处理器需要避免这种写入或自行去重。
- 通知不持久化：文件系统合并、进程离线、路径不可访问和重新配置都可能产生
  缺口。业务集成负责初始扫描、删除对账、重试和同步。
- 本提案不包含专用 `MemoryChanged` API。本 PR 仅引用 #12558，不关闭其中
  独立的 memory 开关需求。

## 验证与验收标准

包内测试和真实 hook runner 实验需要覆盖静态文件事件、cwd 外动态目录、未来
新增的嵌套文件、多层缺失路径、根删除后重建、add/change/unlink、替换动态根且保留静态根、非法输出、初始
扫描抑制、监听会话归属、会话轮换、失败隔离、reload/disable 和存在排队任务时的关闭。
远程与托管 Config 不得启动本地 watcher；MCP reconnect 必须禁用监听，未运行
SessionStart 的轮换后延迟注册只可绑定到当前会话。另一个 hook 返回 watchPaths 时，
已有 SessionStart additional context 行为仍须正常。临时同级文件在延迟重命名及
孤儿清理过程中必须保持静默；最终目标、普通 `.tmp` 文件、显式注册文件及同样
命名的目录必须仍可观察。
显式符号链接文件和目录根必须以配置的别名报告目标变更，包含同一目标的多个别名，
以及刷新注册后目标改变的情况。隐式子链接和无关兄弟路径必须保持静默。

执行 build、typecheck、bundle、针对 hook/config/schema 的测试，以及隔离本地
CLI 测试计划。macOS runtime 结果需与 Linux/Windows CI、Claude Code 目录
注册行为的静态检查证据分别记录。

## 待定问题与后续工作

没有阻塞本地实现的待定问题。托管/SSH 文件系统归属以及持久业务同步属于后续
工作，不代表本实现已经支持。
