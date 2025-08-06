# Qwen Code Checkpoint Feature

## Install from Fork

```bash
npm uninstall -g @qwen-code/qwen-code
npm install -g github:jeffry/qwen-code#main
```

## Usage

### Save conversation
```bash
qwen -p "My favorite color is blue" --save "session1"
```

### Resume conversation
```bash
qwen -p "What's my favorite color?" --resume "session1"
```

### Continue and save
```bash
qwen -p "Also, I like pizza" --resume "session1" --save "session2"
```

## How it works

- Checkpoints saved in: `~/.qwen/tmp/<project-hash>/checkpoint-<tag>.json`
- Just JSON arrays of conversation history
- Works with non-interactive mode only (`-p` flag)

## Python SDK (TODO)

```python
from qwen_code import QwenCode

qwen = QwenCode()
response = qwen.chat("Hello", save="test")
response = qwen.chat("Continue", resume="test", save="test2")
```

## Examples

```bash
# Multi-step coding
qwen -p "Design a REST API" --save "api"
qwen -p "Now implement it" --resume "api" --save "api-v2"
qwen -p "Add tests" --resume "api-v2" --save "api-final"

# Debug session
qwen -p "Help debug this error: XYZ" --save "debug1"
# ... try fix ...
qwen -p "That didn't work, try another approach" --resume "debug1" --save "debug2"
```