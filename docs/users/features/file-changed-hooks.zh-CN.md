# FileChanged hooks

[English](file-changed-hooks.md) | [简体中文](file-changed-hooks.zh-CN.md)

使用 `FileChanged` 观察 Qwen Code、Shell 命令、编辑器或其他进程修改的文件。
该功能适用于本地非托管会话。Hook 配置、执行器及信任规则见
[Hooks 指南](hooks.md)。

## 事件输入

输入包含[通用 hook 字段](hooks.md#hook-input-structure)以及：

```json
{
  "file_path": "/home/me/work/demo/.envrc",
  "event": "change"
}
```

`file_path` 为绝对路径。`event` 取值为 `add`、`change` 或 `unlink`，分别表示
观察到文件新增、修改或删除。通用字段 `session_id` 和 `cwd` 属于监听会话，
不表示写入者。多个会话监听同一共享目录时，各会话都可能收到变化通知。
输入不包含文件内容。

仅投递文件事件，不投递目录自身的 `addDir` 和 `unlinkDir`。如需观察监听根目录
自身的生命周期，集成方应自行检查文件系统状态（例如 `stat`）并对账；
子文件的 `unlink` 不能证明根目录已删除。

## 监听工作目录中的文件名

在 `FileChanged` hook 中以 `|` 分隔字面文件名：

```json
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": ".envrc|.env",
        "hooks": [
          {
            "type": "command",
            "name": "configuration-changed",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/on-file-changed.mjs\""
          }
        ]
      }
    ]
  }
}
```

该配置注册会话 cwd 下的 `.envrc` 和 `.env`。静态注册不展开 glob，
也不递归扫描目录。省略 matcher、空字符串、`*` 和 `.*` 均不注册静态路径；
这些 hook 接收会话已监听路径的事件，包括动态路径。事件筛选使用文件 basename 和
[现有 matcher 规则](hooks.md#matcher-patterns)。

正则表达式只筛选已监听路径的事件；请通过 `watchPaths` 显式注册对应文件或目录。

静态根仅接受不含路径分隔符的字面文件名（包含点文件）；正则或 glob 元字符
不产生静态根。已存在的目录和无法检查的路径不注册，尚不存在的文件仍可监听
创建事件。静态文件发现监听父目录，但在遍历前排除无关条目。递归目录请通过显式 `watchPaths` 注册。会话工作目录迁移完成前会
重新定位静态根；显式绝对动态根保持不变。

## 监听目录及 cwd 外的路径

执行成功的同步 `SessionStart` hook 可通过 `hookSpecificOutput.watchPaths` 注册绝对文件
或目录路径。目录递归监听，包括之后新增的子文件。递归发现默认跳过 `.git` 和
`node_modules` 子树；如需观察其中的路径，请显式注册对应文件或目录。特殊文件类型
会被忽略，普通目录不限制发现深度。首次注册等待 watcher
就绪后才返回 `SessionStart`。

递归发现忽略名为 `<目标>.<12 位小写十六进制字符>.tmp` 的原子写入临时文件，
包括延迟重命名和孤儿文件。显式注册此类文件仍可观察。同样后缀的目录仍会遍历，
其他 `.tmp` 文件正常产生通知。

例如，注册 memory 目录：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "watch-memory-folders",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/watch-memory.mjs\""
          }
        ]
      }
    ],
    "FileChanged": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "memory-file-changed",
            "command": "node \"$QWEN_PROJECT_DIR/.qwen/hooks/on-file-changed.mjs\""
          }
        ]
      }
    ]
  }
}
```

让 `watch-memory.mjs` 向 stdout 输出以下 JSON。
将示例路径替换为 `/memory` 中显示的实际绝对目录路径：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "watchPaths": [
      "/home/me/.qwen/projects/demo/memory",
      "/home/me/.qwen/memories"
    ]
  }
}
```

`FileChanged` hook 未指定 matcher，因此接收已注册目录中各文件的变化。
处理器从 stdin 读取事件 JSON。将日志或同步结果写到监听路径之外，
避免处理器自己的写入再次触发自身。

## 更新动态路径

同一文件系统中的多个 workspace，可以在一个列表中注册各自实际 memory 目录。
业务根据 `file_path` 和自有的目录到 workspace 映射分发通知，不使用监听会话的
`cwd` 判断归属。独立会话可能观察同一个共享根路径，因此业务处理器需要去重。
位于其他容器或远程实例的根路径需要在对应文件系统拥有者处监听；在宿主注册
其路径不能观察到变化。

执行成功的同步 `SessionStart` 和 `FileChanged` 输出都可以设置 `watchPaths`。
在 `hookSpecificOutput` 中填写对应的 `hookEventName`。

| 输出                    | 对动态路径的影响   |
| ----------------------- | ------------------ |
| 绝对文件或目录路径列表  | 替换之前的动态列表 |
| `[]`                    | 清空动态列表       |
| 省略或非法 `watchPaths` | 保留之前的动态列表 |
| 异步 hook 的输出        | 不注册或修改路径   |

多个 hook 返回列表时，按 hook 执行顺序，最后一个显式提供且有效的列表生效。
所有条目均须为绝对路径；任一条目非法会使整个列表无效。
替换或清空动态路径后，静态文件名注册仍继续生效。

从 `FileChanged` 处理器清空动态路径时，返回：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "FileChanged",
    "watchPaths": []
  }
}
```

## 观察范围与限制

初始目录扫描不回放。最近写入的原生文件系统事件可能在注册后才到达。
显式注册的符号链接文件和目录根会观察其目标，也支持祖先路径中的符号链接。
通知使用配置的别名；同一目标注册多个别名时，每个别名各收到一条通知。
链接改指其他目标后应刷新注册。递归根内发现的符号链接仍不遍历。
写入稳定后才报告事件。
监听尽力而为：文件系统合并事件、
路径不可访问、进程离线和路径重新配置都可能产生缺口。
需要完整同步副本的集成应自行负责初始扫描、对账及重试。
Watcher 或 hook 失败会记录日志，原始文件操作保持不变。

`FileChanged` 不能否决或撤销写入，也不能向模型添加上下文。
仅监听显式注册的路径：不会自动注册 memory 目录，
不提供专用 auto-memory 开关事件。Hook 写入被监听文件可能触发自身；
应避免这些写入或对处理工作去重。

SSH execution environment、Shell sandbox worker 和 managed dispatcher
不启动本地文件系统 watcher。常规 hook 启用和信任规则仍然适用。
监听会话关闭时停止监听。
