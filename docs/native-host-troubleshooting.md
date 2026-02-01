# Chrome 扩展 Native Host 排查步骤（已归档）

> 旧版 chrome-extension 已归档到 `archive/chrome-extension`。
> 当前 MCP Native Server 请参考：
> `packages/mcp-chrome-integration/app/native-server/README.md` 和
> `packages/mcp-chrome-integration/docs/INSTALLATION.md`。

适用于遇到“Specified native messaging host not found.”、“Native host has exited.”、“Handshake timeout”等情况。

## 1. 核对 manifest
路径：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json`

内容应为：
```json
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "/Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://kbpfhhpfobobomiighfkhojhmefogdgh/"
  ]
}
```

一键覆盖命令：
```bash
cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json" <<'EOF'
{
  "name": "com.qwen.cli.bridge",
  "description": "Native messaging host for Qwen CLI Chrome Extension",
  "path": "/Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://kbpfhhpfobobomiighfkhojhmefogdgh/"
  ]
}
EOF
```

> 修改 manifest 后务必**彻底退出并重启 Chrome**，再在扩展页点击“重新加载”插件。

## 2. 确保可执行与 Node 路径
Host 入口已设置 shebang `/usr/local/bin/node`。确保脚本可执行：
```bash
chmod +x /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/host.js
chmod +x /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/src/host.js
```

## 3. 日志位置
- 主日志：`~/.qwen/chrome-bridge/qwen-bridge-host.log`
- 如果主目录不可写，回退：`/tmp/qwen-bridge-host.log` 或 `/var/folders/.../T/qwen-bridge-host.log`

若文件为空，说明 host 可能没被 Chrome 拉起或启动后被立即杀掉（查看 manifest 是否正确、Chrome 是否重启）。

## 4. 手动运行自检
```bash
node /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/host.js
```
进程会挂起等待 stdin，无输出属正常；日志文件应记录启动信息。`Ctrl+C` 退出。

## 5. 常见错误与对应操作
- `Specified native messaging host not found.`  
  Manifest 中 `path` 或 `allowed_origins` 不对，或 Chrome 未重启。按第 1 步覆盖，重启 Chrome。

- `Native host has exited.` / `Handshake timeout`  
  多为 manifest 不被 Chrome 接受或 host 无法启动。确认第 1、2 步，重启 Chrome，再看日志是否收到 “Received … bytes”/信号。

## 6. 快速排查命令合集
```bash
# 查看当前 manifest
cat "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json"

# 覆盖 manifest（见第 1 步）
cat > "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.qwen.cli.bridge.json" <<'EOF'
{ ...如上... }
EOF

# 确保可执行
chmod +x /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/host.js
chmod +x /Users/jinjing/projects/projj/github.com/QwenLM/qwen-code/archive/chrome-extension/native-host/src/host.js

# 查看日志
cat ~/.qwen/chrome-bridge/qwen-bridge-host.log 2>/dev/null || echo "no log"
```
