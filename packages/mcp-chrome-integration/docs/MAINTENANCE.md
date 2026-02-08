# 文档维护指南

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本文档定义 Chrome MCP Integration 项目的文档维护规则和流程。

---

## 📋 文档维护原则

### 1. 单一真相来源 (SSOT)

- 每个主题只在一个地方完整描述
- 其他文档通过链接引用，避免重复
- 更新时只需修改一处

### 2. 文档与代码同步

- **代码变更必须同步更新文档**
- 新增工具必须更新 `tools-reference.md`
- 架构变更必须更新 `architecture.md`
- API 变更必须更新相关指南

### 3. 版本标记

所有文档必须包含版本信息：

```markdown
> **版本**: 2.0.0 | **最后更新**: 2026-02-08
```

### 4. 文档分类

- **产品文档**: 用户指南、API 参考、架构设计
- **过程文档**: 实施计划、状态追踪、会议记录
- **过程文档应归档到 `archive/` 目录**

---

## 📂 文档结构规范

### 当前文档结构

```
docs/
├── README.md              # 文档导航入口
├── architecture.md        # 系统架构（设计文档）
├── tools-reference.md     # 工具参考（API 文档）
│
├── guides/                # 用户指南
│   ├── installation.md    # 安装指南
│   ├── quick-start.md     # 快速开始
│   ├── development.md     # 开发指南
│   ├── mcp-usage.md       # MCP 使用
│   └── customization.md   # 定制指南
│
├── testing/               # 测试文档
│   ├── test-scenarios.md  # 测试场景
│   └── test-guide.md      # 测试指南
│
└── adr/                   # 架构决策记录
    ├── 0001-*.md          # ADR 文档
    └── README.md          # ADR 索引
```

### 文档命名规范

- 使用小写字母和连字符：`test-guide.md`
- 使用描述性名称：`tools-reference.md` 而非 `tools.md`
- ADR 使用编号前缀：`0001-native-messaging.md`

---

## 🔄 文档更新流程

### 代码变更时的文档更新

#### 1. 新增 MCP 工具

**必须更新的文档**：

- [ ] `README.md` - 更新工具数量和分类
- [ ] `docs/tools-reference.md` - 添加完整的工具文档
- [ ] `app/native-server/src/shared/tools.ts` - 更新工具定义

**更新模板**（tools-reference.md）：

````markdown
### X.Y `tool_name`

**功能**: 简要描述

**参数**:

- `param1` (type): 说明
- `param2` (type): 说明

**返回**: 返回值说明

**使用场景**:

- 场景 1
- 场景 2

**示例**:

```json
{
  "param1": "value"
}
```
````

````

#### 2. 架构变更
**必须更新的文档**：
- [ ] `docs/architecture.md` - 更新架构图和说明
- [ ] 创建 ADR 文档记录决策（如果是重大变更）

#### 3. API 变更
**必须更新的文档**：
- [ ] 相关的指南文档（`guides/*.md`）
- [ ] `tools-reference.md`（如果影响工具）

---

## ✅ 文档审核检查清单

### 新增文档检查项
- [ ] 包含版本标记（版本号 + 更新日期）
- [ ] 语法和拼写正确
- [ ] 代码示例可运行
- [ ] 链接有效（无死链）
- [ ] 添加到 `docs/README.md` 导航
- [ ] 分类正确（guides/testing/adr）

### 更新文档检查项
- [ ] 更新"最后更新"日期
- [ ] 内容与代码一致
- [ ] 删除过时信息
- [ ] 示例代码已测试
- [ ] 截图和图表是最新的

### 归档文档检查项
- [ ] 确认文档已过时或完成
- [ ] 有价值的信息已迁移到当前文档
- [ ] 移动到 `archive/docs/`
- [ ] 更新 `archive/docs/README.md`

---

## 📅 定期维护任务

### 每月审查（推荐）
- [ ] 检查所有文档的"最后更新"日期
- [ ] 验证代码示例仍然有效
- [ ] 测试所有文档链接
- [ ] 更新过时的截图和图表
- [ ] 归档已完成的状态文档

### 每季度审查
- [ ] 全面检查文档与代码的一致性
- [ ] 更新架构图（如有变更）
- [ ] 审查并更新最佳实践
- [ ] 收集用户反馈并改进文档

### 每次发布前
- [ ] 更新所有版本号
- [ ] 更新 CHANGELOG
- [ ] 验证安装指南
- [ ] 测试快速开始流程

---

## 🚫 文档禁忌

### ❌ 不要做的事情
1. **不要重复内容** - 使用链接引用
2. **不要混合过程文档和产品文档** - 过程文档归档到 `archive/`
3. **不要保留 AI 生成的骨架文档** - 要么完成要么删除
4. **不要使用绝对路径** - 使用相对路径
5. **不要忘记更新日期** - 每次修改都要更新
6. **不要创建孤儿文档** - 必须在导航中可访问

### ✅ 推荐做法
1. **保持简洁** - 删除冗余信息
2. **使用示例** - 提供可运行的代码示例
3. **及时归档** - 完成的计划和报告及时归档
4. **添加导航** - 确保文档易于发现
5. **版本一致** - 所有文档版本号保持同步

---

## 🔧 文档工具和辅助

### Markdown 格式检查
```bash
# 使用 markdownlint 检查格式
npm install -g markdownlint-cli
markdownlint docs/**/*.md
````

### 链接检查

```bash
# 使用 markdown-link-check 检查死链
npm install -g markdown-link-check
find docs -name "*.md" -exec markdown-link-check {} \;
```

### 文档预览

推荐使用支持 Markdown 的编辑器：

- VS Code + Markdown Preview Enhanced
- Typora
- Obsidian

---

## 📝 文档贡献指南

### 提交文档变更

1. 创建功能分支：`git checkout -b docs/update-tools-reference`
2. 更新文档并测试
3. 提交时使用清晰的 commit 消息：

   ```
   docs: 更新 tools-reference.md 添加 chrome_new_tool

   - 添加 chrome_new_tool 完整文档
   - 更新工具分类表
   - 更新工具总数为 28 个
   ```

4. 创建 Pull Request
5. 通过文档审核检查清单

### Commit 消息规范

- `docs: 更新文档内容`
- `docs: 添加新文档`
- `docs: 修复文档错误`
- `docs: 归档过时文档`

---

## 📊 文档质量指标

### 目标指标

- **准确性**: 文档与代码 100% 一致
- **完整性**: 所有工具都有文档（当前 27/27）
- **可用性**: 新用户 30 分钟内完成安装
- **可维护性**: 每次更新 < 30 分钟

### 监控方法

- 定期运行测试脚本验证示例代码
- 收集用户反馈
- 跟踪文档相关的 issue 数量

---

## 🔗 相关资源

- **文档导航**: [README.md](README.md)
- **工具参考**: [tools-reference.md](tools-reference.md)
- **架构设计**: [architecture.md](architecture.md)
- **ADR 记录**: [adr/README.md](adr/README.md)

---

## 🤝 联系方式

如有文档问题或改进建议：

1. 查看现有文档是否已有答案
2. 创建 GitHub Issue 并标记 `documentation`
3. 提交 Pull Request 改进文档

---

**维护者**: Qwen Code Team
**许可证**: Apache-2.0
