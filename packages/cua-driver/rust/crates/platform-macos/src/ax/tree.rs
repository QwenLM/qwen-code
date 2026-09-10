//! AX tree walker: produces the treeMarkdown string and element cache.
//!
//! Format (matching packages/cua-driver exactly):
//!   `INDENT- [N] AXRole "Title" [value="..." actions=[...]]`
//!   `INDENT- AXStaticText = "value"`  (non-indexed)
//!
//! Rules (from qwen-cua-driver reference):
//! - An element is addressable (gets an index) when it has ≥1 action name or
//!   exposes a writable AXValue control surface.
//! - Non-actionable leaf nodes with a value are rendered as `AXRole = "value"`.
//! - AXStaticText with no title/value is omitted.
//! - Tree is walked depth-first; element_index is assigned in DFS order.

use super::bindings::*;
use super::window_scope::{decide_window_scope, TopLevelCandidate, WindowScope};
use core_foundation::base::{CFEqual, CFHash, CFRelease, CFRetain, CFTypeRef};
use std::hash::{Hash, Hasher};

/// Default maximum depth for AX tree walks. Deep menus and complex web views
/// can nest deeply; 25 covers realistic app chrome without exploding on
/// pathological trees (mirrors Swift reference implementation).
///
/// Callers can override per-call via `walk_tree`'s `max_depth` parameter to
/// trade fidelity for context-window budget on AX-heavy apps (Electron,
/// Obsidian, large web apps — issue #22865).
pub const DEFAULT_MAX_DEPTH: usize = 25;

/// Default maximum total nodes visited during a single AX walk. Chromium-family
/// apps (Arc, VS Code, Chrome) can expose thousands of nodes; capping at 2 000
/// keeps the walk bounded while still covering realistic app chrome.
/// When the cap is hit the walk stops early and the partial tree is returned
/// with a warning line appended (mirrors Swift reference implementation).
///
/// Callers can override per-call via `walk_tree`'s `max_elements` parameter
/// (issue #22865).
pub const DEFAULT_MAX_ELEMENTS: usize = 2_000;

/// Bound each native AX request. Tokio cannot cancel a blocked
/// `AXUIElementCopyAttributeValue` after `spawn_blocking` starts, so the native
/// messaging timeout is what keeps an unresponsive app from retaining a worker
/// indefinitely.
const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 2.0;

unsafe fn set_messaging_timeout(element: AXUIElementRef) {
    let _ = AXUIElementSetMessagingTimeout(element, AX_MESSAGING_TIMEOUT_SECONDS);
}

#[derive(Debug)]
pub struct AXIdentity(usize);

impl AXIdentity {
    pub(super) unsafe fn retained(element: AXUIElementRef) -> Self {
        CFRetain(element as CFTypeRef);
        Self(element as usize)
    }

    pub fn as_ptr(&self) -> usize {
        self.0
    }
}

#[cfg(test)]
mod identity_tests {
    use super::AXIdentity;
    use crate::ax::bindings::AXUIElementCreateApplication;
    use core_foundation::base::{CFRelease, CFTypeRef};
    use std::hash::{DefaultHasher, Hash, Hasher};

    #[test]
    fn independently_created_proxies_for_the_same_application_share_identity() {
        unsafe {
            let first = AXUIElementCreateApplication(std::process::id() as i32);
            let second = AXUIElementCreateApplication(std::process::id() as i32);
            assert!(!first.is_null());
            assert!(!second.is_null());

            let first_identity = AXIdentity::retained(first);
            let second_identity = AXIdentity::retained(second);
            CFRelease(first as CFTypeRef);
            CFRelease(second as CFTypeRef);

            assert_eq!(first_identity, second_identity);
            let mut first_hash = DefaultHasher::new();
            first_identity.hash(&mut first_hash);
            let mut second_hash = DefaultHasher::new();
            second_identity.hash(&mut second_hash);
            assert_eq!(first_hash.finish(), second_hash.finish());
        }
    }
}

impl Clone for AXIdentity {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0 as CFTypeRef) };
        Self(self.0)
    }
}

impl Drop for AXIdentity {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

impl PartialEq for AXIdentity {
    fn eq(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0 as CFTypeRef, other.0 as CFTypeRef) != 0 }
    }
}

impl Eq for AXIdentity {}

impl Hash for AXIdentity {
    fn hash<H: Hasher>(&self, state: &mut H) {
        unsafe { CFHash(self.0 as CFTypeRef) }.hash(state);
    }
}

/// A single node in the AX tree.
#[derive(Debug, Clone)]
pub struct AXNode {
    /// 0-based index (Some = actionable, None = non-actionable display-only node)
    pub element_index: Option<usize>,
    pub role: String,
    /// AXTitle — shown as `"title"` in the tree line.
    pub title: Option<String>,
    /// AXValue — shown as `= "value"` in the tree line.
    pub value: Option<String>,
    /// AXDescription — shown as `(description)` in the tree line.
    /// Kept separate from `title` so `_find_calc_button("2")` can find
    /// Calculator buttons where AXTitle="" but AXDescription="2".
    pub description: Option<String>,
    pub identifier: Option<String>,
    pub help: Option<String>,
    pub actions: Vec<String>,
    /// The raw AXUIElementRef pointer value, for caching.
    pub element_ptr: usize,
    pub identity: Option<AXIdentity>,
    /// Depth in the rendered markdown tree (matches the indent level used in
    /// `tree_markdown`). Layout containers AXScrollArea/AXGroup collapse so
    /// children share the parent's depth.
    pub depth: usize,
    /// `element_index` of the nearest actionable ancestor, if any. Walks the
    /// rendered tree (so it skips collapsed layout containers).
    pub parent_element_index: Option<usize>,
    /// Screen-coordinate bounding rect `[x, y, width, height]` captured at
    /// walk time. `None` when AX didn't report a usable position+size.
    pub frame: Option<[f64; 4]>,
    /// AXValue coerced to a string for ALL CF types (CFNumber → "8",
    /// CFBoolean → "1"/"0", CFString as-is). Kept separate from `value`
    /// (string-only) so tree_markdown and the has_content gate — both of
    /// which read `value` — stay byte-identical; only the structured
    /// `elements` array consumes this.
    pub value_state: Option<String>,
    /// AXValueDescription — human-readable value form (e.g. "8 dB").
    pub value_description: Option<String>,
    /// AXMinValue / AXMaxValue for range controls (sliders, steppers).
    pub min_value: Option<f64>,
    pub max_value: Option<f64>,
    /// AXEnabled. `None` when the app doesn't report the attribute.
    pub enabled: Option<bool>,
    /// AXSelected. `None` when the app doesn't report the attribute.
    pub selected: Option<bool>,
    /// True when this node is an AX web-document root or descends from one.
    /// This trust marker is independent of actionable ancestry because
    /// AXWebArea is commonly non-actionable and therefore has no element index.
    pub in_web_content: bool,
}

#[derive(Default)]
struct ControlState {
    value_state: Option<String>,
    value_description: Option<String>,
    min_value: Option<f64>,
    max_value: Option<f64>,
    enabled: Option<bool>,
    selected: Option<bool>,
}

fn read_control_state_if_actionable<F>(is_actionable: bool, read: F) -> ControlState
where
    F: FnOnce() -> ControlState,
{
    if is_actionable {
        read()
    } else {
        ControlState::default()
    }
}

fn role_supports_value_addressing(role: &str) -> bool {
    matches!(
        role,
        "AXTextField"
            | "AXTextArea"
            | "AXComboBox"
            | "AXSlider"
            | "AXStepper"
            | "AXCheckBox"
            | "AXRadioButton"
    )
}

fn is_addressable(actions_present: bool, value_settable: bool, enabled: Option<bool>) -> bool {
    (actions_present || value_settable) && enabled != Some(false)
}

pub struct TreeWalkResult {
    pub tree_markdown: String,
    pub nodes: Vec<AXNode>,
    pub complete: bool,
    /// Bounded trace naming why `complete` is false (attribute + AX error),
    /// drained from the walk's thread-local recorder. Empty on complete walks.
    pub incomplete_notes: Vec<String>,
    /// True when the walk was cut short by the MAX_ELEMENTS cap.
    pub truncated: bool,
    /// Whether the requested `window_id` actually resolved to an AX surface,
    /// and if not, why. `None` when no `window_id` was requested.
    ///
    /// Issue #2237: without this, an unresolvable id was indistinguishable
    /// from a clean snapshot — callers had no way to tell that the tree they
    /// were handed belonged to a different surface. Any variant other than
    /// [`WindowScope::Matched`] comes with an EMPTY walk, so `nodes` never
    /// describes a window other than the requested one.
    pub window_scope: Option<WindowScope>,
}

/// Walk the AX tree of `pid`, optionally filtered to a specific window.
///
/// `window_id` — when Some, only the AXWindow matching that CGWindowID is
/// walked (plus non-window children like the menu bar). When None, all
/// top-level children are walked.
///
/// Key background-app fix: at the application root we union `AXChildren`
/// and `AXWindows`. macOS only puts windows in `AXChildren` when the app
/// is frontmost; `AXWindows` returns the window list regardless of focus
/// state. Without this union, Safari / any backgrounded app returns an
/// empty tree.
///
/// # Safety
/// Calls macOS AX API. Must be called on a thread that has a CF run loop.
pub fn walk_tree(pid: i32, window_id: Option<u32>, query: Option<&str>) -> TreeWalkResult {
    walk_tree_bounded(
        pid,
        window_id,
        query,
        DEFAULT_MAX_ELEMENTS,
        DEFAULT_MAX_DEPTH,
    )
}

/// Walk the AX tree with caller-supplied caps. See [`walk_tree`] for the
/// common case (defaults apply). `max_elements`/`max_depth` clamp the
/// rendered tree breadth-wise (DFS truncated when the element counter hits
/// the cap) and depth-wise (nodes whose markdown indent would exceed the cap
/// are omitted). Markdown and the `nodes` vec are truncated identically.
///
/// Issue #22865: caps protect against Electron / Obsidian / large web apps
/// that produce 10k+ element trees and blow context windows.
pub fn walk_tree_bounded(
    pid: i32,
    window_id: Option<u32>,
    query: Option<&str>,
    max_elements: usize,
    max_depth: usize,
) -> TreeWalkResult {
    let mut nodes: Vec<AXNode> = Vec::new();
    let mut lines: Vec<(usize, String)> = Vec::new(); // (depth, line)
    let mut index_counter = 0usize;
    // Shared visited-node counter passed into walk_element to enforce the cap.
    let mut visited_count = 0usize;
    // Set to true only when walk_element actually stops early due to the cap —
    // avoids a false-positive when the tree naturally ends on exactly the cap.
    let mut truncated = false;
    let mut complete = true;
    let mut window_scope: Option<WindowScope> = None;
    super::bindings::reset_incomplete_notes();

    unsafe {
        let app_elem = AXUIElementCreateApplication(pid);
        if app_elem.is_null() {
            super::bindings::note_incomplete("AXApplication", "null application element");
            return TreeWalkResult {
                tree_markdown: String::new(),
                nodes,
                complete: false,
                incomplete_notes: super::bindings::take_incomplete_notes(),
                truncated: false,
                // No application AX element at all, so a requested window
                // certainly did not resolve.
                window_scope: window_id.map(|_| WindowScope::AxUnresolved { ax_window_count: 0 }),
            };
        }
        set_messaging_timeout(app_elem);

        // Chromium/Electron apps (Arc, VS Code, Electron shells) ship their
        // web-content AX tree OFF and only build it once an assistive client
        // asks for it. Without this, the first walk of such an app returns an
        // empty/title-bar-only tree (#1616). Flip the enablement attribute,
        // then — only when the flip actually took and only the first time we
        // see this process lifetime — let the asynchronously-built tree settle
        // before we read it. Native Cocoa apps reject the attribute, so they
        // pay no settle cost. This relies on the MAX_ELEMENTS node cap to keep
        // the now-materialized (potentially large) tree bounded.
        super::enablement::ensure_chromium_ax_enabled(pid, app_elem);

        // Union AXChildren + AXWindows — the only way to see background windows.
        // AXChildren omits windows when the app isn't frontmost (AppKit limitation).
        // AXWindows returns the window list regardless of activation state.
        let from_children = copy_children_with_status(app_elem);
        let from_windows = copy_ax_windows_with_status(app_elem);
        complete &= from_children.complete && from_windows.complete;

        let mut top_level = from_children.elements;
        for w in from_windows.elements {
            // AXChildren and AXWindows can return different proxy pointers for
            // the same native window. CFEqual compares their AX identity;
            // pointer equality alone duplicates the whole subtree and can turn
            // one exact dialog action into a false ambiguity.
            if !top_level
                .iter()
                .any(|&e| CFEqual(e as CFTypeRef, w as CFTypeRef) != 0)
            {
                top_level.push(w);
            } else {
                // Already present — release the extra retain from copy_ax_windows.
                CFRelease(w as CFTypeRef);
            }
        }

        // Scope: keep non-window children (menu bar) + the target window —
        // but ONLY once the target window has actually been identified. When
        // nothing claims the requested id, `decide_window_scope` reports why
        // and walks nothing; it must never fall back to "everything that isn't
        // a window", which is how issue #2237 returned menu bars as panels.
        let walk_these: Vec<AXUIElementRef> = if let Some(wid) = window_id {
            let candidates: Vec<TopLevelCandidate> = top_level
                .iter()
                .map(|&child| {
                    set_messaging_timeout(child);
                    let role_read = copy_string_attr_with_status(child, "AXRole");
                    if role_read.complete && role_read.value.is_none() {
                        super::bindings::note_incomplete(
                            "AXRole",
                            "top-level element with no role value",
                        );
                    }
                    complete &= role_read.complete && role_read.value.is_some();
                    let role = role_read.value.unwrap_or_default();
                    let subrole_read = copy_string_attr_with_status(child, "AXSubrole");
                    complete &= subrole_read.complete;
                    let identifier_read = copy_string_attr_with_status(child, "AXIdentifier");
                    complete &= identifier_read.complete;
                    // Match AX window element → CGWindowID via private SPI.
                    // Only windows carry one, so skip the round-trip elsewhere.
                    let ax_window_id = if role == "AXWindow" {
                        ax_get_window_id(child)
                    } else {
                        None
                    };
                    TopLevelCandidate {
                        role,
                        subrole: subrole_read.value,
                        identifier: identifier_read.value,
                        ax_window_id,
                    }
                })
                .collect();
            let decision = decide_window_scope(&candidates, wid, || {
                crate::windows::resolve_window_owner(pid, wid)
            });
            let walk = decision
                .walk
                .iter()
                .map(|&index| top_level[index])
                .collect();
            window_scope = Some(decision.scope);
            walk
        } else {
            top_level.to_vec()
        };

        // Walk each top-level child at depth 0.
        for child in walk_these {
            walk_element(
                child,
                0,
                None,
                false,
                &mut nodes,
                &mut lines,
                &mut index_counter,
                &mut visited_count,
                &mut truncated,
                &mut complete,
                max_elements,
                max_depth,
            );
        }

        // Release all top-level elements (copy_children / copy_ax_windows both retain).
        for child in top_level {
            CFRelease(child as CFTypeRef);
        }

        CFRelease(app_elem as CFTypeRef);
    }

    let truncated_flag = truncated;
    let raw_markdown = render_lines(&lines);
    let mut tree_markdown = if let Some(q) = query {
        filter_tree(&raw_markdown, q)
    } else {
        raw_markdown
    };

    if truncated_flag {
        tree_markdown.push_str(&format!(
            "\n⚠️  AX tree truncated at {max_elements} nodes \
             (app has a very large accessibility tree — Arc, Electron, or similar). \
             Element indices above are still valid. Use pixel clicks for elements \
             not visible in this partial tree."
        ));
    }

    TreeWalkResult {
        tree_markdown,
        nodes,
        complete: complete && !truncated_flag,
        incomplete_notes: super::bindings::take_incomplete_notes(),
        truncated: truncated_flag,
        window_scope,
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn walk_element(
    element: AXUIElementRef,
    depth: usize,
    parent_index: Option<usize>,
    in_web_content: bool,
    nodes: &mut Vec<AXNode>,
    lines: &mut Vec<(usize, String)>,
    counter: &mut usize,
    visited_count: &mut usize,
    truncated: &mut bool,
    complete: &mut bool,
    max_elements: usize,
    max_depth: usize,
) {
    if depth > max_depth {
        super::bindings::note_incomplete("walk", "max_depth exceeded");
        *complete = false;
        return;
    }
    // Enforce total-node cap — mirrors Swift's maxElements guard.
    // Set the truncated flag only when we actually stop early.
    if *visited_count >= max_elements {
        super::bindings::note_incomplete("walk", "max_elements truncated");
        *truncated = true;
        *complete = false;
        return;
    }
    *visited_count += 1;

    // Messaging timeouts are per AX object, not inherited from the application
    // element, so every descendant must be bounded before any attribute read.
    set_messaging_timeout(element);

    let role_read = copy_string_attr_with_status(element, "AXRole");
    if role_read.complete && role_read.value.is_none() {
        super::bindings::note_incomplete("AXRole", "success with no role value");
    }
    *complete &= role_read.complete && role_read.value.is_some();
    let role = role_read.value.unwrap_or_else(|| "AXUnknown".into());

    let in_web_content = in_web_content || is_web_content_role(&role);

    // Skip pure layout containers that have no interesting content.
    if role == "AXScrollArea" || role == "AXGroup" {
        // Still recurse — children may be interesting. Layout containers
        // collapse, so children inherit the parent's depth AND the same
        // parent_index (no actionable node was emitted here).
        let children = copy_children_with_status(element);
        *complete &= children.complete;
        for child in children.elements {
            walk_element(
                child,
                depth,
                parent_index,
                in_web_content,
                nodes,
                lines,
                counter,
                visited_count,
                truncated,
                complete,
                max_elements,
                max_depth,
            );
            CFRelease(child as CFTypeRef);
        }
        return;
    }

    // Keep AXTitle and AXDescription SEPARATE so that the tree format matches
    // the Swift reference: title → "title", description → (description).
    // This is critical for Calculator where AXTitle="" but AXDescription="2"
    // (digit buttons). Merging them would produce "2" (quoted) instead of (2)
    // (parens), breaking _find_calc_button which searches for "(2)".
    let title_read = copy_string_attr_with_status(element, "AXTitle");
    *complete &= title_read.complete;
    let title = title_read.value;
    // Read AXValue once with enough type information to preserve the existing
    // string-only markdown while also exposing numeric/boolean control state.
    let copied_value_read = copy_stringish_attr_with_status(element, "AXValue");
    *complete &= copied_value_read.complete;
    let copied_value = copied_value_read.value;
    let value = copied_value
        .as_ref()
        .and_then(|copied| copied.string_value.clone());
    // AXPlaceholderValue as fallback for empty text fields.
    let value = if value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        value
    } else {
        let placeholder = copy_string_attr_with_status(element, "AXPlaceholderValue");
        *complete &= placeholder.complete;
        placeholder.value
    };
    let description_read = copy_string_attr_with_status(element, "AXDescription");
    *complete &= description_read.complete;
    let description = description_read.value;
    let identifier_read = copy_string_attr_with_status(element, "AXIdentifier");
    *complete &= identifier_read.complete;
    let identifier = identifier_read.value;
    let help_read = copy_string_attr_with_status(element, "AXHelp");
    *complete &= help_read.complete;
    let help = help_read.value.filter(|h| !h.trim().is_empty());
    let actions_read = copy_action_names_with_status(element);
    *complete &= actions_read.complete;
    let actions = actions_read.actions;

    let visible_title = title.as_deref().unwrap_or("").trim().to_owned();
    let visible_description = description.as_deref().unwrap_or("").trim().to_owned();
    let visible_value = value.as_deref().unwrap_or("").trim().to_owned();

    let has_content =
        !visible_title.is_empty() || !visible_description.is_empty() || !visible_value.is_empty();
    // Some native controls expose no AX action names but do expose a writable
    // AXValue. Finder's transient inline-rename field is the important case:
    // rendering it without an element_index leaves an agent able to see the
    // field but unable to call set_value on it. Probe writability only for the
    // small family of value controls so arbitrary display nodes do not pay an
    // extra AX round trip.
    let value_settable = if actions.is_empty() && role_supports_value_addressing(&role) {
        let settable = is_attribute_settable_with_status(element, "AXValue");
        *complete &= settable.complete;
        settable.value.unwrap_or(false)
    } else {
        false
    };
    // A closed submenu can keep its descendants in AXChildren while reporting
    // those controls disabled. Never assign such a row a live element index:
    // the same native state also causes dispatch to refuse it, and exposing an
    // index for it invites agents to retain an unusable menu target.
    let enabled = if !actions.is_empty() || value_settable {
        let enabled = copy_bool_attr_with_status(element, "AXEnabled");
        *complete &= enabled.complete;
        enabled.value
    } else {
        None
    };
    let is_actionable = is_addressable(!actions.is_empty(), value_settable, enabled);

    if !is_actionable && !has_content && role != "AXWindow" && role != "AXSheet" {
        let children = copy_children_with_status(element);
        *complete &= children.complete;
        for child in children.elements {
            walk_element(
                child,
                depth + 1,
                parent_index,
                in_web_content,
                nodes,
                lines,
                counter,
                visited_count,
                truncated,
                complete,
                max_elements,
                max_depth,
            );
            CFRelease(child as CFTypeRef);
        }
        return;
    }

    let element_ptr = element as usize;
    let identity = Some(AXIdentity::retained(element));
    let frame_read = element_screen_rect_with_status(element);
    *complete &= frame_read.complete;
    let frame = frame_read.value;
    // Structured `elements` only contains actionable nodes. Keep all new AX
    // round-trips behind that same gate so display-only rows pay no cost.
    let control_state = read_control_state_if_actionable(is_actionable, || {
        let value_description = copy_string_attr_with_status(element, "AXValueDescription");
        *complete &= value_description.complete;
        let min_value = copy_number_attr_with_status(element, "AXMinValue");
        *complete &= min_value.complete;
        let max_value = copy_number_attr_with_status(element, "AXMaxValue");
        *complete &= max_value.complete;
        let selected = copy_bool_attr_with_status(element, "AXSelected");
        *complete &= selected.complete;
        ControlState {
            value_state: copied_value
                .map(|copied| copied.state_value)
                .filter(|v| !v.trim().is_empty())
                .or_else(|| value.clone())
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty()),
            value_description: value_description
                .value
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty()),
            min_value: min_value.value,
            max_value: max_value.value,
            enabled,
            selected: selected.value,
        }
    });
    let node = if is_actionable {
        let idx = *counter;
        *counter += 1;
        // Retain so the element stays alive in the cache after `copy_children`
        // releases the per-child ref at the end of the caller's loop.
        CFRetain(element as CFTypeRef);
        AXNode {
            element_index: Some(idx),
            role: role.clone(),
            title: if visible_title.is_empty() {
                None
            } else {
                Some(visible_title.clone())
            },
            value: if visible_value.is_empty() {
                None
            } else {
                Some(visible_value.clone())
            },
            description: if visible_description.is_empty() {
                None
            } else {
                Some(visible_description.clone())
            },
            identifier: identifier.clone(),
            help: help.clone(),
            actions: actions.clone(),
            element_ptr,
            identity,
            depth,
            parent_element_index: parent_index,
            frame,
            value_state: control_state.value_state.clone(),
            value_description: control_state.value_description.clone(),
            min_value: control_state.min_value,
            max_value: control_state.max_value,
            enabled: control_state.enabled,
            selected: control_state.selected,
            in_web_content,
        }
    } else {
        AXNode {
            element_index: None,
            role: role.clone(),
            title: if visible_title.is_empty() {
                None
            } else {
                Some(visible_title.clone())
            },
            value: if visible_value.is_empty() {
                None
            } else {
                Some(visible_value.clone())
            },
            description: if visible_description.is_empty() {
                None
            } else {
                Some(visible_description.clone())
            },
            identifier: identifier.clone(),
            help: help.clone(),
            actions: vec![],
            element_ptr,
            identity,
            depth,
            parent_element_index: parent_index,
            frame,
            value_state: control_state.value_state.clone(),
            value_description: control_state.value_description.clone(),
            min_value: control_state.min_value,
            max_value: control_state.max_value,
            enabled: control_state.enabled,
            selected: control_state.selected,
            in_web_content,
        }
    };

    // Track this node as the parent for its descendants only when it was
    // assigned an element_index (mirrors what the markdown shows: only
    // indexed rows are addressable in click(element_index=N)).
    let next_parent = node.element_index.or(parent_index);

    let line = format_node_line(&node);
    lines.push((depth, line));
    nodes.push(node);

    let children = copy_children_with_status(element);
    *complete &= children.complete;
    for child in children.elements {
        walk_element(
            child,
            depth + 1,
            next_parent,
            in_web_content,
            nodes,
            lines,
            counter,
            visited_count,
            truncated,
            complete,
            max_elements,
            max_depth,
        );
        CFRelease(child as CFTypeRef);
    }
}

fn is_web_content_role(role: &str) -> bool {
    let normalized = role
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.contains("webarea") || normalized.contains("documentweb") || normalized == "document"
}

#[cfg(test)]
mod web_content_role_tests {
    use super::is_web_content_role;

    #[test]
    fn recognizes_native_web_document_roles_without_marking_app_chrome() {
        for role in ["AXWebArea", "AXDocumentWeb", "document"] {
            assert!(is_web_content_role(role), "{role} must start web trust");
        }
        for role in ["AXWindow", "AXButton", "AXToolbar"] {
            assert!(!is_web_content_role(role), "{role} stays native");
        }
    }
}

fn format_node_line(node: &AXNode) -> String {
    format_node_line_with_index(node, node.element_index)
}

pub(crate) fn format_revision_body(node: &AXNode) -> String {
    let label = node
        .title
        .as_deref()
        .or(node.description.as_deref())
        .or(node.value.as_deref())
        .or(node.identifier.as_deref())
        .unwrap_or_default();
    let mut fields = vec![format!("<{}>", node.role), json_string(label)];
    if let Some(value) = node
        .value_state
        .as_deref()
        .or(node.value.as_deref())
        .filter(|value| !value.is_empty())
    {
        fields.push(format!("value={}", json_string(value)));
    }
    if let Some(description) = node.value_description.as_deref() {
        fields.push(format!("value_description={}", json_string(description)));
    }
    if let (Some(min), Some(max)) = (node.min_value, node.max_value) {
        if min.is_finite() && max.is_finite() && max > min {
            fields.push(format!("min={min}"));
            fields.push(format!("max={max}"));
        }
    }
    if let Some(enabled) = node.enabled {
        fields.push(format!("enabled={enabled}"));
    }
    let selected = node.selected.or_else(|| {
        let role = node.role.to_ascii_lowercase();
        if role.contains("checkbox") || role.contains("radiobutton") {
            node.value_state.as_deref().and_then(|value| match value {
                "1" | "true" | "on" => Some(true),
                "0" | "false" | "off" => Some(false),
                _ => None,
            })
        } else {
            None
        }
    });
    if let Some(selected) = selected {
        fields.push(format!("selected={selected}"));
    }
    if !node.actions.is_empty() {
        let actions = node
            .actions
            .iter()
            .map(|action| {
                let action = action
                    .strip_prefix("AX")
                    .unwrap_or(action)
                    .to_ascii_lowercase();
                if action == "showmenu" {
                    "show_menu".to_owned()
                } else {
                    action
                }
            })
            .collect::<Vec<_>>();
        fields.push(format!(
            "actions={}",
            serde_json::to_string(&actions).expect("string actions serialize")
        ));
    }
    if let Some([x, y, width, height]) = node.frame {
        if [x, y, width, height].into_iter().all(f64::is_finite) {
            fields.push(format!("frame={x},{y},{width},{height}"));
        }
    }
    if node.in_web_content {
        fields.push("in_web_content=true".to_owned());
    }
    fields.join(" ")
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serializes")
}

fn format_node_line_with_index(node: &AXNode, rendered_index: Option<usize>) -> String {
    let mut parts = String::new();

    // Common prefix (with or without index).
    if let Some(idx) = rendered_index {
        parts.push_str(&format!("- [{}] {}", idx, node.role));
    } else {
        parts.push_str(&format!("- {}", node.role));
    }

    // AXTitle → "title"
    if let Some(t) = &node.title {
        parts.push_str(&format!(" \"{}\"", t));
    }
    // AXValue → = "value"
    if let Some(v) = &node.value {
        parts.push_str(&format!(" = \"{}\"", v));
    }
    // AXDescription → (description) — critical for Calculator digit buttons
    // where AXTitle="" but AXDescription="2".
    if let Some(d) = &node.description {
        parts.push_str(&format!(" ({})", d));
    }

    // Bracketed metadata block (identifier, help, actions).
    if node.element_index.is_some() {
        let mut attrs: Vec<String> = Vec::new();
        if let Some(id) = &node.identifier {
            attrs.push(format!("id={}", id));
        }
        if let Some(h) = &node.help {
            attrs.push(format!("help=\"{}\"", h));
        }
        if !node.actions.is_empty() {
            let action_str = node
                .actions
                .iter()
                .map(|a| a.strip_prefix("AX").unwrap_or(a).to_lowercase())
                .collect::<Vec<_>>()
                .join(",");
            attrs.push(format!("actions=[{}]", action_str));
        }
        if !attrs.is_empty() {
            parts.push_str(" [");
            parts.push_str(&attrs.join(" "));
            parts.push(']');
        }
    }

    parts
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

/// Filter the tree markdown to lines matching `query` plus their ancestor chain.
fn filter_tree(markdown: &str, query: &str) -> String {
    let needle = query.to_lowercase();
    let lines: Vec<&str> = markdown.lines().collect();

    let mut current_ancestor: Vec<&str> = Vec::new();
    let mut last_emitted_at: Vec<Option<&str>> = Vec::new();
    let mut output: Vec<&str> = Vec::new();

    for line in &lines {
        let depth = leading_indent_depth(line);

        while current_ancestor.len() <= depth {
            current_ancestor.push("");
            last_emitted_at.push(None);
        }
        for emitted_at in last_emitted_at.iter_mut().skip(depth + 1) {
            *emitted_at = None;
        }
        current_ancestor[depth] = line;

        if line.to_lowercase().contains(&needle) {
            for ancestor_depth in 0..depth {
                let ancestor = current_ancestor[ancestor_depth];
                if ancestor.is_empty() {
                    continue;
                }
                if last_emitted_at[ancestor_depth] == Some(ancestor) {
                    continue;
                }
                last_emitted_at[ancestor_depth] = Some(ancestor);
                output.push(ancestor);
            }
            last_emitted_at[depth] = Some(line);
            output.push(line);
        }
    }

    if output.is_empty() {
        return String::new();
    }
    let mut result = output.join("\n");
    result.push('\n');
    result
}

fn leading_indent_depth(line: &str) -> usize {
    let mut count = 0;
    for ch in line.chars() {
        if ch == ' ' {
            count += 1;
        } else {
            break;
        }
    }
    count / 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn writable_value_controls_are_addressable_without_actions() {
        assert!(is_addressable(false, true, Some(true)));
        assert!(is_addressable(true, false, None));
        assert!(!is_addressable(false, false, Some(true)));
        assert!(!is_addressable(true, false, Some(false)));

        for role in [
            "AXTextField",
            "AXTextArea",
            "AXComboBox",
            "AXSlider",
            "AXStepper",
            "AXCheckBox",
            "AXRadioButton",
        ] {
            assert!(role_supports_value_addressing(role), "{role}");
        }
        for role in ["AXStaticText", "AXImage", "AXWindow", "AXGroup"] {
            assert!(!role_supports_value_addressing(role), "{role}");
        }
    }

    #[test]
    fn control_state_reads_are_gated_by_actionability() {
        let reads = Cell::new(0);
        let display_only = read_control_state_if_actionable(false, || {
            reads.set(reads.get() + 1);
            ControlState {
                enabled: Some(true),
                ..ControlState::default()
            }
        });
        assert_eq!(reads.get(), 0, "display-only nodes must not read state");
        assert_eq!(display_only.enabled, None);

        let actionable = read_control_state_if_actionable(true, || {
            reads.set(reads.get() + 1);
            ControlState {
                enabled: Some(true),
                ..ControlState::default()
            }
        });
        assert_eq!(reads.get(), 1, "actionable nodes must read state once");
        assert_eq!(actionable.enabled, Some(true));
    }

    #[test]
    fn revision_body_is_canonical_and_includes_model_visible_state() {
        let node = AXNode {
            element_index: Some(4),
            role: "AXButton".to_owned(),
            title: Some("Save \"draft\"\nnow".to_owned()),
            value: None,
            description: None,
            identifier: None,
            help: None,
            actions: vec!["AXPress".to_owned(), "AXShowMenu".to_owned()],
            element_ptr: 0,
            identity: None,
            depth: 1,
            parent_element_index: None,
            frame: Some([1.0, 2.0, 30.0, 40.0]),
            value_state: Some("pending".to_owned()),
            value_description: Some("Pending".to_owned()),
            min_value: None,
            max_value: None,
            enabled: Some(false),
            selected: Some(true),
            in_web_content: true,
        };

        assert_eq!(
            format_revision_body(&node),
            concat!(
                "<AXButton> \"Save \\\"draft\\\"\\nnow\" value=\"pending\" ",
                "value_description=\"Pending\" enabled=false selected=true ",
                "actions=[\"press\",\"show_menu\"] frame=1,2,30,40 ",
                "in_web_content=true",
            )
        );
    }
}
