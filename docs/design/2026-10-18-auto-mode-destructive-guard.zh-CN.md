# Auto Mode 破坏性命令守卫

[English](2026-10-18-auto-mode-destructive-guard.md)

## 问题

在 Auto Mode 中，shell 与 Monitor 调用在分类器之前会经过一个确定性的破坏性命令守卫。此次改动之前，守卫在原始命令文本中匹配短语，带来三个后果：

- 它会拦截无害的文本，例如 `printf ok # git reset --hard`、`echo 'git reset --hard' >> NOTES.md`，或提交信息中提到该短语的提交；而只要 `git` 与子命令之间多出任何内容，真正的破坏性命令就会放行（`git -C <repo> reset --hard`、`git -c … reset --hard`、`git clean -d -f`、`git commit -m msg --amend`、`terraform -chdir=infra destroy`）。
- 它在 ask 规则检查之前运行，因此用户为这类命令设置的 `permissions.ask` 规则从未产生文档所承诺的确认。
- 最后一条用户提示词中的字词会解除它（"discard"、"clean up"、"丢弃"、工具名加 "destroy"），包括 "Do not discard my changes" 这样的否定句。

## 目标

- 依据 shell 实际执行的内容而不是文本来判断：打印、注释、引号中与提交信息中的文本绝不触发守卫，选项、包装命令与嵌套也不能隐藏受保护的操作。
- 绝不把守卫无法核实的命令当作安全。
- 让显式的 ask 规则得到只能由人给出的确认。
- 去掉提示词关键词豁免。

## 非目标

- 新增受保护操作的种类。受保护的操作保持不变：硬重置、丢弃工作区的 checkout、强制 clean、stash drop、对本会话中非 agent 所建提交的 amend，以及 `terraform`/`pulumi`/`cdk` destroy。它们的更多写法会被识别（`git checkout .`、`git checkout -f`、`git stash -q drop`）。
- 通用的 shell 解释器或沙箱。守卫是分类器之前的确定性底线，分类器仍会判断守卫放行的每一次调用。
- 让 PermissionRequest hook 回答守卫要求的确认。

## 设计

守卫使用已经支撑只读 shell 检查的 tree-sitter bash 解析器解析命令，并访问 shell 会运行的每一条命令：列表、管道、子 shell、命令组、循环、函数与命令替换中的命令，以及 `bash -c`、`eval`、`cmd /c`、`powershell -Command`、喂给 shell 的 heredoc 与 here-string 的脚本体，最多嵌套四层。每个词都化为 shell 实际传递的值；只在运行时才知道的部分标为动态，shell 可能拆分的词（未加引号的展开、花括号或路径名模式）标为可能是多个词。

对每条命令，它判定以下三种结果之一。

1. **发现受保护的操作。** `git` 及其全局选项（`-C` 链、`-c`、`--git-dir` 等），子命令及其选项按 git 的方式解析（合并的短选项、带值选项及其无歧义的长选项前缀、`--`），以及子命令前带选项的 `terraform`/`pulumi`/`cdk`。当某个路径参数规范化后指向工作区根目录或其上级，或带有 `-f` 时，checkout 是破坏性的。包装命令只在其运行命令的位置跟进（`sudo`、`env`、`nice`、`timeout`、`xargs`、`find -exec`、`npx` 等；`env -S`、`flock -c`、`su -c` 与 `watch` 运行一整条命令行），git 自己运行的命令也按命令读取（`rebase --exec`、`difftool -x`、`submodule foreach`、`bisect run`）。
2. **因决定性的词只在运行时才知道而无法核实。** 例如 `git $SUBCOMMAND`、`git reset $MODE`、`git checkout "$TARGET"`、checkout 中的路径名模式或魔法路径、git 全局选项被拆分的取值、`xargs` 追加的参数，或交给 git 运行的运行时命令。无论命令其他部分说了什么，这些都会被拦截。
3. **因命令运行了守卫读不到的代码而无法核实。** 脚本文件、`.`/`source`、路径形式的可执行文件、shell 从管道、文件或进程替换读取的程序、交给解释器的代码（`python`、`node`、`perl`、`ruby`、`php`、`awk`、`lua` 等）、shell 启动文件、git 别名或以命令为值的配置（`-c`、`git config`、`GIT_EDITOR`、`GIT_CONFIG_*`、写入 `.git`），或交给守卫不认识的程序的文本。这类代码可能来自命令中的任何位置，因此守卫会查看命令自身的文本：在去掉注释和已逐词检查过的操作名称之后，若该文本同时提到受保护的程序与受保护的操作，就拦截（这些操作的其他参数仍然计入，因为 `git log` 可以把提交信息打印给 shell）。printf、`echo -e` 与 `$'…'` 会解码的转义先被解码。

解析器读不懂的命令，或超出嵌套上限的部分，当其文本提到受保护的操作时被拦截。只把参数当数据读取的程序（`echo`、`printf`、`grep`、`rg`、`cat`、`jq` 等）不会带来读不到的代码。

**amend 豁免。** 只有当被检查 HEAD 的目录可证明就是 amend 实际运行的目录（调用目录加上任何 `git -C` 链），且 HEAD 是 agent 在本会话中创建的提交时，amend 才被豁免。`cd`、仓库环境变量、包装命令、未知的全局选项、写入 `.git`、同一行中更早的移动 HEAD 的命令，或未知目录都会取消豁免。宿主进程目录绝不作为替代。

**ask 规则。** `evaluateAutoMode` 先计算守卫结果。当 ask 规则匹配时，它返回 ask 回退；若守卫标记了该调用，回退会带上 `requiresHumanDecision` 和守卫的原因。`requiresHumanDecision` 的现有使用方（scheduler、ACP 会话、非交互拒绝）随之隐藏持久批准选项、忽略 PermissionRequest hook 的 allow，并在没有人能回答时拒绝，拒绝信息中带上守卫的原因与指引。普通的 ask 规则保持原有行为，deny 规则依然优先。

**提示词措辞。** 守卫不再读取用户的提示词。分类器仍然收到完整对话。拦截信息会写明操作，并指向真实的人工途径：自己运行、在 Auto Mode 之外批准，或添加匹配的 ask 规则。

## 决策与理由

- **复用现有解析器。** 只读 shell 检查已经依赖 tree-sitter bash，因此守卫没有新增解析器，并与之共享对 shell 语法的理解。
- **默认拦截，但只凭证据。** 拦截所有运行脚本的命令会挡住日常工作（`./build.sh && git checkout main`）。守卫只在命令自身文本提到受保护操作时拦截读不到的代码：在守卫看不到执行的地方恰好保留旧的原文本保护，而别处的惰性文本仍被放行。
- **ask 规则只允许人工确认。** Claude Code 2.1.301 的文档说明 ask 规则在 Auto Mode 中强制弹出确认，且 PermissionRequest hook 可以回答它。本设计对守卫标记的调用保留 #13636 中更严格的仅限人工规则，因为 hook 是程序化的，而守卫针对的是会丢失工作的操作。
- **不设关键词豁免。** Claude Code 依靠分类器阅读对话来理解意图，没有词面豁免。关键词无法区分"丢弃我的修改"与"不要丢弃我的修改"。

## 风险与限制

- 在无法判断时守卫更严格。在运行时构造受保护 git 命令的命令（`git checkout "$BRANCH"`、`git -C $DIR status`）、带模式的 checkout、取值提到受保护操作的别名（`git config alias.co checkout`），以及运行脚本或解释器而文本又提到受保护操作的命令，会被拦截，并提示改用字面参数。
- 部分判定由程序清单决定（shell、解释器、包装命令、只读数据程序、git 子命令与以命令为值的配置）。交给不认识的程序、且提到受保护操作的文本会被拦截，这限定了清单不完整时可能漏掉的范围。
- 交给分类器：会自行运行文件的程序（`make`、包脚本、上一次调用写入的 git hooks）、在命令之外定义的别名展开后的内容、在运行时拼接或编码的文本（字符串拼接、base64）、远程 shell（`ssh host '…'`），以及拆分到多次工具调用中的破坏性命令。
- 列表之外的操作不变：`git restore .`、`git stash clear`、`terraform apply -destroy`、`pulumi down`。后两者是受保护命令的别名，可在后续改动中加入。
- 匹配命令的 allow 规则会在守卫运行之前批准它。

## 验证

- `destructive-commands.test.ts` 中的单元测试钉住每种被识别的写法、每种无法核实的形式、每种被放行的惰性形式与每条 amend 路径；评审提出的用例已确认在去掉对应修复后会失败。
- `autoMode.test.ts`、`coreToolScheduler.test.ts`、Code Mode scheduler 测试与 ACP `Session.test.ts` 覆盖 ask 规则、hook、非交互、待处理兄弟调用、Monitor 与替换输入路径。
- 端到端测试框架在一次性仓库中，用分类器恒放行的编排模型驱动打包后的 CLI，经由 stream-json、`-p` 与 TUI，将基线提交与改动中的每个提交进行对比。

## 验收标准

- 惰性文本可以运行；隐藏的受保护操作在分类器之前被拦截；无法核实的形式被拦截。
- 匹配的 ask 规则产生仅限人工的确认；deny 规则优先；没有人的宿主不会运行该调用，也不会卡住。
- 任何提示词措辞都不能解除守卫，拦截信息也不会建议修改提示词。
