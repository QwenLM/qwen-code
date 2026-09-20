# Web Shell worktree 管理器

[English](2026-09-18-web-shell-git-worktree-manager.md) | [简体中文](2026-09-18-web-shell-git-worktree-manager.zh-CN.md)

状态：已实现。属于 [#11941](https://github.com/QwenLM/qwen-code/issues/11941)；同一 issue 中的提交历史泳道图与搜索见 [2026-09-18-web-shell-git-history-graph.zh-CN.md](2026-09-18-web-shell-git-history-graph.zh-CN.md)。

## 问题

Web Shell 用户可以在 worktree 中开会话，但 Web Shell 里没有任何地方列出仓库的 worktree，看不到哪些是脏的或过期的，也看不到每个 worktree 里跑着哪些会话。过期的 worktree 无声堆积，清理只能靠终端。

## 现状

- `packages/core/src/services/gitWorktreeService.ts` 中的 `GitWorktreeService` 为会话在 `<workspace>/.qwen/worktrees/<slug>` 下创建与删除托管 worktree，daemon 的 `POST /session` 在请求要求 worktree 时创建一个。没有任何 daemon 路由列出 worktree。
- 住在托管 worktree 里的会话，其摘要（无论活跃还是持久化）都带 `worktree: { slug, path, branch }`。
- `packages/web-shell/client/components/dialogs/GitDialog.tsx` 中的 `GitDialog` 承载「变更」「提交历史」「拉取请求」三个标签页；拉取请求标签页由 daemon 能力特性门控。
- `exit_worktree` 拒绝删除有未提交改动的 worktree，除非调用方明确选择丢弃。

## 目标

- 列出工作区仓库的每个 worktree：路径、分支、HEAD、锁定与过期状态、工作树计数，以及其中运行的会话。
- 从列表中删除 worktree，对破坏性情形拒绝执行，除非用户明确确认。
- 在同一界面恢复住在 worktree 里的会话，或新建 worktree 会话。
- 从分支 chip 进入该界面。

## 非目标

- 不新增 worktree 创建管道：「新建 worktree 会话」只是给输入区装上现有的 worktree 意图，由现有会话路由创建 worktree。
- 删除时不删分支；分支保留，删分支仍在分支选择器里做。
- 不列出其它仓库或其它工作区的 worktree。

## 设计

### Core

`packages/core/src/utils/git-worktrees.ts` 把 `git worktree list --porcelain -z` 包装成 `GitWorktreeEntry` 记录（path、head、branch、detached、bare、locked、prunable、isMain；主工作树是第一条），封装 `git worktree remove [--force --force] -- <path>`——它只摘掉指定的那一条注册——以及 `git worktree prune`，用于 remove 拒绝的那几种形态里被 git 标记为 prunable 的那些；另有 `git worktree lock` / `unlock` 在 prune 期间保护其余条目，以及对游离 HEAD 的可达性检查。它与分支辅助函数共用 `runGit`，并会剥掉 git 本会从被删仓库读取的、可指定为程序的那些配置键。

### Daemon 路由

三条工作区限定路由，全部为 **selected-runtime 作用域**：为 `:workspace` 解析受信任的 runtime，断言其 generation 打开，只对该 runtime 的 `workspaceCwd` 操作。没有任何一条回退到主 runtime。唯一一处刻意的例外是删除拒绝里的会话计数，见下文。

- `GET /workspaces/:workspace/git/worktrees` 列出条目并附两个派生标记：`isWorkspace`（runtime 自己的检出，按真实路径比较）与 `slug`（位于该 runtime `.qwen/worktrees/` 下的条目的目录名）。非仓库返回 `available: false`。
- `GET /workspaces/:workspace/git/worktrees/status?path=` 返回某个已列出 worktree 的工作树计数。path 必须与列表条目精确匹配，否则 404，因此客户端无法把这个探测指向别处。真正的边界是这份列表本身，而仓库可以塑造它：`git worktree list` 由本仓库自己的 `.git/worktrees/*/gitdir` 文件构成，因此能写入该目录的人可以让工作区之外的某个路径出现在列表里。可读性判定把这种泄露收窄到“`.git` 是 gitfile”的路径，其它一律答 `available: false`。代价是仓库 admin 目录的写权限，泄露的是该路径的分支、是否游离、改动计数与 ahead/behind。这些计数就是 git 自己显示的那一组，不带删除闸门对 `status.showUntrackedFiles` 的覆盖，也不带它那一项未完成操作，因此某一行可能显示「干净」而第一次点击仍被拒——这个方向是安全的，拒绝本身会解释原因。
- `POST /workspaces/:workspace/git/worktrees/remove`，请求体 `{ path, force? }`，走严格变更门。无论 `force` 与否都拒绝主工作树，以及根在该 worktree 上或其下的任何已注册工作区（409 `worktree_is_main` / `worktree_is_workspace`，后者在 `workspaceCwd` 里点名是哪个工作区——它可能就扎在这个 worktree 底下）。不带 `force` 时，还会在该 worktree 有活跃会话（409 `worktree_in_use`，附 `sessions`）、工作树有暂存/未暂存/未跟踪/冲突条目（409 `worktree_dirty`，附 `changes`；读取时覆盖 `status.showUntrackedFiles`，因为把未跟踪文件藏起来的仓库同样把它们对 git 自身的安全检查藏了起来）、有未完成的 rebase/merge/cherry-pick/revert/bisect（409 `worktree_operation_in_progress`，这种情况四个计数全为零）、游离 HEAD 的 worktree 是其自身提交最后的指向者（409 `worktree_unmerged_commits`，附 `unmergedHead`）、worktree 已加锁（409 `worktree_locked`，git 记录了理由时附 `reason`，并像其它 git 文本一样脱敏与截断——这段理由是任何能在该仓库里跑 git 的人写的）无法读取工作树（409 `worktree_status_unknown`），或该 worktree 自己持有嵌套仓库（409 `worktree_nested_repository`，子模块的仓库会随删除一起消失——git 只在检出还在时才拒绝，检出没了就一声不响地拿走）时拒绝。每一条拒绝都从同一个出口返回，由它附上第二次点击还会拿走的其余部分——计数、未完成的操作、没有引用保住的提交、嵌套的仓库，或者「这些根本数不出来」这件事：第二次点击会一次性覆盖全部拒绝，而未提交的工作是回不来的那部分。锁是从列表里读出来的，因此根本不会去问 git——但仅限 `--force --force` 真能清掉的情形，也就是 git 仍够得着的检出、或路径上什么都不剩的条目。悬空的符号链接不算「什么都不剩」：git 会找到这个链接并在它上面校验失败，因此这一形态与「目录尚在而 gitfile 丢失」一样交回给 git，因为在那里给出第二次点击根本落不了地；git 自己做出的其它拒绝，只要什么都没发生且 git 仍够得着该检出，就以 409 `worktree_remove_refused` 返回，`detail` 里是 git 脱敏后的原话；该 worktree 自己持有嵌套仓库时——检出里已初始化的子模块，或者没有检出可问时子模块留在 admin 目录下的那个仓库（git 自己正是据此拒绝的）——每一条拒绝都附 `submodules`，因为强制删除会把它一并删掉，而没有任何计数看得见它。git 已经够不着的条目跳过工作树探测，状态路由对它直接返回 `available: false`。判据是 `<path>/.git` 是不是一个 gitfile——git 正是通过它找到链接 worktree，而这也正是那条会出错的向上搜索的第一步：`getGitWorkingTreeStatus` 从给定路径一路*向上*解析仓库，对托管 worktree 来说会越过这个坏掉的条目，答出**主**工作树的分支与计数，并挂在被询问的那个 worktree 名下。那里如果是一个 `.git` **目录**，则是别人在原地新建的另一个仓库，答出它的分支同样是归错了对象，因此只有主工作树的那个算数。git 自己的 prunable 标记也不能当判据，因为**加锁**的 worktree 即使 gitfile 已经丢失也不会被标记。删除按路径进行——`git worktree remove` 只摘掉一条注册，仓库里其它过期注册不受影响。git 先删检出、再摘注册，而删不掉检出（只读子目录、被别的进程占着的文件）并不会阻止摘注册，因此一次报错并不意味着什么都没发生——注册可能已经被摘掉，而本路由删的就是注册。所以删除报错时会对照列表再查一次：本路由删的就是注册，注册已经没了就是办成了，而不是报一个重试会得到 404 的失败。回退对任何已被 git 标记为 prunable 的注册生效——这个标记正是「prune 能清掉它」的唯一依据。能走到这里的有两种形态：目录尚在、只是 gitfile 丢失的那种，以及路径上已经不是目录的那种（可达的例子是悬空符号链接）。git 对这两种都按路径、在任何 force 级别拒绝，而 prune 对两者都能清掉。git 拒绝却**不**标记 prunable 的那些形态见「约束」，回退对它们不生效。prune 是仓库级的（git 没有按路径的形式），因此路由在其间给其它所有过期注册加锁——git 会跳过加锁的 worktree，并且不再把加锁的条目标记为 prunable——事后再解锁。但列表与 prune 会清掉的并不是同一个集合：gitdir 文件丢失或为空的注册不出现在列表里、也无法加锁，却照样会被清掉。因此保护是对着 `git worktree prune -n -v` 验证的——它会点名 prune 将要拿走的每一个 admin 目录；除非它回来时恰好只点名一条注册、并且点的就是被询问的那一条——每个条目都带着它 admin 侧记录的 worktree，而这份记录在 worktree 自己的 gitfile 丢失之后依然在——否则路由就报出 git 的拒绝而不执行 prune：删除失败可以重试，旁观者的提交不能。中途夭折的删除留下的锁带着标明本路由的理由，下一次删除该条目时会将其释放——git 在任何 force 级别都拒绝加锁的 worktree，prune 也会跳过它。prune 不删除工作树里的任何文件；但它确实会删掉 admin 目录，而过期条目的 HEAD、reflog 以及子模块留下的仓库都住在那里——这正是保护机制要避免落到旁观者头上的事。又因为在本次请求读取列表之后才加上的锁会让 prune 静默跳过该条目，路由在 prune 之后重新列举一次，宁可把 git 自己的拒绝抛出，也不谎报一次并未发生的删除。成功响应在路径上还剩着任何东西时带 `directoryRemains`——用 `lstat` 判断，因此留下的符号链接也算；而当 daemon 根本看不到该路径时，一律按「还剩着」回报，因为它看不住的那次删除，恰恰就是会留下整份检出的那次。prune 回退与没做完的删除留下的都是这种局面。git 失败经共享的脱敏 git 错误路径返回。

会话计数是这些路由唯一一处读取所解析 runtime 之外的地方。它遍历每个已注册工作区的当前 runtime——用 `listManaged` 而非 `listAll`，因为正在排空、被阻塞或处于替换中的工作区仍然持有活的 bridge 与活的会话——统计其中 worktree 路径匹配的会话，并按会话 id 作键，使展示给用户的数字对每个会话只计一次。本仓库的某个 worktree 可能承载着属于*另一个*已注册工作区的会话，而 `worktree_is_workspace` 只在该 worktree 本身*是*工作区根时触发——只统计所选 runtime 会让那个会话在连 `force` 都不需要的情况下失去检出，而这正是该拒绝规则要防止的损害。

删除属于另一个仓库的 worktree 不是这些路由需要防御的情形：git 会校验目标的 `.git` 是一个 gitfile，*并且*它回指到 git 解析出的 admin 目录，`--force --force` 两项都绕不过，因此植入的注册在 git 自身的校验上失败关闭。

能力特性 `workspace_git_worktrees` 宣告这些路由；旧 daemon 上标签页与 chip 条目保持隐藏。

### SDK

`WorkspaceDaemonClient` 新增 `workspaceGitWorktrees()`、`workspaceGitWorktreeStatus(path)`、`workspaceGitRemoveWorktree(path, { force })`，以及对应的 `DaemonGitWorktree*` 类型。

### Web Shell

`packages/web-shell/client/components/dialogs/GitWorktreesDialog.tsx` 中的 `GitWorktreesContent` 是 `GitDialog` 的第四个标签页「Worktree」，daemon 宣告该特性时显示。打开时同时拉取 worktree 列表与工作区会话列表，按 `worktree.path` 把会话关联到 worktree，每个 worktree 一行：slug 或目录名、徽标（主工作树、当前工作区、已锁定、已失效）、分支或游离 HEAD、短 HEAD、工作树状态、其中的会话 chip，以及可删除条目的删除按钮。工作树状态在列表渲染后惰性拉取，每次三个请求，因此有数百个 worktree 的仓库也能即时列出。过滤框按路径、分支或 slug 收窄。

删除是两步行内确认，第一步如实说明将要发生什么：已失效条目被描述为「git 早已丢失的登记」，而不是「即将被删除的目录」。第一次请求从不强制。daemon 返回 409 时，确认区变成对将要丢失内容的说明（未提交改动数、运行中会话数，或锁的理由），并给出「仍然删除」按钮，以 `force: true` 重发请求。若是 git 自己做出的拒绝，说明就是 git 的原话。其它失败显示 daemon 的消息，只提供取消。删除成功后重新拉取列表；daemon 报告目录比注册活得久时，标签页会在列表上方说明——那一行恰好刚刚消失，而一行凭空消失本身就读作「目录没了」。

点击会话 chip 会关闭对话框并切换到该会话；「新建 worktree 会话…」关闭对话框并以装好 worktree 意图的草稿开始，与侧边栏入口走同一条路。`BranchPickerPopover` 在「管理远程仓库…」之后新增「管理 Worktree…」动作；`ChatEditor` 与 `EnvironmentPanel` 从 `App` 透传，`App` 仅在 daemon 宣告该特性时传入。

## 约束

- 删除 worktree 时，运行 git 会剥掉仓库可指定为程序的那些配置键，与 core 里其它 git 辅助函数一致。worktree 自己的 `.git/config` 可以指定 `core.fsmonitor`，而未强制删除所做的状态检查会触发索引刷新、进而运行它。
- worktree 列表是仓库级的，因此包含在 Qwen Code 之外创建的 worktree。它们可以像其它条目一样删除，受同样的拒绝规则约束。
- 作为另一个已注册工作区根的 worktree 仍会显示删除按钮，因为行上的 `isWorkspace` 标记回答的是“是不是当前工作区”，而拒绝覆盖所有已注册工作区。daemon 在任何 force 级别都拒绝它，所以这个按钮不会破坏任何东西，但也永远不会成功。在协议上标记它属于后续工作。
- 有几种损坏形态在标签页里根本清不掉，因为 git 在任何 force 级别都拒绝，而 prune 要么跳过、要么不适用：加锁且 gitfile 丢失的、`.git` 是目录的（有人在原地新建了仓库）、以及 `.git` 虽是普通文件但并非有效 gitfile 的——内容 git 读不懂、指向的目录不存在、或回指到另一个仓库。git 不会把它们标记为 prunable，因此回退不会触发。锁那条分支会先判断强制能不能奏效再给出第二次点击，但它判断的是 `.git` 的**形态**而非内容，因此最后那一组里若同时加了锁，仍会拿到一次注定失败的强制。出路是到终端里手动处理。仅仅加锁、其余健康的 worktree **不**属于这一类：`--force --force` 能清掉锁，这正是加锁拒绝可被强制覆盖的原因。
- 并非每一种拒绝都能被路由预先判断。git 拒绝删除含已初始化子模块的 worktree，同时又把这个 worktree 判为干净，因此没有任何计数或列表标记能提前看出来；它在 `--force --force` 下可以清掉。与其逐条枚举 git 的拒绝，不如：未强制的删除若失败且注册仍在，一律回 `worktree_remove_refused` 并带上 git 自己的那句话，标签页给出与脏检出相同的第二次点击。已经 force 过的失败不再提供，git 够不着的检出也不提供。
- `worktree_is_workspace` 对根在该 worktree 上**或其下**的已注册工作区都拒绝，因为无论哪一种，删掉这个 worktree 都会把它毁掉。`worktree_in_use` 仍然只比对 daemon 记录下来的东西，因此根在该 worktree 里、却没有 worktree 元数据的会话不在它的保护范围内；该 worktree 树内任何未提交改动仍由脏检查覆盖，但被忽略的嵌套检出不算改动，因此也不在覆盖范围内。后两项继承自本功能所依赖的既有界面，此处刻意保留。
- 清理 git 按路径拒绝的注册要走 `git worktree prune`，而它没有按路径的形式——所以路由先用 git 自己的锁把仓库里其它过期注册保护起来，再拿 `git worktree prune -n -v` 验证这层保护：它必须回来时只点名那一条注册、别无其它。无论这次删除成功还是失败，标签页都会重新读取列表，因为保护机制两种结局下都会加锁又解锁。工作树里不会有任何文件被删除——admin 目录会，这正是那里的嵌套仓库要在这一切之前就被拒绝的原因——其余所有删除都是按路径的。这类条目也会在第一次点击时直接摘掉、不会有 `worktree_dirty` 拒绝：git 已经不再把它的内容当作检出，因此没有可称为「脏」的工作树，其中的内容也不会被删除。
- 每一条拒绝都会说明第二次点击将丢弃的全部内容，而不只是 daemon 据以拒绝的那一条：未提交计数、未完成的操作、没有引用保住的提交、嵌套的仓库，以及「这些根本数不出来」这件事本身。会话排在最前，因为强制越过会话会让一份检出失去依托，而强制越过锁不会破坏任何东西——锁只是登记，行上的徽标照样在。工作树连看都看不到时也会如实说明：数不出这些改动，与确认没有改动，不是一回事。否则单独报出的锁或会话会把用户送过一批从未被提及的未提交改动，因为 `force` 是一次性覆盖所有拒绝的。
- 删除通常会删掉目录，删不掉时会如实说明：git 已经丢失的注册由 prune 清掉——它不动工作树里的文件，但会删掉 admin 目录，那里的嵌套仓库正是为什么它要在这一切之前就被拒绝——而 git 没做完的删除照样会摘掉注册。两种情况都回报 `directoryRemains`。强制删除会丢弃未提交的工作，并让活跃会话失去 cwd；第二次点击前的确认文案会说明这一点，已失效条目说明另一套，而游离 HEAD 的 worktree 不会被承诺保留分支——本来就没有分支可留。
- 会话在客户端按会话列表的一页（100 条）关联；会话落在该页之外的 worktree 不显示会话。关联还是按路径精确相等，而 daemon 的统计会先解析符号链接，因此当会话记录的路径与 git 的列表对同一个目录写法不同时，一行可能既不显示任何会话 chip、又被以「使用中」拒绝。这两点限制的都是标签页*显示*什么，不是 daemon 拒绝什么：删除检查在服务端统计，不分页，且跨所有已注册 runtime。这条关联早于本次改动。
- 工作树状态每次刷新读一遍，不轮询。刷新会重读所有 worktree 而非只读新增的，代价是每个 worktree 一个 git 进程、并发三个——这是不展示过期「干净」所付的价。标签页开着时被另一个会话弄脏的 worktree，其徽标会保持到下次刷新；daemon 在每次非强制删除时都会重读工作树，因此过期徽标可能误导读者，但不会放行一次删除。
- 被仓库忽略的文件会随目录一起删除且不计入计数，因为 `git status` 本就排除它们，而把它们算进来会让每一个带构建目录的 worktree 都被拒。普通确认文案说的是「目录会被删除」，这正是它们的下场。
- 锁的理由是自由文本，因此共享的 git 输出脱敏对它的保证弱于对 git 自身文本的保证。工作区自身路径一定会被抹掉，脱敏扫描能看见的路径也会——它识别位于空白、引号或括号之后的路径，而 git 总是把路径放在那些位置。写成 `owner=/elsewhere/secret` 的理由会保留该路径。写下这条理由的人本就对本仓库有本地 git 权限、早已知道它，因此这属于纵深防御而非边界。
- 状态路由的可达范围由 git 自己的 worktree 列表界定，而非工作区根——见上文路由说明。

## 验证

- `packages/core/src/utils/git-worktrees.test.ts`：porcelain 解析、真实仓库列出锁定与游离状态、删除对脏或锁定的 worktree 在强制前拒绝、摘掉一条过期注册而不影响仓库里其它过期注册、对目录尚在而 gitfile 丢失的注册删除失败、prune 清掉它并保留其文件、同时不动加锁的 worktree、admin 侧无论有没有检出都能答出子模块的仓库（有 gitfile 时直接问它，没有时读回指针）、以及 dry run 点名 prune 将要拿走的东西：列表显示不出来的注册、git 自己不会取的名字、相对回指针、长到读不得的指针，以及连名字都读不出来的那一条也照样计数，好让任何东西都藏不到它后面。
- `packages/cli/src/serve/routes/workspace-git-worktrees.test.ts`：列表标记、不可用仓库、不受信任工作区、仅对已列出路径返回状态、删除空闲 worktree、对主工作树/已注册工作区/脏/使用中的拒绝、属于另一个已注册工作区的会话、排空中工作区里的会话、内部 runtime 承载的会话、不问 git 直接按列表拒绝加锁条目、无理由的锁不附 reason、路径上什么都不剩的锁仍可强制覆盖、各类未提交改动都会进入计数、仓库藏起来的未跟踪文件同样进入计数、未完成的操作被单独拒绝、提交无引用保住的游离 worktree 先被拒随后可强制、只有游离条目才会去问可达性、旁观者被挡在 prune 之外、请求途中才过期的也被挡住、保护不成时宁可报拒绝也不 prune、遗留的保护锁会被释放、可达性检查本身失败时也会发出警告、严格变更门、状态与删除两条路由上的信任门、generation 在请求途中关闭、拒绝会指出锁或会话本会掩盖的未提交改动、会话排在锁之前上报、daemon 看不到的路径按「还剩着东西」而非「已消失」回报、git 自己的拒绝被转成可强制覆盖且有界、已 force 过以及 git 够不着的检出不再提供该覆盖、统计 worktree 里的每个会话而非只算一个、无法读取工作树时拒绝而非放行、非布尔值的 `force` 不算强制、git 摘掉注册但删目录失败时仍报办成并带上留在盘上的目录、prune 回退同样如此回报、状态路由的缓存响应头、按路径删除过期注册、gitfile 丢失的 worktree 无论是否被标记 prunable 都不探测、prune 回退只在 git 拒绝过期注册时触发、回退没能清掉条目时抛出 git 自己的拒绝、prune 执行前先问过 dry run、git 自己从未做出的拒绝上也点出嵌套仓库、第二次点击会一并带走嵌套仓库、没有检出可问时也点出、检出已不再显示它时同样点出、探针自身失败时不会凭空捏造、同一个仓库无论有多少工作区同时在删也一次只 prune 一个、留下的是还在排队的那一轮而非刚结束的那一轮、脱羁的 worktree 不会被问起不属于它的子模块、删除之前遇到的 git 失败也走脱敏返回、非法输入。这里 core 的 git 被 mock，因此钉住的是路由的判断而非 git 的行为。
- `packages/cli/src/serve/routes/workspace-git-worktrees.real-git.test.ts`：mock 套件覆盖不到的接缝——同样的路由对真实临时仓库、不 mock 任何东西，断言拒绝后检出仍在磁盘上、强制删除确实删掉目录且保留分支、一条过期注册单独消失、目录尚在而 gitfile 丢失的注册被清掉且其文件原封不动、加锁且 gitfile 丢失的 worktree 绝不会被答以主工作树的状态、在脱羁 worktree 原地新建的仓库也不会被当成它的状态、主工作树——唯一一个 `.git` 正当地是目录的条目——能被答出状态、git 记录的无理由锁能原样传到协议上、裸仓库自身条目被列在第一条且像主工作树一样被拒、prune 不会动仓库里其它过期条目、也不会把锁留在它们身上、列表显示不出来的注册会拦下 prune 而不是被它带走、admin 目录里的杂项文件则不会拦、不会运行仓库指定的任何程序、tag 同样能保住游离 worktree 的提交、提交无引用保住的游离 worktree 被拒、仓库藏起来的未跟踪文件仍被计数、加锁的 worktree 先被拒随后在强制下确实被删除、force 永远清不掉的锁不会被当作锁上报（含路径是悬空符号链接的那种）、**未加锁**的悬空符号链接则会走到 prune 回退并如实回报留下的东西、锁的理由在到达浏览器前已脱敏截断且不会把星文字符截成一半（git 自己的句子同样如此）、git 会以子模块为由拒绝的干净 worktree 在问 git 之前就被点名，随后在强制下确实被删除、没人检出过的子模块同样被点名——强制越过它确实会删掉它留在 admin 目录下的仓库、列表之外的路径被拒。把 `removeGitWorktree` 改成空函数，mock 套件仍全绿，而这里会红十四个。
- `packages/web-shell/client/components/dialogs/GitWorktreesDialog.test.tsx`：带徽标的行、惰性状态、会话关联与打开、主工作树与当前工作区不可删除、确认与刷新、刷新时重读工作树状态而非复用、过期行不显示任何状态、状态不可读的拒绝仍提供强制、删除失败后也刷新、紧随其后的刷新失败时拒绝仍留在屏幕上、比删除活得久的目录在列表上方被告知、刷新前那次慢探测绝不覆盖刷新后的新状态、裸仓不被探测状态、无理由的锁仍有徽标、锁被指名并可强制越过、一次确认里点清每一类损失、另一个拒绝顺带会带走嵌套仓库时一并点出、而嵌套仓库本身就是拒绝理由时只说一遍且仍给出强制按钮、落在用户已离开、已被过滤掉、或已被刷新抹掉的那一行上的拒绝——带上 daemon 给的原因，且只在那一行说不了的时候才说、挡住删除的工作区被点名、被过滤掉的行回来时键盘仍留在过滤框里、另一个工作区对同一路径的回应落地时该行不会重新可点、面板确实少了一个按钮时键盘仍留在面板内、未作答的确认框不会挡住过期列表、锁本会掩盖的未提交改动被一并指出、同时带两种计数的拒绝仍报出会话数、脏拒绝的那句话只说一遍、游离 HEAD 的 worktree 不被承诺分支、确认框不会跟着用户进入另一个仓库、git 的原话被原样转述且旁边有强制按钮、无言的拒绝也仍有话可说、已删除的行不会在刷新失败时留在屏幕上、从未到达的列表、切换工作区时丢掉前一个仓库的行、按分支过滤、脏与使用中的拒绝及强制、原样显示的失败、过滤、新建会话入口、不可用占位。
- `packages/web-shell/client/components/dialogs/GitDialog.test.tsx`：标签页只在有能力时出现。
- `packages/web-shell/client/components/BranchPickerPopover.test.tsx`：「管理 Worktree…」条目。

## 验收标准

- Worktree 标签页列出仓库的每个 worktree 及其路径、分支、状态与会话，即使有数百条也即时加载。
- 干净且空闲的链接 worktree 一次确认即可删除；脏的、加锁的、有会话的，或被 git 以自身理由拒绝的，需要第二次明确的「仍然删除」，并且绝不会出现 daemon 本可完成却无路可走的死胡同。
- 主工作树与已注册工作区在该标签页中永远不可删除；承载活跃会话的 worktree 一律被拒，无论该会话属于哪个工作区。
- 列在 worktree 下的会话点击即打开；「新建 worktree 会话…」开始一个 worktree 草稿。
