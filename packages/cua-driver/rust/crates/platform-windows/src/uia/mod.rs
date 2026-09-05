//! UI Automation (UIA) tree walking for Windows.
//!
//! Produces the same Markdown format as the macOS AX tree:
//!   `INDENT- [N] ControlType "Name" [value="..." id=... actions=[...]]`
//!   `INDENT- ControlType = "Value"` (non-indexed read-only elements)
//!
//! Uses IUIAutomation COM interface (available Windows 7+).
//! Uses one element-scoped IUIAutomationCacheRequest per visited node. Child
//! discovery is incremental, so the caller's depth/element limits are checked
//! before asking an out-of-process provider for more work.

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::S_OK;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IAccessible, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationTreeWalker,
    ToggleState_Off, ToggleState_On, TreeScope_Element, UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId,
    UIA_HelpTextPropertyId, UIA_InvokePatternId, UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId, UIA_NamePropertyId, UIA_ProcessIdPropertyId,
    UIA_RangeValuePatternId, UIA_ScrollPatternId, UIA_SelectionItemIsSelectedPropertyId,
    UIA_SelectionItemPatternId, UIA_TextPatternId, UIA_TogglePatternId,
    UIA_ToggleToggleStatePropertyId, UIA_ValuePatternId, UIA_ValueValuePropertyId,
};

pub mod cache;
pub mod fg_bypass;
pub mod revision;
pub mod scroll;
pub mod windows_enum;
pub use cache::ElementCache;
pub use windows_enum::enumerate_top_level_windows;

/// Default cap; callers can override via [`walk_tree_bounded`].
pub const DEFAULT_MAX_DEPTH: usize = 25;
/// Default cap; callers can override via [`walk_tree_bounded`].
pub const DEFAULT_MAX_TOTAL_ELEMENTS: usize = 5000;

// Historical aliases — referenced by the thin `walk_cached` shim that
// keeps the pre-#22865 call signature compiling. `walk_tree_bounded`
// reads from the caller-supplied caps instead.
#[allow(dead_code)]
const MAX_DEPTH: usize = DEFAULT_MAX_DEPTH;
#[allow(dead_code)]
const MAX_TOTAL_ELEMENTS: usize = DEFAULT_MAX_TOTAL_ELEMENTS;

/// A single node in the accessibility tree.
///
/// Same shape for the UIA primary path AND the MSAA fallback (used for
/// SAL/VCL window classes — see `msaa.rs`). MSAA-only fields use the
/// `_ptr is IAccessible` / `msaa_role = Some(...)` discriminator.
#[derive(Clone)]
pub struct UiaNode {
    pub element_index: Option<usize>,
    pub control_type: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub automation_id: Option<String>,
    pub help_text: Option<String>,
    pub actions: Vec<String>,
    /// UIA RuntimeId candidate. It becomes stable only after the revision
    /// manager confirms continuity with `IUIAutomation::CompareElements`.
    pub runtime_id: Option<Vec<i32>>,
    /// Enabled state reported by UIA. `None` is reserved for fallback
    /// backends that cannot establish it.
    pub enabled: Option<bool>,
    /// Toggle/selection state when the element exposes one of those patterns.
    pub selected: Option<bool>,
    /// Raw COM pointer (IUIAutomationElement for UIA path, IAccessible for
    /// MSAA path) as usize. Retained — `ElementCache` Drop releases it via
    /// the `kind`-appropriate vtable.
    pub element_ptr: usize,
    /// Screen-coordinate center, captured at walk time to avoid later COM calls.
    pub center_x: i32,
    pub center_y: i32,
    /// Full screen-coord rect (left, top, right, bottom). Available for
    /// elements that report a meaningful bounding box. Used by the click
    /// tool when `action:"expand"` needs the right-edge offset.
    pub rect: Option<(i32, i32, i32, i32)>,
    /// MSAA role code (e.g. 0x38 = `ROLE_SYSTEM_BUTTONDROPDOWN`). `Some`
    /// iff this node came from the MSAA walker — the click tool checks
    /// this to route `action:"expand"` to a right-edge SendInput click
    /// instead of an unsupported UIA pattern lookup.
    pub msaa_role: Option<i32>,
    /// Depth in the rendered markdown tree (matches the `lines` indent
    /// level). Defaults to 0 when the node came from a builder that
    /// doesn't track depth.
    pub depth: usize,
    /// `element_index` of the nearest actionable ancestor, if any.
    /// Mirrors the markdown's parent-of-this-row.
    pub parent_element_index: Option<usize>,
    /// True when this node is below a UIA Document control. Browser-owned
    /// consent chrome must never match renderer-controlled descendants.
    pub in_web_content: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiaBackend {
    Uia,
    Msaa,
}

pub struct UiaTreeResult {
    pub tree_markdown: String,
    pub nodes: Vec<UiaNode>,
    pub backend: UiaBackend,
    pub complete: bool,
    pub truncated: bool,
    pub incomplete_notes: Vec<String>,
}

pub(crate) fn partial_tree_result(
    mut nodes: Vec<UiaNode>,
    _lines: Vec<(usize, String)>,
    query: Option<&str>,
    note: &'static str,
) -> UiaTreeResult {
    // A timed-out worker generation is retired immediately after this result.
    // Its COM pointers and element indices therefore cannot be action bindings.
    // Keep the completed accessibility facts as display-only evidence.
    for node in &mut nodes {
        node.element_ptr = 0;
        node.element_index = None;
        node.parent_element_index = None;
        node.actions.clear();
    }
    let lines = nodes
        .iter()
        .map(|node| (node.depth, format_node_line(node)))
        .collect::<Vec<_>>();
    let raw = render_lines(&lines);
    UiaTreeResult {
        tree_markdown: query.map_or_else(|| raw.clone(), |query| filter_tree(&raw, query)),
        nodes,
        backend: UiaBackend::Uia,
        complete: false,
        truncated: false,
        incomplete_notes: vec![note.into()],
    }
}

/// Settle every COM reference retained by a completed walk. Actionable
/// pointers may be transferred into ElementCache; every other pointer must be
/// released here because UiaNode stores them as raw integers and has no Drop.
pub(crate) fn settle_node_bindings(
    nodes: &mut [UiaNode],
    backend: UiaBackend,
    actionable_transferred: bool,
) {
    for node in nodes {
        if node.element_ptr == 0 {
            continue;
        }
        let transferred = actionable_transferred && node.element_index.is_some();
        if !transferred {
            unsafe {
                match backend {
                    UiaBackend::Uia => {
                        drop(IUIAutomationElement::from_raw(node.element_ptr as *mut _));
                    }
                    UiaBackend::Msaa => {
                        drop(IAccessible::from_raw(node.element_ptr as *mut _));
                    }
                }
            }
        }
        node.element_ptr = 0;
    }
}

#[derive(Default)]
struct WalkStatus {
    complete: bool,
    truncated: bool,
    incomplete_notes: Vec<String>,
}

impl WalkStatus {
    fn complete() -> Self {
        Self {
            complete: true,
            ..Self::default()
        }
    }

    fn incomplete(&mut self, note: impl Into<String>) {
        self.complete = false;
        let note = note.into();
        if !self.incomplete_notes.contains(&note) {
            self.incomplete_notes.push(note);
        }
    }

    fn truncate(&mut self, note: &'static str) {
        self.truncated = true;
        self.incomplete(note);
    }
}

/// Walk the UIA tree for the window with the given HWND.
pub fn walk_tree(hwnd: u64, query: Option<&str>) -> UiaTreeResult {
    walk_tree_bounded(hwnd, query, DEFAULT_MAX_TOTAL_ELEMENTS, DEFAULT_MAX_DEPTH)
}

fn is_menu_control(control_type: &str) -> bool {
    matches!(control_type, "Menu" | "MenuBar" | "MenuItem")
}

fn exact_menu_path_matches(nodes: &[UiaNode], path: &[String]) -> Vec<usize> {
    let by_element_index: std::collections::HashMap<usize, usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(node_index, node)| node.element_index.map(|index| (index, node_index)))
        .collect();

    nodes
        .iter()
        .enumerate()
        .filter_map(|(node_index, node)| {
            if !is_menu_control(&node.control_type)
                || node.enabled == Some(false)
                || node.name.as_deref().map(str::trim) != path.last().map(String::as_str)
            {
                return None;
            }
            let mut lineage = Vec::new();
            let mut cursor = Some(node_index);
            while let Some(current) = cursor {
                let ancestor = &nodes[current];
                if is_menu_control(&ancestor.control_type) {
                    if let Some(name) = ancestor.name.as_deref().map(str::trim) {
                        if !name.is_empty() {
                            lineage.push(name);
                        }
                    }
                }
                cursor = ancestor
                    .parent_element_index
                    .and_then(|index| by_element_index.get(&index).copied());
            }
            lineage.reverse();
            lineage.dedup();
            (lineage == path.iter().map(String::as_str).collect::<Vec<_>>()).then_some(node_index)
        })
        .collect()
}

unsafe fn release_walk_nodes(nodes: Vec<UiaNode>) {
    use windows::Win32::UI::Accessibility::IAccessible;
    for node in nodes {
        if node.element_ptr == 0 {
            continue;
        }
        if node.msaa_role.is_some() {
            drop(IAccessible::from_raw(node.element_ptr as *mut _));
        } else {
            drop(IUIAutomationElement::from_raw(node.element_ptr as *mut _));
        }
    }
}

unsafe fn invoke_menu_element(element_ptr: usize, final_segment: bool) -> Result<(), String> {
    let element =
        std::mem::ManuallyDrop::new(IUIAutomationElement::from_raw(element_ptr as *mut _));
    if !final_segment {
        if let Ok(pattern) = element.GetCurrentPattern(UIA_ExpandCollapsePatternId) {
            if let Ok(expand) = pattern.cast::<IUIAutomationExpandCollapsePattern>() {
                return expand
                    .Expand()
                    .map_err(|error| format!("ExpandCollapse.Expand failed: {error}"));
            }
        }
    }
    if let Ok(pattern) = element.GetCurrentPattern(UIA_InvokePatternId) {
        if let Ok(invoke) = pattern.cast::<IUIAutomationInvokePattern>() {
            return invoke
                .Invoke()
                .map_err(|error| format!("InvokePattern.Invoke failed: {error}"));
        }
    }
    if final_segment {
        if let Ok(pattern) = element.GetCurrentPattern(UIA_SelectionItemPatternId) {
            if let Ok(selection) = pattern.cast::<IUIAutomationSelectionItemPattern>() {
                return selection
                    .Select()
                    .map_err(|error| format!("SelectionItem.Select failed: {error}"));
            }
        }
    }
    Err("element exposes no usable native menu pattern".into())
}

/// Resolve and invoke an exact application menu path from fresh UIA state at
/// every hop. No cached element index survives a menu mutation.
pub fn invoke_menu_path(hwnd: u64, path: &[String]) -> Result<(), String> {
    for depth in 0..path.len() {
        let result = walk_tree(hwnd, None);
        let matches = exact_menu_path_matches(&result.nodes, &path[..=depth]);
        let target_index = match matches.as_slice() {
            [index] => *index,
            [] => {
                unsafe { release_walk_nodes(result.nodes) };
                return Err(format!("menu path segment {depth} was not found"));
            }
            _ => {
                unsafe { release_walk_nodes(result.nodes) };
                return Err(format!("menu path segment {depth} is ambiguous"));
            }
        };
        let target = &result.nodes[target_index];
        let error = if target.enabled == Some(false) {
            Some(format!("menu path segment {depth} is disabled"))
        } else if target.msaa_role.is_some() {
            Some(format!(
                "menu path segment {depth} is exposed only through MSAA, not UI Automation"
            ))
        } else {
            unsafe { invoke_menu_element(target.element_ptr, depth + 1 == path.len()) }.err()
        };
        unsafe { release_walk_nodes(result.nodes) };
        if let Some(error) = error {
            return Err(format!("menu path segment {depth}: {error}"));
        }
        if depth + 1 != path.len() {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
    }
    Ok(())
}

/// Walk the UIA tree with caller-supplied caps. `max_elements`/`max_depth`
/// truncate the walk and the rendered markdown identically. Issue #22865:
/// caps protect against Electron / large web apps that produce 10k+
/// element trees and blow context windows.
pub fn walk_tree_bounded(
    hwnd: u64,
    query: Option<&str>,
    max_elements: usize,
    max_depth: usize,
) -> UiaTreeResult {
    walk_tree_bounded_with_runtime_ids(hwnd, query, max_elements, max_depth, false)
}

pub fn walk_tree_bounded_with_runtime_ids(
    hwnd: u64,
    query: Option<&str>,
    max_elements: usize,
    max_depth: usize,
    collect_runtime_ids: bool,
) -> UiaTreeResult {
    unsafe {
        walk_tree_unsafe(
            hwnd,
            query,
            max_elements,
            max_depth,
            collect_runtime_ids,
            None,
        )
    }
}

/// Incremental variant used by the process-isolated Windows observation
/// worker. Every callback node is display-only (`element_ptr == 0`), so a
/// timed-out partial tree can be returned without exposing invalid bindings.
pub fn walk_tree_bounded_with_progress(
    hwnd: u64,
    query: Option<&str>,
    max_elements: usize,
    max_depth: usize,
    collect_runtime_ids: bool,
    progress: &mut dyn FnMut(UiaNode, String),
) -> UiaTreeResult {
    unsafe {
        walk_tree_unsafe(
            hwnd,
            query,
            max_elements,
            max_depth,
            collect_runtime_ids,
            Some(progress),
        )
    }
}

unsafe fn walk_tree_unsafe(
    hwnd: u64,
    query: Option<&str>,
    max_elements: usize,
    max_depth: usize,
    collect_runtime_ids: bool,
    mut progress: Option<&mut dyn FnMut(UiaNode, String)>,
) -> UiaTreeResult {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

    let automation: IUIAutomation =
        match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(a) => a,
            Err(e) => {
                return UiaTreeResult {
                    tree_markdown: format!("UIA init failed: {e}"),
                    nodes: Vec::new(),
                    backend: UiaBackend::Uia,
                    complete: false,
                    truncated: false,
                    incomplete_notes: vec!["uia_initialization_failed".into()],
                }
            }
        };

    // Fetch one visited element at a time. TreeScope_Subtree is deliberately
    // forbidden here: a provider may materialize an unbounded subtree before
    // our max_elements/max_depth guards ever run.
    let cache_req: IUIAutomationCacheRequest = match automation.CreateCacheRequest() {
        Ok(r) => r,
        Err(e) => {
            return UiaTreeResult {
                tree_markdown: format!("CreateCacheRequest failed: {e}"),
                nodes: Vec::new(),
                backend: UiaBackend::Uia,
                complete: false,
                truncated: false,
                incomplete_notes: vec!["uia_cache_request_failed".into()],
            }
        }
    };

    // Properties to pre-fetch.
    for prop in &[
        UIA_ControlTypePropertyId,
        UIA_NamePropertyId,
        UIA_ValueValuePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_HelpTextPropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_ToggleToggleStatePropertyId,
        UIA_SelectionItemIsSelectedPropertyId,
    ] {
        let _ = cache_req.AddProperty(*prop);
    }

    // Patterns to pre-fetch (for action detection).
    for pat in &[
        UIA_InvokePatternId,
        UIA_TogglePatternId,
        UIA_SelectionItemPatternId,
        UIA_ExpandCollapsePatternId,
        UIA_ValuePatternId,
        UIA_RangeValuePatternId,
        UIA_TextPatternId,
        UIA_ScrollPatternId,
    ] {
        let _ = cache_req.AddPattern(*pat);
    }

    let _ = cache_req.SetTreeScope(TreeScope_Element);

    // Apply control-view filter (same as ControlViewWalker).
    if let Ok(ctrl_cond) = automation.ControlViewCondition() {
        let _ = cache_req.SetTreeFilter(&ctrl_cond);
    }

    let hwnd_win = windows::Win32::Foundation::HWND(hwnd as *mut _);

    // SAL (LibreOffice / OpenOffice) fallback: ALL SAL-class windows go
    // through the MSAA walker.
    //
    // Two reasons:
    //   1. **Hang avoidance** for SALSUBFRAME / SALMENU / SALTMPSUBFRAME —
    //      VCL's UIA provider hangs on `BuildUpdatedCache(TreeScope.Subtree)`
    //      under the daemon's MTA pool, wasting the 4 s outer timeout.
    //   2. **Role fidelity** for SALFRAME (main document window, Recovery
    //      dialog) — UIA technically walks fine, but the built-in
    //      MSAA→UIA proxy collapses `ROLE_SYSTEM_BUTTONDROPDOWN` (0x38) to
    //      a featureless `SplitButton` with no separable dropdown
    //      affordance. MSAA via oleacc.dll preserves the role, letting
    //      the click tool route `action:"expand"` to a right-edge
    //      SendInput click that opens the dropdown half (e.g. LO Writer
    //      "Font Color" → SALTMPSUBFRAME color picker).
    //
    // The UIA pattern dispatches we lose for SALFRAME (Toggle / Select /
    // ExpandCollapse) only matter for WinUI3 controls, which VCL doesn't
    // host. Net win.
    let sal_class: bool = {
        use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd_win, &mut buf);
        n > 0 && String::from_utf16_lossy(&buf[..n as usize]).starts_with("SAL")
    };
    if sal_class {
        return crate::msaa::walk_msaa_tree(hwnd);
    }

    // Resolve only the root here. Each visited node is refreshed separately
    // below, after the caller's limits have been checked.
    let uncached = match automation.ElementFromHandle(hwnd_win) {
        Ok(e) => e,
        Err(e) => {
            return UiaTreeResult {
                tree_markdown: format!("ElementFromHandle failed: {e}"),
                nodes: Vec::new(),
                backend: UiaBackend::Uia,
                complete: false,
                truncated: false,
                incomplete_notes: vec!["uia_target_resolution_failed".into()],
            }
        }
    };
    let walker = match automation.ControlViewWalker() {
        Ok(walker) => walker,
        Err(e) => {
            return UiaTreeResult {
                tree_markdown: format!("ControlViewWalker failed: {e}"),
                nodes: Vec::new(),
                backend: UiaBackend::Uia,
                complete: false,
                truncated: false,
                incomplete_notes: vec!["uia_tree_walker_failed".into()],
            }
        }
    };

    let mut nodes: Vec<UiaNode> = Vec::new();
    let mut lines: Vec<(usize, String)> = Vec::new();
    let mut counter = 0usize;
    let mut total = 0usize;
    let mut status = WalkStatus::complete();

    walk_incremental_bounded(
        &uncached,
        &walker,
        &cache_req,
        0,
        None,
        false,
        collect_runtime_ids,
        &mut nodes,
        &mut lines,
        &mut counter,
        &mut total,
        max_elements,
        max_depth,
        &mut status,
        &mut progress,
    );

    // Fallback for CoreWindow-class apps (Calculator, Settings, older UWPs).
    // `ElementFromHandle(hwnd)` on a `Windows.UI.Core.CoreWindow` HWND returns
    // an empty wrapper — the actual XAML tree is registered at the desktop
    // root as a separate UIA element with the same ProcessId, not as a child
    // of the hwnd's UIA element. inspect.exe walks from root for these apps;
    // we mirror that here when the primary path yields nothing actionable.
    //
    // Trigger: walk produced zero actionable nodes (the primary path may have
    // still pushed a wrapper-only node — that's why we filter on
    // `element_index.is_some()`).
    //
    // Stage the fallback walk into fresh accumulators and only swap them in
    // if the fallback actually finds actionable elements. Otherwise the
    // wrapper-only node from the primary walk stays the result — better than
    // erasing it AND leaving the consumed `MAX_TOTAL_ELEMENTS` budget intact
    // for the fallback (which would then truncate large trees prematurely).
    if nodes.iter().filter(|n| n.element_index.is_some()).count() == 0 {
        // SAL targets use the MSAA path above. Keep this guard as a strict
        // defense against ever re-entering their known-hanging UIA provider.
        let is_sal = {
            use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd_win, &mut buf);
            n > 0 && {
                let class = String::from_utf16_lossy(&buf[..n as usize]);
                class.starts_with("SAL")
            }
        };
        if !is_sal {
            if let Some(target_pid) = pid_from_hwnd(hwnd_win) {
                let mut fallback_nodes: Vec<UiaNode> = Vec::new();
                let mut fallback_lines: Vec<(usize, String)> = Vec::new();
                let mut fallback_counter = 0usize;
                let mut fallback_total = 0usize;
                let mut fallback_status = WalkStatus::complete();

                tracing::debug!(
                    target: "uia",
                    "ElementFromHandle returned empty tree for hwnd 0x{hwnd:x}; \
                     falling back to GetRootElement + filter ProcessId={target_pid}"
                );
                walk_root_by_pid(
                    &automation,
                    &cache_req,
                    &walker,
                    target_pid,
                    collect_runtime_ids,
                    &mut fallback_nodes,
                    &mut fallback_lines,
                    &mut fallback_counter,
                    &mut fallback_total,
                    max_elements,
                    max_depth,
                    &mut fallback_status,
                    &mut progress,
                );

                if fallback_nodes.iter().any(|n| n.element_index.is_some()) {
                    nodes = fallback_nodes;
                    lines = fallback_lines;
                    status = fallback_status;
                    // counter/total aren't read after this point — they're
                    // only used by walk_cached's &mut params for element
                    // indexing inside that call.
                }
            }
        } else {
            tracing::debug!(
                target: "uia",
                "SAL target hwnd 0x{hwnd:x} returned empty primary tree; \
                 skipping walk_root_by_pid fallback (known hanging provider). \
                 Caller should use press_key/screenshot fallbacks per the get_window_state diagnostic."
            );
            // Return a tree_markdown that mirrors the get_window_state
            // timeout diagnostic so callers get the same actionable
            // fallback options even though the walk itself didn't hit
            // the 4 s outer timeout (because we skipped the hang-prone
            // fallback). Without this the caller sees an empty tree
            // and no error, which is less actionable.
            let stub = format!(
                "- Window <SAL class — empty primary UIA tree>\n\
                 (SAL providers don't expose modal-dialog children via \
                 ElementFromHandle, and the desktop-root fallback walk that \
                 would normally find them is known to hang. Use one of: \
                 (a) pixel `click(x, y)` off the screenshot `get_window_state` \
                 returns alongside this tree; \
                 (b) `press_key` with `delivery_mode:\"foreground\"` (Esc / Enter / Y / N).)\n"
            );
            return UiaTreeResult {
                tree_markdown: stub,
                nodes: Vec::new(),
                backend: UiaBackend::Uia,
                complete: false,
                truncated: false,
                incomplete_notes: vec!["uia_sal_primary_tree_empty".into()],
            };
        }
    }

    let raw_md = render_lines(&lines);
    let tree_markdown = if let Some(q) = query {
        filter_tree(&raw_md, q)
    } else {
        raw_md
    };

    UiaTreeResult {
        tree_markdown,
        nodes,
        backend: UiaBackend::Uia,
        complete: status.complete,
        truncated: status.truncated,
        incomplete_notes: status.incomplete_notes,
    }
}

/// Resolve the owning process id of `hwnd` via `GetWindowThreadProcessId`.
/// Returns `None` if the API fails or the HWND is invalid.
unsafe fn pid_from_hwnd(hwnd: windows::Win32::Foundation::HWND) -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if tid == 0 || pid == 0 {
        None
    } else {
        Some(pid)
    }
}

/// Root-walk UIA fallback for apps whose top-level window is a
/// `Windows.UI.Core.CoreWindow` (Calculator, Settings, older UWPs).
///
/// `ElementFromHandle(CoreWindow_hwnd)` returns an empty wrapper for these —
/// the actual XAML tree is registered at the desktop root as a sibling
/// element with the same `ProcessId`. We enumerate the root's children
/// (filtered by `ProcessId == target_pid`) and walk descendants from there,
/// reusing the caller's `cache_req` so the same properties + patterns get
/// pre-fetched as the primary path.
#[allow(clippy::too_many_arguments)]
unsafe fn walk_root_by_pid(
    automation: &IUIAutomation,
    cache_req: &IUIAutomationCacheRequest,
    walker: &IUIAutomationTreeWalker,
    target_pid: u32,
    collect_runtime_ids: bool,
    nodes: &mut Vec<UiaNode>,
    lines: &mut Vec<(usize, String)>,
    counter: &mut usize,
    total: &mut usize,
    max_elements: usize,
    max_depth: usize,
    status: &mut WalkStatus,
    progress: &mut Option<&mut dyn FnMut(UiaNode, String)>,
) {
    let root = match automation.GetRootElement() {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(target: "uia", "GetRootElement failed: {e}");
            status.incomplete("uia_root_resolution_failed");
            return;
        }
    };
    let mut elem = match walker.GetFirstChildElement(&root) {
        Ok(element) => Some(element),
        Err(error) if is_empty_cached_leaf(&error) => None,
        Err(error) => {
            tracing::debug!(target: "uia", "root first child failed: {error}");
            status.incomplete("uia_root_children_failed");
            return;
        }
    };
    // Desktop root discovery is separate from the caller's target-subtree
    // budget, but it is still bounded so a broken desktop provider cannot
    // make an unbounded number of cross-process calls.
    for _ in 0..512 {
        let Some(current) = elem.take() else { break };
        // Read ProcessId without a cache — root.FindAll didn't use one.
        // VARIANT for VT_I4 (UIA's ProcessId type) puts the int at
        // Anonymous.Anonymous.Anonymous.lVal; mirrors the read_cached_bool
        // pattern below for VT_BOOL.
        let pid: u32 = match current.GetCurrentPropertyValue(UIA_ProcessIdPropertyId) {
            Ok(v) => {
                let raw = v.as_raw();
                if raw.Anonymous.Anonymous.vt != 3
                /* VT_I4 */
                {
                    elem = next_sibling(walker, &current, status);
                    continue;
                }
                raw.Anonymous.Anonymous.Anonymous.lVal as u32
            }
            Err(_) => {
                status.incomplete("uia_root_process_id_failed");
                elem = next_sibling(walker, &current, status);
                continue;
            }
        };
        if pid != target_pid {
            elem = next_sibling(walker, &current, status);
            continue;
        }
        walk_incremental_bounded(
            &current,
            walker,
            cache_req,
            0,
            None,
            false,
            collect_runtime_ids,
            nodes,
            lines,
            counter,
            total,
            max_elements,
            max_depth,
            status,
            progress,
        );
        elem = next_sibling(walker, &current, status);
    }
}

unsafe fn next_sibling(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    status: &mut WalkStatus,
) -> Option<IUIAutomationElement> {
    match walker.GetNextSiblingElement(element) {
        Ok(element) => Some(element),
        Err(error) if is_empty_cached_leaf(&error) => None,
        Err(_) => {
            status.incomplete("uia_sibling_read_failed");
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn walk_incremental_bounded(
    uncached: &IUIAutomationElement,
    walker: &IUIAutomationTreeWalker,
    cache_req: &IUIAutomationCacheRequest,
    depth: usize,
    parent_index: Option<usize>,
    in_web_content: bool,
    collect_runtime_ids: bool,
    nodes: &mut Vec<UiaNode>,
    lines: &mut Vec<(usize, String)>,
    counter: &mut usize,
    total: &mut usize,
    max_elements: usize,
    max_depth: usize,
    status: &mut WalkStatus,
    progress: &mut Option<&mut dyn FnMut(UiaNode, String)>,
) {
    // These checks happen before BuildUpdatedCache/GetFirstChildElement. The
    // limits therefore bound provider work, not merely the returned vector.
    if depth > max_depth {
        status.truncate("uia_max_depth_reached");
        return;
    }
    if *total >= max_elements {
        status.truncate("uia_max_elements_reached");
        return;
    }
    *total += 1;

    let element = match refresh_element(uncached, cache_req) {
        Ok(element) => element,
        Err(error) => {
            tracing::debug!(target: "uia", "element cache refresh failed: {error}");
            status.incomplete("uia_provider_invalidated");
            return;
        }
    };

    let control_type = read_cached_control_type(&element);
    let name = read_cached_bstr_name(&element);
    let value = read_cached_bstr_value(&element);
    let automation_id = read_cached_bstr(&element, UIA_AutomationIdPropertyId);
    let help_text = read_cached_bstr(&element, UIA_HelpTextPropertyId);
    let enabled = read_cached_bool(&element, UIA_IsEnabledPropertyId);
    // Missing UIA state must remain unknown on the structured observation
    // surface. Action discovery keeps its historical best-effort assumption.
    let is_enabled = enabled.unwrap_or(true);
    let selected = read_cached_selected(&element);
    let actions = detect_cached_actions(&element, &control_type, is_enabled);
    let is_actionable = !actions.is_empty() && is_enabled;
    let has_content = name
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || value
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

    let mut emitted_parent: Option<usize> = parent_index;
    if is_actionable || has_content {
        let retained: IUIAutomationElement = element.clone();
        let ptr = retained.as_raw() as usize;
        std::mem::forget(retained);

        let node = if is_actionable {
            let idx = *counter;
            *counter += 1;
            let (center_x, center_y, rect) = read_cached_bounding_rect_full(&element);
            emitted_parent = Some(idx);
            UiaNode {
                element_index: Some(idx),
                control_type: control_type.clone(),
                name: name.clone(),
                value: value.clone(),
                automation_id: automation_id.clone(),
                help_text: help_text.clone(),
                actions: actions.clone(),
                runtime_id: if collect_runtime_ids {
                    read_runtime_id(&element)
                } else {
                    None
                },
                enabled,
                selected,
                element_ptr: ptr,
                center_x,
                center_y,
                rect,
                msaa_role: None,
                depth,
                parent_element_index: parent_index,
                in_web_content,
            }
        } else {
            UiaNode {
                element_index: None,
                control_type: control_type.clone(),
                name: name.clone(),
                value: value.clone(),
                automation_id: automation_id.clone(),
                help_text: help_text.clone(),
                actions: vec![],
                runtime_id: if collect_runtime_ids {
                    read_runtime_id(&element)
                } else {
                    None
                },
                enabled,
                selected,
                element_ptr: ptr,
                center_x: 0,
                center_y: 0,
                rect: None,
                msaa_role: None,
                depth,
                parent_element_index: parent_index,
                in_web_content,
            }
        };

        let line = format_node_line(&node);
        lines.push((depth, line.clone()));
        nodes.push(node);
        if let (Some(callback), Some(last)) = (progress.as_deref_mut(), nodes.last()) {
            let mut detached = last.clone();
            detached.element_ptr = 0;
            callback(detached, line);
        }
    }

    if depth == max_depth {
        status.truncate("uia_max_depth_reached");
        return;
    }
    if *total >= max_elements {
        status.truncate("uia_max_elements_reached");
        return;
    }

    let mut child = match walker.GetFirstChildElement(uncached) {
        Ok(child) => Some(child),
        Err(error) if is_empty_cached_leaf(&error) => None,
        Err(_) => {
            status.incomplete("uia_children_read_failed");
            None
        }
    };
    while let Some(current) = child.take() {
        if *total >= max_elements {
            status.truncate("uia_max_elements_reached");
            break;
        }
        walk_incremental_bounded(
            &current,
            walker,
            cache_req,
            depth + 1,
            emitted_parent,
            in_web_content || control_type.eq_ignore_ascii_case("Document"),
            collect_runtime_ids,
            nodes,
            lines,
            counter,
            total,
            max_elements,
            max_depth,
            status,
            progress,
        );
        if *total >= max_elements {
            status.truncate("uia_max_elements_reached");
            break;
        }
        child = next_sibling(walker, &current, status);
    }
}

unsafe fn refresh_element(
    element: &IUIAutomationElement,
    cache_req: &IUIAutomationCacheRequest,
) -> windows::core::Result<IUIAutomationElement> {
    const MAX_ATTEMPTS: usize = 3;
    let mut last = None;
    for attempt in 0..MAX_ATTEMPTS {
        match element.BuildUpdatedCache(cache_req) {
            Ok(cached) => return Ok(cached),
            Err(error) => {
                last = Some(error);
                if attempt + 1 != MAX_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            }
        }
    }
    Err(last.expect("cache refresh attempted"))
}

fn is_empty_cached_leaf(error: &windows::core::Error) -> bool {
    error.code() == S_OK
}

#[cfg(test)]
mod cached_children_tests {
    use super::*;

    #[test]
    fn null_cached_children_are_an_empty_leaf() {
        assert!(is_empty_cached_leaf(&windows::core::Error::empty()));
        assert!(!is_empty_cached_leaf(&windows::core::Error::from_hresult(
            windows::core::HRESULT(0x80004005_u32 as i32),
        )));
    }
}

fn read_cached_control_type(element: &IUIAutomationElement) -> String {
    unsafe {
        element
            .CachedControlType()
            .ok()
            .map(|ct| control_type_name(ct.0))
            .unwrap_or_else(|| "Unknown".into())
    }
}

fn read_cached_bstr_name(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let bstr = element.CachedName().ok()?;
        let s = bstr.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn read_cached_bstr_value(element: &IUIAutomationElement) -> Option<String> {
    read_cached_bstr(element, UIA_ValueValuePropertyId)
}

fn read_cached_bstr(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Option<String> {
    unsafe {
        let variant = element.GetCachedPropertyValue(property_id).ok()?;
        if variant.as_raw().Anonymous.Anonymous.vt == 8 {
            let bstr = BSTR::from_raw(variant.as_raw().Anonymous.Anonymous.Anonymous.bstrVal);
            let s = bstr.to_string();
            std::mem::forget(bstr);
            if s.trim().is_empty() {
                None
            } else {
                Some(s)
            }
        } else {
            None
        }
    }
}

fn read_cached_bool(
    element: &IUIAutomationElement,
    property_id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> Option<bool> {
    unsafe {
        let variant = element.GetCachedPropertyValue(property_id).ok()?;
        if variant.as_raw().Anonymous.Anonymous.vt == 11 {
            Some(variant.as_raw().Anonymous.Anonymous.Anonymous.boolVal != 0)
        } else {
            None
        }
    }
}

/// Read bounding rect as (center_x, center_y, Some((l,t,r,b))). Returns
/// rect=None when the element has no meaningful BoundingRectangle (offscreen
/// containers, structure-only elements).
fn read_cached_bounding_rect_full(
    element: &IUIAutomationElement,
) -> (i32, i32, Option<(i32, i32, i32, i32)>) {
    unsafe {
        match element.CachedBoundingRectangle() {
            Ok(r) if r.right > r.left && r.bottom > r.top => (
                (r.left + r.right) / 2,
                (r.top + r.bottom) / 2,
                Some((r.left, r.top, r.right, r.bottom)),
            ),
            _ => (0, 0, None),
        }
    }
}

fn detect_cached_actions(
    element: &IUIAutomationElement,
    control_type: &str,
    is_enabled: bool,
) -> Vec<String> {
    if !is_enabled {
        return vec![];
    }
    let mut actions = Vec::new();
    unsafe {
        if element.GetCachedPattern(UIA_InvokePatternId).is_ok() {
            actions.push("invoke".into());
        }
        if element.GetCachedPattern(UIA_TogglePatternId).is_ok() {
            actions.push("toggle".into());
        }
        if element.GetCachedPattern(UIA_SelectionItemPatternId).is_ok() {
            actions.push("select".into());
        }
        if element
            .GetCachedPattern(UIA_ExpandCollapsePatternId)
            .is_ok()
        {
            actions.push("expand".into());
        }
        if element.GetCachedPattern(UIA_ValuePatternId).is_ok() {
            actions.push("set_value".into());
        }
        // RangeValuePattern is exposed by Sliders, ProgressBars, and other
        // numeric-range controls. Without this entry the slider parent
        // gets actions=[] → marked non-actionable → no `[N]` index in the
        // flat tree, making the slider unaddressable by AutomationId.
        if element.GetCachedPattern(UIA_RangeValuePatternId).is_ok() {
            actions.push("set_value".into());
        }
        if element.GetCachedPattern(UIA_TextPatternId).is_ok() {
            actions.push("text".into());
        }
        if element.GetCachedPattern(UIA_ScrollPatternId).is_ok() {
            actions.push("scroll".into());
        }
    }
    if actions.is_empty() && control_type == "MenuItem" {
        // Some WPF MenuItem peers show up in ControlView with a usable name
        // and bounding rectangle, but without cached Invoke/ExpandCollapse
        // patterns. Index them anyway so click can retry live patterns and then
        // fall back to the coordinate injector if UIA still reports no pattern.
        actions.push("invoke".into());
    }
    actions
}

fn read_cached_selected(element: &IUIAutomationElement) -> Option<bool> {
    unsafe {
        if let Ok(pattern) = element.GetCachedPattern(UIA_TogglePatternId) {
            if let Ok(toggle) = pattern.cast::<IUIAutomationTogglePattern>() {
                return match toggle.CachedToggleState() {
                    Ok(state) if state == ToggleState_On => Some(true),
                    Ok(state) if state == ToggleState_Off => Some(false),
                    _ => None,
                };
            }
        }
        if let Ok(pattern) = element.GetCachedPattern(UIA_SelectionItemPatternId) {
            if let Ok(selection) = pattern.cast::<IUIAutomationSelectionItemPattern>() {
                return selection
                    .CachedIsSelected()
                    .ok()
                    .map(|selected| selected.as_bool());
            }
        }
    }
    None
}

fn read_runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
    unsafe {
        use windows::Win32::System::Ole::{
            SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound,
            SafeArrayGetUBound,
        };

        let array = element.GetRuntimeId().ok()?;
        if array.is_null() {
            return None;
        }
        let result = (|| {
            if SafeArrayGetDim(array) != 1 {
                return None;
            }
            let lower = SafeArrayGetLBound(array, 1).ok()?;
            let upper = SafeArrayGetUBound(array, 1).ok()?;
            if upper < lower {
                return None;
            }
            let mut values = Vec::with_capacity((upper - lower + 1) as usize);
            for index in lower..=upper {
                let mut value = 0i32;
                SafeArrayGetElement(
                    array,
                    &index,
                    &mut value as *mut i32 as *mut core::ffi::c_void,
                )
                .ok()?;
                values.push(value);
            }
            (!values.is_empty()).then_some(values)
        })();
        let _ = SafeArrayDestroy(array);
        result
    }
}

fn control_type_name(id: i32) -> String {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
    .into()
}

pub(crate) fn format_node_line(node: &UiaNode) -> String {
    let mut s = String::new();
    if let Some(idx) = node.element_index {
        s.push_str(&format!("- [{}] {}", idx, node.control_type));
        if let Some(n) = &node.name {
            s.push_str(&format!(" \"{}\"", n));
        }
        let mut attrs = Vec::new();
        if let Some(v) = &node.value {
            attrs.push(format!("value=\"{}\"", v));
        }
        if let Some(id) = &node.automation_id {
            attrs.push(format!("id={}", id));
        }
        if let Some(h) = &node.help_text {
            attrs.push(format!("help=\"{}\"", h));
        }
        if !node.actions.is_empty() {
            attrs.push(format!("actions=[{}]", node.actions.join(",")));
        }
        if !attrs.is_empty() {
            s.push_str(&format!(" [{}]", attrs.join(" ")));
        }
    } else {
        s.push_str(&format!("- {}", node.control_type));
        if let Some(n) = &node.name {
            s.push_str(&format!(" \"{}\"", n));
        }
        if let Some(v) = &node.value {
            s.push_str(&format!(" = \"{}\"", v));
        }
    }
    s
}

pub(crate) fn format_revision_body(node: &UiaNode) -> String {
    let label = node
        .name
        .as_deref()
        .or(node.value.as_deref())
        .or(node.automation_id.as_deref())
        .or(node.help_text.as_deref())
        .unwrap_or_default();
    let mut fields = vec![
        format!("<{}>", node.control_type),
        serde_json::to_string(label).expect("string labels serialize"),
    ];
    if let Some(value) = node.value.as_deref().filter(|value| !value.is_empty()) {
        fields.push(format!(
            "value={}",
            serde_json::to_string(value).expect("string values serialize")
        ));
    }
    if let Some(automation_id) = node
        .automation_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        fields.push(format!(
            "automation_id={}",
            serde_json::to_string(automation_id).expect("string ids serialize")
        ));
    }
    if let Some(enabled) = node.enabled {
        fields.push(format!("enabled={enabled}"));
    }
    if let Some(selected) = node.selected {
        fields.push(format!("selected={selected}"));
    }
    if !node.actions.is_empty() {
        fields.push(format!(
            "actions={}",
            serde_json::to_string(&node.actions).expect("string actions serialize")
        ));
    }
    if let Some((left, top, right, bottom)) = node.rect {
        fields.push(format!(
            "frame={left},{top},{},{}",
            (right - left).max(0),
            (bottom - top).max(0)
        ));
    }
    if node.in_web_content {
        fields.push("in_web_content=true".into());
    }
    fields.join(" ")
}

fn render_lines(lines: &[(usize, String)]) -> String {
    let mut out = String::new();
    for (depth, line) in lines {
        for _ in 0..*depth {
            out.push_str("  ");
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn filter_tree(markdown: &str, query: &str) -> String {
    let needle = query.to_lowercase();
    let lines: Vec<&str> = markdown.lines().collect();
    let mut ancestors: Vec<&str> = Vec::new();
    let mut last_emitted: Vec<Option<&str>> = Vec::new();
    let mut output: Vec<&str> = Vec::new();

    for line in &lines {
        let depth = line.chars().take_while(|c| *c == ' ').count() / 2;
        while ancestors.len() <= depth {
            ancestors.push("");
            last_emitted.push(None);
        }
        for d in (depth + 1)..ancestors.len() {
            last_emitted[d] = None;
        }
        ancestors[depth] = line;

        if line.to_lowercase().contains(&needle) {
            for d in 0..depth {
                if ancestors[d].is_empty() {
                    continue;
                }
                if last_emitted[d] == Some(ancestors[d]) {
                    continue;
                }
                last_emitted[d] = Some(ancestors[d]);
                output.push(ancestors[d]);
            }
            last_emitted[depth] = Some(line);
            output.push(line);
        }
    }

    if output.is_empty() {
        return String::new();
    }
    let mut r = output.join("\n");
    r.push('\n');
    r
}
