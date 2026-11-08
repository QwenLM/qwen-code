//! Immutable UIA/MSAA snapshots owned by element-token bindings. The latest
//! target directory contains weak references, so invalidation releases native
//! pointers when the final in-flight action drops its bound snapshot.

use super::UiaNode;
use cua_driver_core::element_cache::ElementCacheCore;
use cua_driver_core::element_token::{ResolvedElement, SnapshotBinding};
use std::sync::{Arc, Weak};
use windows::core::Interface;
use windows::Win32::UI::Accessibility::{IAccessible, IUIAutomationElement};

/// An extra COM reference for an action that can outlive its snapshot view.
pub struct RetainedElement {
    ptr: usize,
    kind: SnapshotKind,
}

impl RetainedElement {
    /// The raw COM vtable pointer, valid for as long as this guard is held.
    pub fn as_ptr(&self) -> usize {
        self.ptr
    }

    /// True when the retained pointer is an `IUIAutomationElement` (the UIA
    /// path), not an MSAA `IAccessible`. `ScrollItemPattern::ScrollIntoView`
    /// only applies to UIA elements, so the scroll-into-view recovery gates on
    /// this before casting the pointer as a UIA interface.
    pub fn is_uia(&self) -> bool {
        matches!(self.kind, SnapshotKind::Uia)
    }
}

// `ptr` is a `usize` and `kind` is a plain `Copy` enum, so this is already
// `Send`; it's moved into / created inside `spawn_blocking` closures exactly
// like the bare `usize` it replaces. COM refcounting (`AddRef`/`Release`) is
// `InterlockedIncrement`-based and thread-safe, so the guard is safe to carry.

impl Drop for RetainedElement {
    fn drop(&mut self) {
        if self.ptr == 0 {
            return;
        }
        // Balance the AddRef taken in `get_element_retained`, releasing via the
        // same kind-appropriate vtable that `CachedSnapshot::drop` uses.
        unsafe {
            match self.kind {
                SnapshotKind::Uia => {
                    let iface: IUIAutomationElement =
                        IUIAutomationElement::from_raw(self.ptr as *mut _);
                    drop(iface);
                }
                SnapshotKind::Msaa => {
                    let iface: IAccessible = IAccessible::from_raw(self.ptr as *mut _);
                    drop(iface);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub pid: u32,
    pub hwnd: u64,
}

/// Which COM interface the cached pointers reference. Determines the
/// `from_raw` cast `Drop` performs and the dispatch path the click tool
/// takes when an element is invoked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotKind {
    /// `element_ptr` values are `IUIAutomationElement` pointers; click
    /// tool tries Invoke/Toggle/SelectionItem/ExpandCollapse patterns.
    Uia,
    /// `element_ptr` values are `IAccessible` pointers (MSAA fallback for
    /// SAL/VCL classes); click tool dispatches via `accDoDefaultAction`
    /// for invoke, right-edge SendInput for expand.
    Msaa,
}

pub struct CachedSnapshot {
    pub kind: SnapshotKind,
    /// element_index → raw COM pointer (retained).
    pub elements: Vec<usize>,
    /// element_index → screen-coordinate center (captured at walk time).
    pub centers: Vec<(i32, i32)>,
    /// element_index → screen-coordinate rect (l, t, r, b). `None` when
    /// the element didn't report a meaningful bounding box.
    pub rects: Vec<Option<(i32, i32, i32, i32)>>,
    /// element_index → MSAA role code (`Some` for MSAA-walked entries,
    /// `None` for UIA-walked entries). The click tool reads this to gate
    /// right-edge dispatch on `ROLE_SYSTEM_BUTTONDROPDOWN` etc.
    pub msaa_roles: Vec<Option<i32>>,
    /// element_index → semantic actions advertised by the captured provider.
    pub actions: Vec<Vec<String>>,
}

impl Drop for CachedSnapshot {
    fn drop(&mut self) {
        for ptr in &self.elements {
            if *ptr == 0 {
                continue;
            }
            unsafe {
                match self.kind {
                    SnapshotKind::Uia => {
                        let iface: IUIAutomationElement =
                            IUIAutomationElement::from_raw(*ptr as *mut _);
                        drop(iface);
                    }
                    SnapshotKind::Msaa => {
                        let iface: IAccessible = IAccessible::from_raw(*ptr as *mut _);
                        drop(iface);
                    }
                }
            }
        }
    }
}

pub struct ElementCache {
    core: ElementCacheCore<CacheKey, Weak<CachedSnapshot>>,
}

impl ElementCache {
    pub fn new() -> Self {
        Self {
            core: ElementCacheCore::new(),
        }
    }

    /// Update the snapshot for (pid, hwnd) with the actionable elements
    /// from a UIA walk. Mirrors `update_msaa` for the MSAA path.
    pub fn update(&self, pid: u32, hwnd: u64, nodes: &[UiaNode]) -> u32 {
        self.update_for_session(pid, hwnd, nodes, SnapshotKind::Uia, None)
    }

    /// Same as `update` but tags the snapshot as MSAA so Drop releases the
    /// pointers as `IAccessible` and the click tool routes through the
    /// MSAA dispatch path.
    pub fn update_msaa(&self, pid: u32, hwnd: u64, nodes: &[UiaNode]) -> u32 {
        self.update_for_session(pid, hwnd, nodes, SnapshotKind::Msaa, None)
    }

    pub fn update_for_session(
        &self,
        pid: u32,
        hwnd: u64,
        nodes: &[UiaNode],
        kind: SnapshotKind,
        session: Option<&str>,
    ) -> u32 {
        let actionable: Vec<&UiaNode> =
            nodes.iter().filter(|n| n.element_index.is_some()).collect();
        let elements: Vec<usize> = actionable.iter().map(|n| n.element_ptr).collect();
        let centers: Vec<(i32, i32)> = actionable
            .iter()
            .map(|n| (n.center_x, n.center_y))
            .collect();
        let rects: Vec<Option<(i32, i32, i32, i32)>> = actionable.iter().map(|n| n.rect).collect();
        let msaa_roles: Vec<Option<i32>> = actionable.iter().map(|n| n.msaa_role).collect();
        let actions = actionable.iter().map(|node| node.actions.clone()).collect();
        let snapshot = Arc::new(CachedSnapshot {
            kind,
            elements,
            centers,
            rects,
            msaa_roles,
            actions,
        });
        self.publish_for_session(pid, hwnd, snapshot, session)
    }

    #[cfg(test)]
    fn publish(&self, pid: u32, hwnd: u64, snapshot: Arc<CachedSnapshot>) -> u32 {
        self.publish_for_session(pid, hwnd, snapshot, None)
    }

    fn publish_for_session(
        &self,
        pid: u32,
        hwnd: u64,
        snapshot: Arc<CachedSnapshot>,
        session: Option<&str>,
    ) -> u32 {
        let id = cua_driver_core::element_token::global().register_snapshot_payload_for_session(
            pid as i32,
            hwnd as u32,
            0..snapshot.elements.len(),
            snapshot.clone(),
            session,
        );
        self.core
            .insert(CacheKey { pid, hwnd }, Arc::downgrade(&snapshot));
        id
    }

    pub fn clear_target(&self, pid: u32, hwnd: u64) {
        cua_driver_core::element_token::global().clear_current_target(pid as i32, hwnd as u32);
        self.core.remove(&CacheKey { pid, hwnd });
    }

    pub fn element_count(&self, pid: u32, hwnd: u64) -> usize {
        self.core
            .with_snapshot(&CacheKey { pid, hwnd }, |s| {
                s.upgrade().map_or(0, |s| s.elements.len())
            })
            .unwrap_or(0)
    }
}

#[derive(Clone)]
pub struct BoundElementCache {
    binding: Option<SnapshotBinding>,
}

impl BoundElementCache {
    pub fn from_resolved(resolved: &ResolvedElement) -> Self {
        Self {
            binding: resolved.binding(),
        }
    }

    pub fn from_binding(binding: SnapshotBinding) -> Self {
        Self {
            binding: Some(binding),
        }
    }

    fn with_snapshot<R>(
        &self,
        key: &CacheKey,
        read: impl FnOnce(&CachedSnapshot) -> R,
    ) -> Option<R> {
        self.binding
            .as_ref()?
            .with_payload(key.pid as i32, key.hwnd as u32, read)
    }

    /// Retain from the bound snapshot, including its original interface kind.
    pub fn get_element_retained(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<RetainedElement> {
        self.with_snapshot(&CacheKey { pid, hwnd }, |s| {
            let ptr = s.elements.get(element_index).copied()?;
            if ptr != 0 {
                // The immutable binding owns the original COM reference.
                unsafe {
                    match s.kind {
                        SnapshotKind::Uia => {
                            let iface: IUIAutomationElement =
                                IUIAutomationElement::from_raw(ptr as *mut _);
                            let dup = iface.clone(); // AddRef → +1
                            std::mem::forget(iface); // don't Release cache's ref
                            std::mem::forget(dup); // guard owns the +1
                        }
                        SnapshotKind::Msaa => {
                            let iface: IAccessible = IAccessible::from_raw(ptr as *mut _);
                            let dup = iface.clone();
                            std::mem::forget(iface);
                            std::mem::forget(dup);
                        }
                    }
                }
            }
            Some(RetainedElement { ptr, kind: s.kind })
        })
        .flatten()
    }

    pub fn get_element_center(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<(i32, i32)> {
        self.with_snapshot(&CacheKey { pid, hwnd }, |s| {
            s.centers.get(element_index).copied()
        })
        .flatten()
    }

    /// Focus a cached UIA element without activating its top-level window.
    /// The caller owns the no-activation guard for background delivery.
    pub fn focus_element(&self, pid: u32, hwnd: u64, element_index: usize) -> anyhow::Result<()> {
        let retained = self
            .get_element_retained(pid, hwnd, element_index)
            .ok_or_else(|| anyhow::anyhow!("element [{element_index}] is not in the UIA cache"))?;
        if !retained.is_uia() {
            anyhow::bail!("element [{element_index}] is an MSAA element, not a UIA element");
        }
        let ptr = retained.as_ptr();
        let element: IUIAutomationElement =
            unsafe { IUIAutomationElement::from_raw(ptr as *mut _) };
        let result = unsafe { element.SetFocus() };
        // `retained` owns the AddRef; `from_raw` borrows that same pointer.
        std::mem::forget(element);
        result.map_err(|e| anyhow::anyhow!("UIA SetFocus failed: {e}"))
    }

    pub fn element_has_keyboard_focus(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<bool> {
        let retained = self.get_element_retained(pid, hwnd, element_index)?;
        if !retained.is_uia() {
            return None;
        }
        let element: IUIAutomationElement =
            unsafe { IUIAutomationElement::from_raw(retained.as_ptr() as *mut _) };
        let focused = unsafe { element.CurrentHasKeyboardFocus() }
            .ok()
            .map(|value| value.as_bool());
        std::mem::forget(element);
        focused
    }

    /// Cached screen rect for the element. Used by the click tool to
    /// compute the right-edge dispatch point for `action:"expand"` on
    /// MSAA BUTTONDROPDOWN.
    pub fn get_element_rect(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<(i32, i32, i32, i32)> {
        self.with_snapshot(&CacheKey { pid, hwnd }, |s| {
            s.rects.get(element_index).copied().flatten()
        })
        .flatten()
    }

    /// Kind + MSAA role for the element. `(Msaa, Some(0x38))` identifies a
    /// MSAA BUTTONDROPDOWN; click tool routes `action:"expand"` to
    /// right-edge SendInput for these.
    pub fn get_element_kind_and_role(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<(SnapshotKind, Option<i32>)> {
        self.with_snapshot(&CacheKey { pid, hwnd }, |s| {
            let role = s.msaa_roles.get(element_index).copied().flatten();
            Some((s.kind, role))
        })
        .flatten()
    }

    pub fn get_element_actions(
        &self,
        pid: u32,
        hwnd: u64,
        element_index: usize,
    ) -> Option<Vec<String>> {
        self.with_snapshot(&CacheKey { pid, hwnd }, |snapshot| {
            snapshot.actions.get(element_index).cloned()
        })
        .flatten()
    }
}

impl Default for ElementCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "cache_uaf_repro.rs"]
mod cache_uaf_repro;
