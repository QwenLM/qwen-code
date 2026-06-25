# cua-driver 相对坐标（1000×1000 归一化）改造设计

> 目标：让 cua-driver 可选地以 **1000×1000 归一化相对坐标** 与模型交互，
> 适配 qwen（CPT 训练成输出 0–1000 归一化坐标）。默认保持像素语义，
> 零行为变化、兼容 Claude 等像素客户端。改动集中在 `cua-driver-core`，
> platform 改动最小化，便于 fork 后 rebase 上游。

本设计基于 Phase-1 八路并行代码调查（轨迹×2、坐标输入/输出字段、core 分发层、
配置文案、qwen 接入、构建测试），所有结论带 file:line 证据，见各小节。

---

## 0. 一个必须先澄清的发现（项目前提）

Phase-1 对用户提供的 qwen 出错轨迹
`trajectory-check/resolution/20260623_..._qwen3.7-plus.json` 做了逐调用复盘，
结论与"qwen 用归一化"的工作假设 **方向相反**：

- 该轨迹里 qwen3.7-plus 唯一一次落地的像素点击 `click{x:390,y:10}` 被 driver
  正确映射到屏幕 `(1144,345)`，误差 ≤1px —— **它当时用的是窗口截图像素，不是 0–1000**。
- qwen 全程几乎只用 `element_index`（UIA）寻址；少数像素调用都是小数值边缘目标，
  与"满量程 0–1000 中心点 ~500"不符。
- 该轨迹真正的失败原因是 Ruler 窗口 **枚举不到**（`No windows found for pid`），
  与坐标系无关。
- 关键原因：qwen 实际看到的工具 schema 明确写 `"window-local screenshot pixels"`，
  qwen 遵从了该描述。

**含义**：本改造的价值依然成立（提供一个归一化模式开关，让按 0–1000 训练的
客户端能正确驱动 driver），但 **"qwen 在 cua-driver + computer_use 场景下到底输出
0–1000 还是像素" 需要真机实测确认**（见 §8 验证）。Qwen 官方 issue #1521 也承认
不同 cookbook（computer_use 用 /1000、mobile_use 用 /999）坐标格式互相矛盾。

---

## 1. 核心架构决策

### 1.1 唯一拦截点 = `ToolRegistry::invoke`（不是 handle_request）
- `cua-driver-core/src/tool.rs:377` `pub async fn invoke(&self, name:&str, args:Value) -> ToolResult`
  是 **所有传输的唯一收口点**：stdio、HTTP（经 `server.rs:64 handle_request`）、
  **UDS daemon（`serve.rs:692/1206` 直调 invoke，绕过 handle_request）**、
  CLI（`cli.rs:1307`）、UIA worker（`cua-driver-uia/src/main.rs:164`）、
  replay（`recording_tools.rs:391`）。
- 生产主路径（装了 `/Applications/CuaDriver.app` 时）走 daemon，**绕过 handle_request**。
  → 拦截必须放 `invoke`，放 handle_request 会漏 daemon。
- `args` 是 `serde_json::Value`，`ToolResult`（`protocol.rs:124`）含
  `content / is_error / structured_content`，入参出参都可在此 wrap。

### 1.2 尺寸基准 = core 自建 per-(pid,window_id) 缓存
- `invoke` 入参只有 pid/window_id，**没有截图尺寸**。
- 不能复用 `resize_registry`/`zoom_registry`：它们在 `platform-macos`（core 不可见），
  且 key 仅 pid（多窗口串扰）、只存 ratio 不存绝对宽高。
- 解法：core 新建 `SIZE_CACHE: HashMap<(pid,window_id),(w,h)>`。
  `get_window_state` 返回时从 `structuredContent.screenshot_width/height` ingest，
  坐标工具入参时读出。
- 基准就是 **downscale（cap 1568）之后的最终截图尺寸**，正是 qwen 看到的图
  （`get_window_state.rs:286-287` 三平台同名 emit）→ 直接 ×/÷1000，无需再过 resize ratio。

### 1.3 开关
- core 全局（仿 `main.rs:50 CLAUDE_CODE_COMPAT: AtomicBool`）。
- env `CUA_DRIVER_RS_COORDINATE_SPACE=normalized_1000`，默认 `pixels`（兼容惯例，
  项目已有 ~18 个 `CUA_DRIVER_RS_*` env）。
- 可选叠加 `DriverConfig.coordinate_space` 字段 + `set_config`/`get_config`（持久 + MCP 可改）。
- 默认 pixels 时全部 early-return，零行为变化。

---

## 2. 换算公式
```
入参 norm→px:  px_x = round(norm_x / DIV * sw)   px_y = round(norm_y / DIV * sh)
出参 px→norm:  norm_x = round(px_x / sw * DIV)    norm_y = round(px_y / sh * DIV)
```
- `sw,sh` = `SIZE_CACHE[(pid,window_id)]`；缺失则透传并 warn（不猜）。
- `DIV` 默认 **1000**（computer_use cookbook，qwen3.6-plus 场景）；做成可配以应对 999 分歧。
- 取整用 `round`（与 mobile_use 一致、对称），避免 floor 的系统性半像素偏左上。
- x 系用宽 `sw`，y 系用高 `sh`，分别归一化。

---

## 3. 输入坐标字段表（纳入转换）

| 工具 | 字段 | 平台 | 基准 |
|---|---|---|---|
| click / double_click / right_click | `x`,`y` | mac/win/linux | (pid,window_id) |
| drag | `from_x`,`from_y`,`to_x`,`to_y` | mac/win/linux | 同上 |
| mouse_button_down / mouse_drag / mouse_button_up | `x`,`y` | linux only | 同上 |

字段命名跨平台统一（`click.rs:80-81`、`drag.rs:58-61`、各平台 impl_.rs 一致）。

---

## 4. 排除项（首版不转换，均有据）

| 排除 | 原因 |
|---|---|
| `move_cursor` x,y | screen/overlay 坐标，无 window 截图基准（`move_cursor.rs:56`） |
| `zoom` x1y1x2y2 | 定义裁剪框 + 产出 ZoomContext，归一化会污染 from_zoom 链路（`zoom.rs:70`） |
| `from_zoom=true` 的 click/drag | 坐标在 zoom 图空间，core 拿不到 crop 尺寸 |
| `get_screen_size` 返回 | 是 points 尺寸，非坐标 |
| `parallel_mouse_drag` 的 `path`/`fn` | linux，数组嵌坐标 + 字符串表达式，非线性，低优先级 |

排除项在 normalized 模式下 **透传原值**，并在文案/文档说明其语义未变。

---

## 5. 输出处理（首版降级，理由充分）

| 字段 | 处理 | 理由 |
|---|---|---|
| `screenshot_width/height` | 改成 `1000/1000`（可选保留 `*_px`） | qwen 视整图为 0–1000 网格 |
| `elements[].frame{x,y,w,h}` | **首版保持像素**，文档标注为 screen px | frame 是 **screen-global** 坐标（`ax/tree.rs:325 element_screen_rect`、win UIA `BoundingRectangle`、linux `GetExtents(Screen)`），要映射回截图空间需 window_origin + Retina scale，**core 拿不到**；三平台 points/px 语义还不一致。强行转换会引入错误。 |
| `get_cursor_position` x,y | 保持像素 | screen 坐标，无 window 上下文，工具不收 window_id |
| `list_windows`/`launch_app` 的 window `bounds` | 保持像素 | screen 绝对坐标，不是 qwen 用来点击的坐标 |

> 首版只归一化 **输入点击坐标**（qwen 的主路径）。输出 frame 的准确归一化是
> 后续增强项，需要 platform 侧额外 emit window_origin + scale（破坏"只改 core"），
> 单独评估。

三平台 `tree_markdown` 文本均不渲染坐标 → 无需改写 markdown，只动 structured。

---

## 6. 文案改写（list 出口字符串替换，不改源 schema）

在 normalized 模式下，于 **两处 list 出口** 套同一个 `rewrite_coord_desc()`：
- `tool.rs:335 tools_list()`（stdio/HTTP 直连）
- `serve.rs:585` 与 `serve.rs:1125` daemon `list` 分支（用 `def.description` 裸字段，
  **不经 to_list_entry**，必须单独覆盖，否则生产 daemon→proxy 路径看不到改写）

替换：坐标字段 description `"window-local screenshot pixels"` →
`"0–1000 normalized window-local coordinate (top-left origin, x by width / y by height)"`。
MCP `instructions`（`protocol.rs:191` "Prefer element_index … over pixel coordinates"）
在 normalized 模式下措辞同步调整。

> 不直接改源 schema 字符串 → fork rebase 友好。
> 注意：qwen-code 端 `schemas.ts` 是 0.5.2 硬编码副本（"do not hand-edit"，由
> `sync-computer-use-schemas.ts` 生成），driver 改 description 后，qwen-code 不重跑
> sync 就看不到新文案 —— 但 **driver 入参换算照样生效**，模型按训练习惯输出 0–1000
> 仍会命中。文案一致性是次要项。

---

## 7. 实现落点清单（集中在 core）

- 新建 `cua-driver-core/src/coord_norm.rs`：开关 + SIZE_CACHE + 字段表 + 4 个纯函数
  (`denormalize_args` / `ingest_window_size` / `normalize_result` / `rewrite_coord_desc`)。
- `lib.rs` 注册 `pub mod coord_norm;`。
- `tool.rs:invoke` 插 3 处调用（input hook → 真实 invoke → ingest + output hook）。
- `tool.rs:tools_list` + `serve.rs` 两个 list 分支末尾插 `rewrite_coord_desc`。
- `main.rs build_registry` 读 env/config 设置开关全局。
- platform 改动（可选）：DriverConfig 加 `coordinate_space` 字段 + set_config/get_config。

---

## 8. 测试与验证

### 8.1 单测（TDD 主战场，无 app 依赖，基线 98 passed/0.02s）
`cargo test -p cua-driver-core` —— 对 `denormalize_args`/`normalize_result` 做 round-trip
纯函数单测（0–1000 + 截图尺寸 ↔ 像素；边界 0/1000；除数/取整）。

### 8.2 e2e 协议测试
`crates/cua-driver/tests/mcp_protocol_test.rs` 模板（子进程 + JSON-RPC）。
注意 `:67`/`:2039` 预存红（断言 serverInfo `"cua-driver-rs"`，实际 `"cua-driver"`），
与本任务无关，勿误判。

### 8.3 真机（替换 qwen 的 binary）
1. 编译：`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer cargo build -p cua-driver --bin cua-driver`
   （**必须 DEVELOPER_DIR=完整 Xcode**，否则 Swift 链接失败）。
2. 覆盖 qwen 实际 spawn 的 binary（不改 installed.json 版本号，借壳 0.5.2 路径）：
   `~/.qwen/computer-use/cua-driver-rs-0.5.2/cua-driver-rs-0.5.2-darwin-arm64/CuaDriver.app/Contents/MacOS/cua-driver`
   覆盖后 `codesign --force --deep --sign -`。
3. **验证 A（纯 driver，确认换算）**：stdio 手发 normalized 坐标 + click 的
   `screenshot_path`/`debug_image_out` 画红十字，四角 (0,0)/(1000,0)/(0,1000)/(1000,1000)
   看是否压边 → 定 DIV=1000 vs 999。
4. **验证 B（真模型，确认 qwen 坐标空间 = §0 的根本问题）**：跑 qwen CLI，
   抓一次真实 click 的原始坐标值 —— 是 0–1000 量级还是 0–1568 像素量级。
   这 settle 整个项目前提。

---

## 9. 风险与未决（按严重度）

| # | 风险 | 缓解 |
|---|---|---|
| R0 | qwen 实际坐标空间未经真机确认（轨迹反证，§0） | §8.3 验证 B，先实测再定默认值 |
| R1 | 除数 1000 vs 999、是否 round | §8.3 验证 A 四角实测；DIV 可配 |
| R2 | replay 双重换算（`recording_tools.rs:391` 再过 invoke） | record 存 denormalize 后像素值 + bypass 标记 |
| R3 | 输出 frame 是 screen 坐标，无法在 core 准确归一化 | 首版降级保持像素（§5） |
| R4 | SIZE_CACHE 无 TTL、pid 复用陈旧尺寸 | ingest 总是覆盖；依赖"每回合先 get_window_state"既有 INVARIANT |
| R5 | qwen-code pin 0.5.2 vs driver 0.6.7，工具 schema 可能不兼容 | 借壳测试时 diff 两版 tools/list；必要时在 qwen-code fork 重跑 sync |
| R6 | from_zoom / parallel_mouse_drag fn 坐标语义 | 首版排除并文档化 |

---

## 10. 交付物状态
- [x] Phase-1 全面理解（8 路）
- [x] Phase-2 实现（TDD，125 core 单测绿）
  - [x] `coord_norm.rs`：换算 + 字段表 + 排除项 + 尺寸缓存 + ingest + 默认种子 + 文案改写（22 单测）
  - [x] `ToolRegistry.normalized` 字段 + setter + getter + `new()` 继承（4 接线测，mock EchoTool）
  - [x] `invoke` input/output hook（默认 pixels 零行为变化）
  - [x] **提示词（system/function instruction）— 全路径覆盖**
    - [x] system instruction：`protocol.rs` `coordinate_terms` + `agent_instructions`（2 单测）；in-process / HTTP / daemon-proxy（proxy 用 `initialize_result`）全覆盖
    - [x] function description：`rewrite_coord_desc`；in-process(`tools_list`) + **daemon(`serve.rs` ×2，兼容 `input_schema` 字段名)** 全覆盖
  - [x] `main.rs` `seed_coordinate_space_from_env()`（两个 main 入口）
  - [x] 全量编译 + 双模式 stdio smoke + **daemon-proxy smoke**（description 改写已验证）
- [ ] Phase-3 真机验证（A 换算四角画十字 + B qwen 坐标空间实测）
- [ ] subtree split 抽出独立仓库（待用户提供 GitHub 仓库）
- [ ] mac app 证书签名（待用户提供）

### 启用方式
`CUA_DRIVER_RS_COORDINATE_SPACE=normalized_1000`（不设 / 其他值 = pixels，零行为变化）。

### 本次改动文件（fork rebase 友好，集中在 core + bin 入口）
- `crates/cua-driver-core/src/coord_norm.rs`（新增：换算/缓存/ingest/文案改写/种子）
- `crates/cua-driver-core/src/lib.rs`（注册 module）
- `crates/cua-driver-core/src/tool.rs`（ToolRegistry 字段 + setter/getter + invoke hook + tools_list 改写 + 接线测试）
- `crates/cua-driver-core/src/protocol.rs`（system instruction：`coordinate_terms` + `agent_instructions`）
- `crates/cua-driver/src/serve.rs`（daemon list 两处 gated 改写）
- `crates/cua-driver/src/main.rs`（env 种子）
- **未动任何 platform crate 的 click/drag/zoom** —— 上游更新冲突面≈0
