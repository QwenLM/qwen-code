# Ollama 快速开始指南

## 5分钟快速上手

### 1️⃣ 安装 Ollama
```bash
# macOS (使用 Homebrew)
brew install ollama

# 或访问 https://ollama.ai 下载
```

### 2️⃣ 启动 Ollama
```bash
ollama serve
```
保持终端运行，Ollama 默认在 `http://localhost:11434` 上运行

### 3️⃣ 拉取模型（在另一个终端）
```bash
# 拉取一个轻量级模型（推荐）
ollama pull mistral

# 或其他选择
ollama pull llama2
ollama pull neural-chat
```

### 4️⃣ 配置 Qwen Code

编辑或创建 `~/.qwen/settings.json`：

```bash
mkdir -p ~/.qwen
cat > ~/.qwen/settings.json << 'EOF'
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral 7B",
        "description": "Fast and efficient 7B model",
        "baseUrl": "http://localhost:11434"
      },
      {
        "id": "llama2",
        "name": "Llama 2",
        "description": "Full-featured model",
        "baseUrl": "http://localhost:11434"
      }
    ]
  }
}
EOF
```

### 5️⃣ 启动 Qwen Code
```bash
cd /path/to/qwen-code
npm run start
```

### 6️⃣ 选择模型
在 Qwen Code 中输入：
```
/model
```

现在您应该看到 Ollama 模型列表！ 🎉

## 就这么简单！

您现在可以：
- 🚀 使用本地 LLM 模型
- 🔒 保护您的数据隐私
- 🌐 离线工作
- ⚡ 自定义模型配置

## 需要帮助？

查看完整指南：`docs/users/integration-ollama.md`

或查看常见问题的解决方案：`OLLAMA_CONFIG_EXAMPLE.md`
