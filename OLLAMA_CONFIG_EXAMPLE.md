# Ollama 配置指南

现在 Qwen Code 支持通过 Ollama 使用本地模型。以下是如何配置的步骤：

## 前置条件

1. 已安装并运行 Ollama
2. 已经拉取至少一个模型（例如：`ollama pull mistral`）
3. Ollama 服务运行在 `http://localhost:11434`（默认端口）

## 配置步骤

### 1. 编辑配置文件

编辑 `~/.qwen/settings.json` 文件，添加 `modelProviders` 配置：

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral",
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

### 2. 配置字段说明

- **id**: 模型的唯一标识符（必须与 Ollama 中的模型名称一致）
- **name**: 在 UI 中显示的模型名称
- **description**: 模型的描述信息
- **baseUrl**: Ollama API 的基础 URL（默认为 `http://localhost:11434`）

### 3. 使用模型

启动 Qwen Code CLI 后，输入 `/model` 命令即可看到 Ollama 模型列表：

```
/model
```

然后选择一个 Ollama 模型来使用。

## 常见配置示例

### 使用远程 Ollama 服务

如果 Ollama 运行在其他机器上，修改 `baseUrl`：

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral (Remote)",
        "description": "Mistral model from remote Ollama",
        "baseUrl": "http://192.168.1.100:11434"
      }
    ]
  }
}
```

### 配置自定义超时和重试

```json
{
  "modelProviders": {
    "ollama": [
      {
        "id": "mistral",
        "name": "Mistral",
        "description": "Mistral model",
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

## 验证配置

1. 确保 Ollama 正在运行：
   ```bash
   ollama serve
   ```

2. 检查可用的模型：
   ```bash
   ollama list
   ```

3. 启动 Qwen Code 并选择 Ollama 模型使用

## 故障排除

- **无法连接到 Ollama**: 检查 Ollama 是否在运行，baseUrl 是否正确
- **模型不显示**: 确保模型 ID 与 Ollama 中的模型名称完全一致
- **请求超时**: 增加 `generationConfig.timeout` 的值（单位：毫秒）
