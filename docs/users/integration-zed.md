# Zed Editor

> Zed Editor provides native support for AI coding assistants through the Agent Control Protocol (ACP). This integration allows you to use Qwen Code directly within Zed's interface with real-time code suggestions.

![Zed Editor Overview](https://img.alicdn.com/imgextra/i1/O1CN01aAhU311GwEoNh27FP_!!6000000000686-2-tps-3024-1898.png)

### Features

- **Native agent experience**: Integrated AI assistant panel within Zed's interface
- **Agent Control Protocol**: Full support for ACP enabling advanced IDE interactions
- **File management**: @-mention files to add them to the conversation context
- **Conversation history**: Access to past conversations within Zed

### Requirements

- Zed Editor (latest version recommended)
- Qwen Code CLI installed

### Installation

1. Install Qwen Code CLI:

   ```bash
   npm install -g qwen-code
   ```

2. Download and install [Zed Editor](https://zed.dev/)

3. In Zed, click the **settings button** in the top right corner, select **"Add agent"**, choose **"Create a custom agent"**, and add the following configuration:

```json
"Qwen Code": {
  "type": "custom",
  "command": "qwen",
  "args": ["--experimental-acp"],
  "env": {}
}
```

![Qwen Code Integration](https://img.alicdn.com/imgextra/i1/O1CN013s61L91dSE1J7MTgO_!!6000000003734-2-tps-2592-1234.png)

## Troubleshooting

### Agent not appearing

- Run `qwen --version` in terminal to verify installation
- Check that the JSON configuration is valid
- Restart Zed Editor

### Qwen Code not responding

- Check your internet connection
- Verify CLI works by running `qwen` in terminal
- [File an issue on GitHub](https://github.com/qwenlm/qwen-code/issues) if the problem persists
