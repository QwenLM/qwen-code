# Prompt Hook 测试示例

本文档展示如何测试和使用 Prompt Hook 功能。

## 快速开始

### 1. 基础示例：安全检查 Hook

创建一个简单的安全检查 prompt hook：

**配置文件**: `.qwen/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "prompt",
            "name": "dangerous-command-blocker",
            "prompt": "检查以下命令是否危险：\n\n$ARGUMENTS\n\n如果命令包含 rm -rf、格式化、或系统关键操作，返回 {\"ok\": false, \"reason\": \"危险操作\"}\n否则返回 {\"ok\": true}",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### 2. 测试命令

```bash
# 测试 1: 安全命令（应该通过）
npm start

# 测试 2: 危险命令（应该被阻止）
rm -rf /tmp/test

# 测试 3: 查看 hook 日志
DEBUG=1 npm start
```

## 完整测试场景

### 场景 1: 文件写入保护

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file",
        "hooks": [
          {
            "type": "prompt",
            "name": "file-write-guard",
            "prompt": "检查文件写入操作：\n$ARGUMENTS\n\n如果写入以下类型文件，请阻止：\n1. 系统文件 (/etc/, /usr/)\n2. 用户家目录的配置文件\n3. 包含敏感词的文件名\n\n返回 JSON: {\"ok\": true} 或 {\"ok\": false, \"reason\": \"原因\"}",
            "model": "qwen-turbo"
          }
        ]
      }
    ]
  }
}
```

### 场景 2: 网络请求审计

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "web_fetch|web_search",
        "hooks": [
          {
            "type": "prompt",
            "name": "network-auditor",
            "prompt": "审计网络请求：\n$ARGUMENTS\n\n检查：\n1. URL 是否可信\n2. 是否包含恶意域名\n3. 是否符合公司政策\n\n返回：{\"ok\": true/false, \"reason\": \"...\"}",
            "timeout": 15000
          }
        ]
      }
    ]
  }
}
```

### 场景 3: 敏感信息过滤

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "name": "sensitive-info-filter",
            "prompt": "检测用户输入是否包含敏感信息：\n\n$ARGUMENTS\n\n敏感信息包括：\n- API 密钥、密码\n- 身份证号、手机号\n- 信用卡号\n- 个人隐私信息\n\n如果检测到，返回：{\"ok\": false, \"reason\": \"包含敏感信息：[类型]\"}\n否则返回：{\"ok\": true}",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

## 测试脚本

### 使用 vitest 进行单元测试

```typescript
// hook-integration/prompt-hook.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TestRig } from '../test-helper';

describe('Prompt Hook Integration', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  it('应该阻止危险命令', async () => {
    await rig.setup('dangerous-command-test', {
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [
                {
                  type: 'prompt',
                  name: 'security-check',
                  prompt:
                    '如果命令包含 rm -rf，返回 {\"ok\": false, \"reason\": \"危险操作\"}',
                },
              ],
            },
          ],
        },
      },
    });

    // 尝试执行危险命令
    await expect(rig.run('rm -rf /tmp')).rejects.toThrow(/危险操作/i);
  });

  it('应该允许安全命令', async () => {
    await rig.setup('safe-command-test', {
      settings: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [
                {
                  type: 'prompt',
                  name: 'security-check',
                  prompt: '检查命令安全性：$ARGUMENTS',
                },
              ],
            },
          ],
        },
      },
    });

    const result = await rig.run('ls -la');
    expect(result).toBeDefined();
  });
});
```

## 调试技巧

### 1. 启用调试日志

```bash
DEBUG=qwen:prompt_hook npm start
```

### 2. 查看 Hook 执行日志

```bash
# 查看完整的 hook 调用链
DEBUG=TRUSTED_HOOKS,PROMPT_HOOK npm start

# 查看 LLM 调用详情
DEBUG=LLM_CLIENT npm start
```

### 3. 测试 Hook 响应格式

```bash
# 创建一个测试脚本
cat > test-hook.sh << 'EOF'
#!/bin/bash
# 模拟 hook 输入
echo '{
  "tool_name": "bash",
  "command": "rm -rf /tmp/test",
  "cwd": "/Users/test"
}' | node -e "
const input = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
console.log('收到输入:', JSON.stringify(input, null, 2));

// 模拟 LLM 响应
const response = { ok: false, reason: '检测到危险操作' };
console.log('预期响应:', JSON.stringify(response));
"
EOF

chmod +x test-hook.sh
./test-hook.sh
```

## 性能优化建议

### 1. 使用快速模型

```json
{
  "hooks": [
    {
      "type": "prompt",
      "model": "qwen-turbo",
      "timeout": 10000
    }
  ]
}
```

### 2. 精确匹配器

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$|^shell$",
        "hooks": [...]
      }
    ]
  }
}
```

### 3. 超时设置

```json
{
  "hooks": [
    {
      "timeout": 5000
    }
  ]
}
```

## 常见问题

### Q: Hook 响应格式错误？

A: 确保返回的 JSON 仅包含 `ok` 和可选的 `reason` 字段：

```json
// ✅ 正确
{"ok": true}
{"ok": false, "reason": "原因"}

// ❌ 错误（包含额外字段）
{"ok": true, "extra": "field"}
```

### Q: 如何测试 hook 是否生效？

A: 使用调试模式查看日志：

```bash
DEBUG=TRUSTED_HOOKS npm start
```

### Q: Hook 执行太慢？

A:

1. 使用更快的模型（`qwen-turbo`）
2. 减少 prompt 长度
3. 降低超时时间
4. 使用更精确的匹配器减少触发次数

## 参考资源

- [Hooks 完整文档](./docs/users/features/hooks.md)
- [测试示例](./integration-tests/hook-integration/hooks.test.ts)
- [配置 Schema](./packages/cli/src/config/settingsSchema.ts)
