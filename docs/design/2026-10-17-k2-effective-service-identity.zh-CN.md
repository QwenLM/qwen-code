# K2 有效服务身份

[English](2026-10-17-k2-effective-service-identity.md) | [简体中文](2026-10-17-k2-effective-service-identity.zh-CN.md)

状态：#13395 与 Draft PR #13526 的实现候选。

## 问题与范围

受保护 unit 文件匹配，不能证明 systemd 实际加载了哪个 unit、启动了哪个进程。source 和 gateway 需要实际消费自身有效服务身份，作为后续安装资格化的前提。

## 设计

每个服务仅连接一次 `/run/systemd/private`。要求 root peer credentials 与 PID 1，再沿用既有宿主 peer 检查器及独立验证的 `systemd` target，持续持有原 systemd 进程、executable、pidfd 及 user/mount namespace。仅用 EXTERNAL UID 0 认证。不使用 system bus、不重连、不调用服务管理方法，不创建 shell 或子进程。

仅对固定自身 unit 的 `Unit`、`Service` interface 调用 `org.freedesktop.DBus.Properties.GetAll`，调用与认证均限五秒。要求准确 native unit name、fragment path 和 system slice；loaded、active、running 状态；无 alias、drop-in、transient unit、待 reload 或额外执行 hook。要求 Type=simple、root user/group、无 dynamic user、Restart=no、当前进程同时为 MainPID 和 ExecMainPID，以及唯一 ExecStart 的准确路径/argv 和仍在运行的成功 command record。要求 NoNewPrivileges、capability bounding set 仅 CAP_SYS_PTRACE、无 ambient capabilities、不可忽略的专用 AppArmor profile，且无 root image 或 root directory 替换。属性缺失或类型不同均拒绝。

按值保存首个非零16字节 InvocationID 及单调 service/unit 启动时间。每次 Service 读取前后均读取 Unit，要求两侧及后续检查的身份一致；前后核对原 systemd peer。连接、peer 或属性错误永久使该实例失效。把检查器接入既有 role files，使启动及既有 control、CSI、birth 和后台观察检查实际消费它。部分初始化失败和关闭时回收唯一连接及全部持有描述符。

仅向 source/gateway profile 增加固定 private socket、已审 systemd executable 读取及对 systemd 的观察读取权限。不增加 system bus 访问或服务管理方法。private socket transport 本身不限制 D-Bus method name；固定客户端及已审 actor 策略仍是信任边界的一部分。

## 限制与验证

这是采样的有效服务身份及部分安全属性检查，不验证所有 hardening 属性、已加载策略语义、runtime handler 选择、admission actors、独占 CSI 接线、provenance 或无间隙生命周期。不产生安装/释放权限，不改变 source/7，也不启用 RELEASED、历史读取或复用路径。

可移植测试仅使用惰性属性 map，核对两个角色、准确类型、缺失/变化字段、command 生命周期及身份复制。对实际 Linux source/shim/assembler 分别编译 amd64/arm64，不执行产物。静态审查调用点、清理及 profile，运行根 build/typecheck，并对整个增量做两轮自审。真实 systemd 属性兼容性、private socket 认证、已加载 AppArmor 权限及原生生命周期仍未验证，不换路径重跑此前被拒绝的原生组。
