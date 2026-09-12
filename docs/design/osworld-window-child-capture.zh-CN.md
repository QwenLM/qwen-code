# 精确窗口截图与子窗口合成

[English](osworld-window-child-capture.md) | [简体中文](osworld-window-child-capture.zh-CN.md)

## 证据与范围

状态：候选cbeefff9已构建并独立审查；真实公开SDK的Welcome/主窗只读对照通过，菜单和输入回归待验证。同一GIMP3.2.4 Welcome窗口（PID45849/CG36191，610×679逻辑点）的异步只读SCK探针测得includeChildWindows默认true。1220×1358 PNG把父图像窗口及Welcome压缩进目标框，下方出现大片黑区。显式false输出正确尺寸的Welcome自身；包含指定window的display filter配sourceRect也输出正确内容。root已检查三张PNG。历史Q30 call4有同样父组/黑区模式；尚未证实baseline存在同类精确窗口合成失败。

证据位于`.qwen/investigations/gimp-welcome-sck-async-20260912`。N-API异步探针释放Node事件循环；之前阻塞探针的超时记录保留。三个捕获固定顺序约105/40/37毫秒，这是几何和配置对照，不能当速度比较。未发送输入或Apple Event。在该探针阶段，30R1已用b47冻结prepare，但agent尚未开始，历史getter所需GIMP授权当时仍待处理。

## 候选与边界

仅对desktop-independent window capture显式设置`SCStreamConfiguration::with_includes_child_windows(false)`，使用已安装screencapturekit6.0.1及macOS15特性链。不改变依赖或现有已确认AppKit sheet的display-crop分支。保留请求尺寸、owner/frame复查、缓存key、权限及失败语义。该改动只处理合成，不解决GIMP Help搜索框子节点不可读，也不放开AX token条件。

窗口观察应按声明像素坐标描绘精确目标。菜单、popover和合法子窗口内容必须回归：UI缩小或缺失都不算修好。如果禁止子组使已有受支持菜单流程无法观察，则在使用前拒绝或收窄候选。当前在屏对照不能证明屏幕外、跨屏或更旧系统表现。

## 验证

现有macOS library测试和release构建返回零，候选单独存放。独立固定R4 MCP的旧/新对照在两轮中产生8张PNG，同版本两轮图片逐字一致；新Welcome为1220×1358且只含正确目标，主窗为1567×815且不再混入Welcome。AX完整性、稳定token及同PID后台键盘歧义拒绝保持。root也检查了实际公开SDK PNG。证据为`.qwen/investigations/gimp-window-child-capture-metadata-20260912/`，静态审查为`.qwen/pr-reviews/osworld-window-child-capture.md`。

整个候选验收前仍需验证真实亮度对话框、普通应用窗口/菜单、AppKit附属面板和实际坐标输入。已准备runtime不改写，候选存入新native目录；使用候选的完整30任务需新prepare并冻结修改后的Skill。这些当前场景截图不构成整个候选的验收或速度比较。完整可比运行之前不宣称达到1.5倍目标。
