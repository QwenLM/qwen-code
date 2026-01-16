# Ollama 集成使用指南

## 概述

Qwen Code 现已支持与 Ollama 集成，允许您使用本地运行的 LLM 模型。这对以下场景很有用：
- 在没有互联网连接的环境中使用
- 保护您的数据隐私（所有处理都在本地进行）
- 测试和开发
- 离线使用

## 前置条件

1. **安装 Ollama**
   - 访问 https://ollama.ai 下载安装
   - 或通过包管理器安装（如 brew、apt 等）

2. **拉取模型**
   ```bash
   ollama pull mistral
   # 或其他模型
   ollama pull llama2
   ollama pull neural-chat
   ```

3. **运行 Ollama 服务**
   ```bash
   ollama serve
   ```
   默认在 `http://localhost:11434` 上运行

## 配置步骤

### 步骤 1: 编辑配置文件

编辑 `~/.qwen/settings.json`（如果文件不存在，创建一个新的）：

```bash
# macOS/Linux
nano ~/.qwen/settings.json

# 或使用您喜欢的编辑器
# code ~/.qwen/settings.json
```

### 步骤 2: 添加 Ollama 模型配置

将以下内容添加到 `settings.json` 中：

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral 7B",
        "description": "Mistral 7B model from Ollama",
        "baseUrl": "http://localhost:11434"
      },
      {
        "id": "llama2",
        "name": "Llama 2",
        "description": "Llama 2 model from Ollama",
        "baseUrl": "http://localhost:11434"
      },
      {
        "id": "neural-chat",
        "name": "Neural Chat",
        "description": "Neural Chat model from Ollama",
        "baseUrl": "http://localhost:11434"
      }
    ]
  }
}
```

### 步骤 3: 启动 Qwen Code

```bash
# 使用 npm
npm run start

# 或在开发模式下
npm run build-and-start
```

### 步骤 4: 选择 Ollama 模型

在 Qwen Code 运行后，输入命令选择模型：

```
/model
```

现在您应该看到 Ollama 模型列表出现！

## 配置选项详解

### 基础配置

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | ✓ | 模型的唯一标识符（必须与 Ollama 中的模型名称一致）|
| `name` | string | ✗ | 在 UI 中显示的模型名称（默认使用 id）|
| `description` | string | ✗ | 模型的描述信息 |
| `baseUrl` | string | ✗ | Ollama API 的基础 URL（默认为 `http://localhost:11434`）|

### 高级配置

您也可以为每个模型配置生成参数：

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral 7B",
        "description": "Mistral 7B model",
        "baseUrl": "http://localhost:11434",
        "generationConfig": {
          "timeout": 120000,
          "maxRetries": 3
        }
      }
    ]
  }
}
```

## 常见配置示例

### 远程 Ollama 服务器

如果 Ollama 运行在网络上的其他机器上：

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral (Remote)",
        "baseUrl": "http://192.168.1.100:11434"
      }
    ]
  }
}
```

### 多个不同的 Ollama 实例

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral - Local",
        "baseUrl": "http://localhost:11434"
      },
      {
        "id": "mistral-remote",
        "name": "Mistral - Remote Server",
        "baseUrl": "http://192.168.1.100:11434"
      },
      {
        "id": "llama2",
        "name": "Llama 2 - Local",
        "baseUrl": "http://localhost:11434"
      }
    ]
  }
}
```

## 故障排除

### 问题：看不到 Ollama 模型

**解决方案：**
1. 检查 Ollama 是否正在运行：`ollama list` 应该显示模型列表
2. 检查 `baseUrl` 是否正确
3. 检查 `id` 是否与 Ollama 中的模型名称完全匹配

### 问题：连接超时

**解决方案：**
1. 增加 `generationConfig.timeout` 值（单位：毫秒）
2. 检查网络连接（如果使用远程 Ollama）
3. 检查 Ollama 服务是否响应：
   ```bash
   curl http://localhost:11434/api/tags
   ```

### 问题：模型加载缓慢

**解决方案：**
- 这是正常的！Ollama 首次加载模型需要时间
- 增加 `timeout` 设置以适应首次加载
- 或在使用前预先加载模型：
  ```bash
  ollama pull mistral
  ```

### 问题：获取 "Model not found" 错误

**解决方案：**
1. 确保模型已拉取：`ollama pull mistral`
2. 确保配置中的 `id` 与 Ollama 中的模型名称完全一致
3. 运行 `ollama list` 查看可用模型名称

## 环境变量配置（可选）

您也可以通过环境变量来配置 Ollama：

```bash
# 设置基础 URL
export OLLAMA_BASE_URL=http://192.168.1.100:11434

# 设置默认模型
export OLLAMA_MODEL=mistral
```

## 集成提示

- **性能**：本地模型的响应时间可能比云服务慢，特别是在资源有限的机器上
- **资源**：某些大型模型需要 8GB+ 的 RAM，请根据您的硬件选择合适的模型
- **模型选择**：
  - Mistral 7B：轻量且快速，适合一般用途
  - Llama 2：功能强大，需要更多资源
  - Neural Chat：为对话优化
  - Phi：微型高效模型，适合有限资源的系统

## 更多信息

- Ollama 文档：https://github.com/ollama/ollama
- 可用模型列表：https://ollama.ai/library
- Qwen Code 文档：https://github.com/QwenLM/qwen-code

## 反馈与问题

如遇到问题，请：
1. 检查上面的故障排除部分
2. 确保 Ollama 正常运行
3. 查看日志以获取更多信息
4. 在 GitHub 上提出 issue
