# Changelog

## 0.0.7

- Fix MCP tools
- Fix Web Fetch tool
- Fix Web Search tool, by replacing web search from Google/Gemini to Tavily API
- Fix: Compatible with occasional tool call parameters returned by LLM that are invalid JSON
- Fix: prevent concurrent query submissions on some rare cases
- Fix: incorrect qwen logger exit handler setup
- Fix: seperate static QR code and dynamic spin components
- Sync gemini-cli to v0.1.18

## 0.0.6

- Add usage statistics logging for Qwen integration
- Make `/init` command respect configured context filename and align docs with QWEN.md
- Fix EPERM error when run `qwen --sandbox` in macOS
- Fix terminal flicker when waiting for login
- Fix `glm-4.5` model request error

## 0.0.5

- Support Qwen OAuth login and provide up to 2000 free requests per day
- Sync gemini-cli to v0.1.17
- Add systemPromptMappings Configuration Feature
