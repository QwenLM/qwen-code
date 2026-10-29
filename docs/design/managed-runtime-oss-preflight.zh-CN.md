# Managed runtime 发布的 OSS 认证预检

[English](managed-runtime-oss-preflight.md) | [简体中文](managed-runtime-oss-preflight.zh-CN.md)

## 问题与范围

受 bucket ACL 影响，匿名 OSS GET 对不存在的对象也可能返回 `403 AccessDenied`。
把此响应视为缺失，会允许覆盖无权访问的现有发布。本次只修改 Managed runtime
发布预检；Java 产物、产品代码、公开访问验证及发布不可变性检查保持不变。

## 方案

产物源码继续检出发布的 `SOURCE_SHA`。另将 `github.workflow_sha` 的 `scripts` 检出到
已有忽略规则覆盖的 `.qwen/managed-release-tools` 目录，不持久化凭据。使用此处的
发布辅助脚本，使旧标签补发也能运行新增预检。依赖通过根目录安装解析；源码检出、
Git 元数据、版本和构建时间戳保持不变。

在预检前安装现有 SHA-256 固定的 ossutil 1.7.19，并配置现有 production-release
凭据。预检与上传使用相同 bucket、对象路径和配置。以 `umask 077` 创建配置文件；
dry run 跳过配置与认证读取。

发布脚本增加 `--check-oss OSS_URL --config PATH --file PATH`。仅接受不含凭据、
端口、查询参数或片段的 `oss://bucket/object` URL。直接启动 `ossutil cat`，不经过
shell，将 stdout 写入私有临时文件，设置 300 秒超时并限制 stderr 大小。
此命令不能写入远端。

固定版本的 [cat 实现](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/cat.go)
调用 `GetObject`，把原始字节复制到 stdout，再追加一个换行符。
[命令包装层](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/command_manager.go#L57)
随后输出 `\n%.6f(s) elapsed\n`。从预期产物大小处最多读取 64 字节，要求尾部精确符合
`\n\n<秒数>.<6 位小数>(s) elapsed\n`，移除此尾部后用现有辅助函数比较 SHA-256。即使此版本 cat
忽略 `io.Copy` 的错误，这也能检测输出截断。保留产物自身的末尾换行符，并始终清理
临时下载文件。

`cp` 不适合此场景：其[下载预检](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/cp.go#L2489)
使用 [GetObjectDetailedMeta](https://github.com/aliyun/ossutil/blob/v1.7.19/lib/command.go#L658)，
这是 HEAD 请求，空错误响应体不能可靠区分缺失对象。
CLI [把错误打印到 stdout 并以状态 1 退出](https://github.com/aliyun/ossutil/blob/v1.7.19/ossutil.go)。
只有退出状态为 1，且输出为完整规范错误行、开头是
`Error: oss: service returned error: StatusCode=404, ErrorCode=NoSuchKey, ErrorMessage=`，
才认定对象缺失。此格式来自固定依赖
[OSS SDK v3.0.2](https://github.com/aliyun/aliyun-oss-go-sdk/blob/v3.0.2/oss/error.go)。
错误输出最多读取 16 KiB。AccessDenied、NoSuchBucket、非结构化 404、网络错误、
子进程错误、超时和字节不一致均阻止发布。不回显子进程诊断或凭据。

## 验证与限制

真实子进程替身覆盖相同二进制字节、末尾换行符、精确 NoSuchKey/404、其他错误类别、
字节不一致、超时、启动失败、参数校验和下载清理。工作流测试约束配置顺序、固定
上传器、凭据与配置复用、dry-run 条件及最终公开 HTTPS 验证。本地旧标签夹具验证
工作流选择的辅助脚本能解析根目录依赖，同时旧脚本保持不变。新增行为测试在原始
脚本上因不支持 `--check-oss` 而失败，修复后通过。

本地验证不访问真实凭据，不执行认证远端请求、工作流触发或发布。真实 OSS 访问仍
依赖现有凭据权限；权限不足时应阻止发布。升级 ossutil 时须重新核对其 stdout 和
错误格式契约。
