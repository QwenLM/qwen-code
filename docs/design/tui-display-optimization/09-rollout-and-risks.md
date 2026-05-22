# §5 Rollout & Risks

## Implementation order (single PR, but stepwise for cleaner review)

1. **Step 0**：把 `CompactModeContext` 改名为 `DisplayModeContext`，但**逻辑保持等价**（`{ verbose: !compactMode }`）。所有调用点改 import 路径。CI 绿灯保证机械改名安全。
2. **Step 1**：settings migrator + `ui.verbose` schema；`--verbose` CLI flag；`/verbose` command。`compactMode` setting 仍可 toggle，但来源仅剩 settings dialog（不再被 Ctrl+O 写）。
3. **Step 2**：keybinding 改 —— Ctrl+O 摘掉 TOGGLE_COMPACT，挂 ENTER_TRANSCRIPT；Esc 加 EXIT_TRANSCRIPT 路由（高优先级）。
4. **Step 3**：`TranscriptOverlay` + `useTranscriptOverlay`，渲染层接入。VP / Static 路径上层加判定。
5. **Step 4**：思考过程 —— gate 入 history 改成 verbose；新 `ThinkingPulse` ephemeral 渲染。
6. **Step 5**：去 border + 间距重排。`ToolGroupMessage` / `CompactToolGroupDisplay` 视觉重写；merge 默认 ON。
7. **Step 6**：SubAgent 重塑 —— 新 `SubagentSummary` / `SubagentGroupSummary`；LiveAgentPanel 加聚合 header。
8. **Step 7**：Turn elapsed —— 新 `turn_summary` history item + emit。
9. **Step 8**：表格内代码 highlight 跳过。
10. **Step 9**：i18n、测试、snapshot rebuild、文档更新。

每步保证可独立运行；step 5 是最大块。

## Rollback strategy

- 单 PR 可一键 revert。
- 老用户若觉得太紧凑：`/verbose on` 或 `qwen --verbose` 一键回到 "compactMode=false" 等价显示（除了 Ctrl+O 语义已变，这点不可逆 — 但 Ctrl+O 的新行为更安全，没有数据丢失）。

## Risks & mitigations

| 风险                                                                           | 严重度 | 缓解                                                                        |
| ------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| ESC 优先级混乱 → 用户在 streaming 中按 Ctrl+O 后按 Esc，误以为会取消 streaming | M      | 文档化优先级；transcript footer 明确 "Esc to exit (does not cancel turn)"   |
| 去 border 后视觉与 tool 嵌套 diff 边界混淆                                     | L      | DiffRenderer 自带 frame；测试包含 diff snapshot                             |
| 思考链彻底默认隐藏，部分用户依赖思考调试                                       | M      | `--verbose` 一键恢复；首次发现 thoughts 隐藏时可考虑首屏 hint（本 PR 不做） |
| Transcript overlay 在 1k+ history 时滚动卡顿                                   | L      | 复用 VP ScrollableList，已经 stress test 过                                 |
| Ctrl+O 在 IDE plugin 子终端被 IDE 截获                                         | L      | 文档已说明 keybinding 可自定义；不变                                        |
| 老 keybindings.json 把 `ctrl+o` 显式绑到 `toggleCompactMode`                   | M      | 加载时 translate；warn 一次                                                 |
| `mergeCompactToolGroups` 一直 ON 后某些 force-expand 边界用例回归              | M      | 已有完整测试套件；本 PR 不动 `isForceExpandGroup`                           |
| ThinkingPulse 与 streaming abort 时残留                                        | L      | hook 在 abort/idle 立即清空；写单测                                         |
| turn_summary 写入与中断时序                                                    | L      | finalizer 在 finally 分支调用，保证总会 emit（包括 abort/error）            |

## Out-of-scope / followups (explicitly NOT in this PR)

- 新 banner 艺术字
- 新主题色调
- SubAgent 专属 brand glyph（仅引入符号家族，不替换品牌图）
- transcript 内的 search / filter
- transcript 内 `c` 复制当前 block
- `--verbose` 的更细粒度（如仅 thoughts / 仅 full tools）

## Definition of Done

- ✅ `npm run typecheck` 通过
- ✅ `npm run lint` 通过
- ✅ `npm test --workspace packages/cli` 通过（含新增 / 重建 snapshot）
- ✅ 手动 smoke 全部 §8 用例通过
- ✅ 所有 `useCompactMode` 调用点切换完成
- ✅ 所有 i18n key zh/en 同步
- ✅ 设计方案两轮自评审记录在 `10-review-notes-v1.md`
- ✅ 提案附图全场景覆盖记录在 `11-scenario-coverage.md`
- ✅ compactMode 调用点改造表记录在 `12-call-site-audit.md`
- ✅ 实现后多轮 review 记录在 `13-implementation-review.md`（实施阶段产出）
- ✅ 无方向审计记录在 `14-final-audit.md`（实施阶段产出）
