# Review 进程隔离

[English](review-process-isolation.md) | [简体中文](review-process-isolation.zh-CN.md)

## 问题

代理生成的验证代码能够向同 Unix 用户的其他 runner 发信号。已发现两种机制：
空的 `pkill -f` 匹配模式，以及假子进程 PID 1 进入真实进程组清理，产生
`kill(-1, SIGKILL)`。不同工作目录和 systemd cgroup 不能阻止这种信号。

## 改动

在 hook 进程组发信号和存活检测之前拒绝非安全整数或小于 2 的 PID，覆盖独立
supervisor。允许父进程退出后继续运行的 hook 清理，也在进入两种平台的终止路径前
拒绝这些值。

自托管 review 每次尝试通过 bubblewrap 创建用户和 PID 命名空间。宿主机预装工具链
只读，网络保留。只有 checkout 和 job 临时目录可写；HOME 每次尝试独立，宿主机
Git 配置只读挂载。使用独立 procfs、设备树、/tmp 和 /run，移除 capabilities 及
Docker、SSH-agent 的环境选择器。bubblewrap 的 no_new_privs 防止 setuid sudo
恢复宿主机权限。QWEN_HOME 必须保持工作流现有的 job 独立配置，避免命名空间 PID
进入宿主机共享的 Qwen 所有权数据库。GitHub 托管任务保持不变。

## 边界

该方案防止意外跨任务发信号，不是针对任意恶意代码的完整安全沙箱：review 仍能
访问网络和凭证。不得通过 TCP 暴露宿主机 Docker daemon，也不得把它的 socket
放在可写 job 目录中。runner 必须使用常规的 /var/run -> /run 布局。基于 Docker
的验证和宿主机服务管理会被有意限制。交互式 CLI 沙箱默认值、冲突解决及其他代理
工作流保持不变。

## 部署与风险

草稿：Linux 验收通过前不要合并。预装 bubblewrap，并在宿主机 AppArmor 策略下允许
非特权用户/PID 命名空间。目前对一台受影响主机的只读预检返回
`setting up uid map: Permission denied`；本 PR 没有修改宿主机策略。必须以 runner
用户而非 root 预检。命名空间创建失败时终止 review，不回退到无隔离执行。全量推广前
验证代理包装脚本、gh 发评论、超时、过期 review 取消、工具发现和产物收集。

服务自动重启不能修复跨任务信号。本 PR 不重启正在运行的任务，也不部署宿主机配置。
PID 防护发布后需要更新机群安装版 CLI；review 使用安装版，而非 checkout 中的 core。

## 验证与验收

单测拦截所有信号，覆盖父进程退出和取消时的非法 PID。包装脚本测试检查命名空间、
挂载参数、退出码以及失败时拒绝执行。取消草稿前，只在具有外层 PID 命名空间的
一次性 Linux 虚拟机或容器内执行真实破坏性探针：在内层 review 命名空间外放置哨兵，
分别测试空模式 pkill 和假 PID 清理，确认哨兵存活。禁止直接在共享 runner 宿主机上
执行这些探针。同时验证正常 review 完成、超时清理和产物上传。仅参数测试不能证明
运行时隔离有效。
