//! Native AX snapshots owned by element-token bindings. The per-target directory
//! holds weak references; only current tokens and resolved actions keep payloads
//! alive. Walked pointers transfer their extra CFRetain into CachedSnapshot.

use super::bindings::AXUIElementRef;
use super::tree::AXNode;
use core_foundation::base::{CFRelease, CFRetain, CFTypeRef};
use cua_driver_core::element_cache::ElementCacheCore;
use cua_driver_core::element_token::{ResolvedElement, SnapshotBinding};
use std::sync::{Arc, Weak};

/// An extra retain for an action that can outlive its resolved snapshot view.
pub struct RetainedElement(usize);

impl RetainedElement {
    /// The raw pointer, valid for as long as this guard is held.
    pub fn as_ptr(&self) -> usize {
        self.0
    }
}

// The raw AXUIElementRef is already shuttled across threads as a `usize` into
// `spawn_blocking`; wrapping it in a retain guard doesn't change that, and CF
// reference counting is thread-safe, so the guard is safe to Send.
unsafe impl Send for RetainedElement {}

impl Drop for RetainedElement {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { CFRelease(self.0 as AXUIElementRef as CFTypeRef) };
        }
    }
}

/// Key for the element cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub pid: i32,
    pub window_id: u32,
}

/// Cached snapshot for one (pid, window_id) pair.
pub struct CachedSnapshot {
    /// element_index → raw AXUIElementRef pointer (retained, as usize for Send).
    pub elements: Vec<usize>,
}

impl Drop for CachedSnapshot {
    fn drop(&mut self) {
        // Release the extra CFRetain that walk_element added for each cached ptr.
        for ptr in &self.elements {
            if *ptr != 0 {
                unsafe { CFRelease(*ptr as AXUIElementRef as CFTypeRef) };
            }
        }
    }
}

/// Global element cache.
pub struct ElementCache {
    core: ElementCacheCore<CacheKey, Weak<CachedSnapshot>>,
}

impl ElementCache {
    pub fn new() -> Self {
        Self {
            core: ElementCacheCore::new(),
        }
    }

    /// Replace the snapshot for (pid, window_id) with the nodes from a fresh walk.
    pub fn update(&self, pid: i32, window_id: u32, nodes: &[AXNode]) -> u32 {
        self.publish(pid, window_id, Self::prepare(nodes))
    }

    pub fn prepare(nodes: &[AXNode]) -> Arc<CachedSnapshot> {
        let elements: Vec<usize> = nodes
            .iter()
            .filter(|n| n.element_index.is_some())
            .map(|n| n.element_ptr)
            .collect();
        Arc::new(CachedSnapshot { elements })
    }

    pub fn publish(&self, pid: i32, window_id: u32, snapshot: Arc<CachedSnapshot>) -> u32 {
        self.publish_for_session(pid, window_id, snapshot, None)
    }

    pub fn publish_for_session(
        &self,
        pid: i32,
        window_id: u32,
        snapshot: Arc<CachedSnapshot>,
        session: Option<&str>,
    ) -> u32 {
        let id = cua_driver_core::element_token::global().register_snapshot_payload_for_session(
            pid,
            window_id,
            0..snapshot.elements.len(),
            snapshot.clone(),
            session,
        );
        self.core
            .insert(CacheKey { pid, window_id }, Arc::downgrade(&snapshot));
        id
    }

    /// Number of indexed elements for (pid, window_id), or 0 if not cached.
    pub fn element_count(&self, pid: i32, window_id: u32) -> usize {
        self.core
            .with_snapshot(&CacheKey { pid, window_id }, |s| {
                s.upgrade().map_or(0, |s| s.elements.len())
            })
            .unwrap_or(0)
    }

    pub fn clear_target(&self, pid: i32, window_id: u32) {
        cua_driver_core::element_token::global().clear_current_target(pid, window_id);
        self.core.remove(&CacheKey { pid, window_id });
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
            .with_payload(key.pid as i32, key.window_id as u32, read)
    }

    /// Retain from this immutable snapshot, never from a newer window snapshot.
    pub fn get_element_retained(
        &self,
        pid: i32,
        window_id: u32,
        element_index: usize,
    ) -> Option<RetainedElement> {
        self.with_snapshot(&CacheKey { pid, window_id }, |s| {
            let ptr = s.elements.get(element_index).copied()?;
            if ptr != 0 {
                // The binding owns the snapshot throughout this retain.
                unsafe { CFRetain(ptr as AXUIElementRef as CFTypeRef) };
            }
            Some(RetainedElement(ptr))
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
mod tests {
    use super::*;
    use core_foundation::base::{CFGetRetainCount, CFRetain, TCFType};
    use core_foundation::string::CFString;

    // An AXNode carrying a raw CFTypeRef pointer as if it were an element.
    // A long, dynamic string is heap-allocated (not a tagged-pointer CFString),
    // so CFGetRetainCount is reliable.
    fn node_with_ptr(ptr: usize) -> AXNode {
        AXNode {
            element_index: Some(0),
            role: String::new(),
            title: None,
            value: None,
            description: None,
            identifier: None,
            rich_text: None,
            url: None,
            title_ui_element: None,
            selectable: false,
            table_row: false,
            help: None,
            actions: Vec::new(),
            element_ptr: ptr,
            identity: None,
            depth: 0,
            parent_element_index: None,
            frame: None,
            value_state: None,
            value_description: None,
            min_value: None,
            max_value: None,
            enabled: None,
            selected: None,
            in_web_content: false,
            focused: None,
            focusable_or_selectable: false,
        }
    }

    /// The crash this guards against: while a click holds an element pointer,
    /// a concurrent `get_window_state` replaces the snapshot and its `Drop`
    /// `CFRelease`s the element to zero — freeing it under the in-flight click
    /// (use-after-free → `EXC_BREAKPOINT` in `AXUIElementCopyActionNames`).
    /// `get_element_retained` takes an extra retain from the bound snapshot so
    /// the element outlives both snapshot replacement and the binding itself.
    #[test]
    fn retained_element_survives_concurrent_snapshot_replace() {
        let s = CFString::new("cua-driver-uaf-test-element-placeholder");
        let ptr = s.as_concrete_TypeRef() as usize;
        let base = unsafe { CFGetRetainCount(ptr as CFTypeRef) };

        // walk_element's contract: the producer retains before handing the ptr
        // to the cache, and CachedSnapshot::drop releases that retain.
        unsafe { CFRetain(ptr as CFTypeRef) };
        let cache = ElementCache::new();
        let sid = cache.update(721_500, 2, &[node_with_ptr(ptr)]);
        assert_eq!(
            unsafe { CFGetRetainCount(ptr as CFTypeRef) },
            base + 1,
            "cache owns one retain"
        );

        // Borrow the element out for an action.
        let (_, _, binding) = cua_driver_core::element_token::global()
            .resolve_bound(721_500, &cua_driver_core::element_token::token_for(sid, 0))
            .unwrap();
        let bound = BoundElementCache::from_binding(binding.unwrap());
        let guard = bound
            .get_element_retained(721_500, 2, 0)
            .expect("element is cached");
        assert_eq!(
            unsafe { CFGetRetainCount(ptr as CFTypeRef) },
            base + 2,
            "guard adds a retain"
        );

        // Concurrent get_window_state replaces the snapshot → old one dropped →
        // CFRelease of the cache's retain. The guard's retain must remain.
        drop(bound);
        cache.update(721_500, 2, &[]);
        assert_eq!(
            unsafe { CFGetRetainCount(ptr as CFTypeRef) },
            base + 1,
            "after the replace, only the guard's retain remains — the element is still ALIVE \
             (pre-fix this would drop to `base` and a real AX element with no other owner would be freed)"
        );

        drop(guard);
        assert_eq!(
            unsafe { CFGetRetainCount(ptr as CFTypeRef) },
            base,
            "guard drop releases its retain"
        );
    }

    #[test]
    fn prepared_and_resolved_snapshots_keep_their_native_identity() {
        let first = CFString::new("first-native-snapshot-object-with-a-heap-allocation");
        let second = CFString::new("second-native-snapshot-object-with-a-heap-allocation");
        let a = first.as_concrete_TypeRef() as usize;
        let b = second.as_concrete_TypeRef() as usize;
        let baseline = unsafe { CFGetRetainCount(a as CFTypeRef) };
        let pid = 721_501;
        let window = 721_502;
        unsafe {
            CFRetain(a as CFTypeRef);
            CFRetain(b as CFTypeRef);
        }
        let pending = ElementCache::prepare(&[node_with_ptr(a)]);
        let cache = ElementCache::new();
        let sid_b = cache.update(pid, window, &[node_with_ptr(b)]);
        let sid_a = cache.publish(pid, window, pending);
        let registry = cua_driver_core::element_token::global();
        assert!(registry
            .resolve(pid, &cua_driver_core::element_token::token_for(sid_b, 0))
            .is_err());
        let (_, _, binding) = registry
            .resolve_bound(pid, &cua_driver_core::element_token::token_for(sid_a, 0))
            .unwrap();
        let bound = BoundElementCache::from_binding(binding.unwrap());
        cache.update(pid, window, &[]);
        let element = bound.get_element_retained(pid, window, 0).unwrap();
        assert_eq!(element.as_ptr(), a);
        assert!(bound.get_element_retained(pid, window + 1, 0).is_none());
        registry.clear_target(pid, window);
        drop(element);
        assert_eq!(unsafe { CFGetRetainCount(a as CFTypeRef) }, baseline + 1);
        drop(bound);
        assert_eq!(unsafe { CFGetRetainCount(a as CFTypeRef) }, baseline);

        unsafe {
            CFRetain(a as CFTypeRef);
        }
        let cancelled = ElementCache::prepare(&[node_with_ptr(a)]);
        drop(cancelled);
        assert_eq!(unsafe { CFGetRetainCount(a as CFTypeRef) }, baseline);
    }

    #[test]
    fn clearing_unresolved_target_revokes_token_and_releases_native_payload() {
        let value = CFString::new("unresolved-window-owned-native-object-heap-allocation");
        let ptr = value.as_concrete_TypeRef() as usize;
        let baseline = unsafe { CFGetRetainCount(ptr as CFTypeRef) };
        let pid = 721_504;
        let cache = ElementCache::new();
        unsafe { CFRetain(ptr as CFTypeRef) };
        let sid = cache.update(pid, 7, &[node_with_ptr(ptr)]);
        let registry = cua_driver_core::element_token::global();
        let token = cua_driver_core::element_token::token_for(sid, 0);
        assert!(registry.resolve(pid, &token).is_ok());
        cache.clear_target(pid, 7);
        assert!(registry.resolve(pid, &token).is_err());
        assert_eq!(cache.element_count(pid, 7), 0);
        assert_eq!(unsafe { CFGetRetainCount(ptr as CFTypeRef) }, baseline);
    }

    #[test]
    fn missing_index_returns_none() {
        let cache = ElementCache::new();
        let bound = BoundElementCache::from_resolved(&ResolvedElement::None);
        assert!(bound.get_element_retained(721_503, 2, 0).is_none());
        cache.update(721_503, 2, &[]);
        assert!(bound.get_element_retained(721_503, 2, 5).is_none());
    }
}
