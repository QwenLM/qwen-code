//! AT-SPI element cache for Linux.
//! Stores element keys (u64 hash) indexed by (pid, xid) → element_index.
//!
//! The locked-HashMap plumbing lives in `cua_driver_core::element_cache` — see
//! `docs/dedup-audit.md` item #3. This module owns the Linux-specific
//! `CacheKey` and `CachedSnapshot` (no Drop needed — the map frees
//! itself).

use super::{AtspiIdentity, AtspiNode};
use cua_driver_core::element_cache::ElementCacheCore;
use cua_driver_core::element_token::{ResolvedElement, SnapshotBinding};
use std::collections::HashMap;
use std::sync::{Arc, Weak};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub pid: u32,
    pub xid: u64,
}

pub struct CachedSnapshot {
    pub elements: HashMap<usize, CachedElement>,
}

#[derive(Clone)]
pub struct CachedElement {
    pub role: String,
    pub element_key: u64,
    pub identity: Option<AtspiIdentity>,
    pub actions: Vec<String>,
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

    pub fn update(&self, pid: u32, xid: u64, nodes: &[AtspiNode]) -> u32 {
        self.update_for_session(pid, xid, nodes, None)
    }

    pub fn update_for_session(
        &self,
        pid: u32,
        xid: u64,
        nodes: &[AtspiNode],
        session: Option<&str>,
    ) -> u32 {
        let elements = nodes
            .iter()
            .filter_map(|node| {
                Some((
                    node.element_index?,
                    CachedElement {
                        role: node.role.clone(),
                        element_key: node.element_key,
                        identity: node.identity.clone(),
                        actions: node.actions.clone(),
                    },
                ))
            })
            .collect();
        let snapshot = Arc::new(CachedSnapshot { elements });
        let id = cua_driver_core::element_token::global().register_snapshot_payload_for_session(
            pid as i32,
            xid as u32,
            snapshot.elements.keys().copied(),
            snapshot.clone(),
            session,
        );
        self.core
            .insert(CacheKey { pid, xid }, Arc::downgrade(&snapshot));
        id
    }

    pub fn has_snapshot(&self, pid: u32, xid: u64) -> bool {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |snapshot| {
                snapshot.strong_count() > 0
            })
            .unwrap_or(false)
    }

    pub fn element_count(&self, pid: u32, xid: u64) -> usize {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |s| {
                s.upgrade().map_or(0, |s| s.elements.len())
            })
            .unwrap_or(0)
    }

    pub fn clear_target(&self, pid: u32, xid: u64) {
        cua_driver_core::element_token::global().clear_current_target(pid as i32, xid as u32);
        self.core.remove(&CacheKey { pid, xid });
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
            .with_payload(key.pid as i32, key.xid as u32, read)
    }

    pub fn get_element_key(&self, pid: u32, xid: u64, idx: usize) -> Option<u64> {
        self.with_snapshot(&CacheKey { pid, xid }, |s| {
            s.elements.get(&idx).map(|element| element.element_key)
        })
        .flatten()
    }

    pub fn get_element_identity(&self, pid: u32, xid: u64, idx: usize) -> Option<AtspiIdentity> {
        self.with_snapshot(&CacheKey { pid, xid }, |snapshot| {
            snapshot
                .elements
                .get(&idx)
                .and_then(|element| element.identity.clone())
        })
        .flatten()
    }

    pub fn get_element_role(&self, pid: u32, xid: u64, idx: usize) -> Option<String> {
        self.with_snapshot(&CacheKey { pid, xid }, |snapshot| {
            snapshot
                .elements
                .get(&idx)
                .map(|element| element.role.clone())
        })
        .flatten()
    }

    pub fn get_element_actions(&self, pid: u32, xid: u64, idx: usize) -> Option<Vec<String>> {
        self.with_snapshot(&CacheKey { pid, xid }, |snapshot| {
            snapshot
                .elements
                .get(&idx)
                .map(|element| element.actions.clone())
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

    fn node(index: usize) -> AtspiNode {
        AtspiNode {
            element_index: Some(index),
            element_key: 1000 + index as u64,
            identity: Some(AtspiIdentity {
                unique_owner: ":1.5".into(),
                object_path: format!("/node/{index}"),
            }),
            actions: vec![format!("action-{index}")],
            role: "button".into(),
            name: None,
            value: None,
            checked: None,
            enabled: Some(true),
            selected: None,
            focused: None,
            description: None,
            depth: 0,
            parent_element_index: None,
            in_web_content: false,
        }
    }

    fn bind(pid: i32, id: u32, index: usize) -> BoundElementCache {
        let (_, _, binding) = cua_driver_core::element_token::global()
            .resolve_bound(pid, &cua_driver_core::element_token::token_for(id, index))
            .unwrap();
        BoundElementCache::from_binding(binding.unwrap())
    }

    #[test]
    fn lookups_preserve_sparse_application_indices_and_window_isolation() {
        let cache = ElementCache::new();
        let first = cache.update(721_511, 7, &[node(130), node(132), node(637)]);
        let first = bind(721_511, first, 130);
        let sibling = cache.update(721_511, 8, &[node(1), node(2), node(3)]);
        let sibling = bind(721_511, sibling, 1);
        assert_eq!(cache.element_count(721_511, 7), 3);
        for index in [130, 132, 637] {
            assert_eq!(
                first.get_element_key(721_511, 7, index),
                Some(1000 + index as u64)
            );
            assert_eq!(
                first.get_element_identity(721_511, 7, index),
                node(index).identity
            );
            assert_eq!(
                first.get_element_actions(721_511, 7, index),
                Some(node(index).actions)
            );
        }
        for gap in [0, 1, 131, 638] {
            assert_eq!(first.get_element_key(721_511, 7, gap), None);
            assert_eq!(first.get_element_identity(721_511, 7, gap), None);
        }
        assert_eq!(first.get_element_key(721_511, 8, 130), None);
        assert_eq!(sibling.get_element_key(721_511, 8, 3), Some(1003));
        cua_driver_core::element_token::global().clear_pid(721_511);
    }

    #[test]
    fn target_clear_revokes_token_without_discarding_a_resolved_identity() {
        let cache = ElementCache::new();
        let pid = 721_513;
        let first = cache.update(pid, 7, &[node(130)]);
        let bound = bind(pid as i32, first, 130);
        let sibling = cache.update(pid, 8, &[node(1)]);
        cache.clear_target(pid, 7);
        let registry = cua_driver_core::element_token::global();
        assert!(registry
            .resolve(
                pid as i32,
                &cua_driver_core::element_token::token_for(first, 130)
            )
            .is_err());
        assert!(registry
            .resolve(
                pid as i32,
                &cua_driver_core::element_token::token_for(sibling, 1)
            )
            .is_ok());
        assert_eq!(bound.get_element_key(pid, 7, 130), Some(1130));
        assert_eq!(cache.element_count(pid, 7), 0);
        registry.clear_pid(pid as i32);
    }

    #[test]
    fn replacement_cannot_mix_native_identity_role_and_actions() {
        let cache = ElementCache::new();
        let first = cache.update(721_512, 7, &[node(130)]);
        let bound = bind(721_512, first, 130);
        let mut replacement = node(130);
        replacement.element_key = 9999;
        replacement.identity.as_mut().unwrap().unique_owner = ":1.99".into();
        replacement.actions = vec!["replacement-action".into()];
        replacement.role = "entry".into();
        let second = cache.update(721_512, 7, &[replacement]);
        assert!(cua_driver_core::element_token::global()
            .resolve(
                721_512,
                &cua_driver_core::element_token::token_for(first, 130)
            )
            .is_err());
        assert_eq!(bound.get_element_key(721_512, 7, 130), Some(1130));
        assert_eq!(
            bound.get_element_identity(721_512, 7, 130),
            node(130).identity
        );
        assert_eq!(
            bound.get_element_role(721_512, 7, 130),
            Some("button".into())
        );
        assert_eq!(
            bound.get_element_actions(721_512, 7, 130),
            Some(node(130).actions)
        );
        assert_eq!(
            bind(721_512, second, 130).get_element_key(721_512, 7, 130),
            Some(9999)
        );
        cua_driver_core::element_token::global().clear_pid(721_512);
        drop(bound);
        assert!(!cache.has_snapshot(721_512, 7));
    }
}
