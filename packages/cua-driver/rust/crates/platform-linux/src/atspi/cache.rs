//! AT-SPI element cache for Linux.
//! Stores element keys (u64 hash) indexed by (pid, xid) → element_index.
//!
//! The locked-HashMap plumbing lives in `cua_driver_core::element_cache` — see
//! `docs/dedup-audit.md` item #3. This module owns the Linux-specific
//! `CacheKey` and `CachedSnapshot` (no Drop needed — the map frees
//! itself).

use super::{AtspiIdentity, AtspiNode};
use cua_driver_core::element_cache::ElementCacheCore;
use std::collections::HashMap;

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
    pub element_key: u64,
    pub identity: Option<AtspiIdentity>,
    pub actions: Vec<String>,
}

pub struct ElementCache {
    core: ElementCacheCore<CacheKey, CachedSnapshot>,
}

impl ElementCache {
    pub fn new() -> Self {
        Self {
            core: ElementCacheCore::new(),
        }
    }

    pub fn update(&self, pid: u32, xid: u64, nodes: &[AtspiNode]) {
        let elements = nodes
            .iter()
            .filter_map(|node| {
                Some((
                    node.element_index?,
                    CachedElement {
                        element_key: node.element_key,
                        identity: node.identity.clone(),
                        actions: node.actions.clone(),
                    },
                ))
            })
            .collect();
        self.core
            .insert(CacheKey { pid, xid }, CachedSnapshot { elements });
    }

    pub fn get_element_key(&self, pid: u32, xid: u64, idx: usize) -> Option<u64> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |s| {
                s.elements.get(&idx).map(|element| element.element_key)
            })
            .flatten()
    }

    pub fn get_element_identity(&self, pid: u32, xid: u64, idx: usize) -> Option<AtspiIdentity> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |snapshot| {
                snapshot
                    .elements
                    .get(&idx)
                    .and_then(|element| element.identity.clone())
            })
            .flatten()
    }

    pub fn get_element_actions(&self, pid: u32, xid: u64, idx: usize) -> Option<Vec<String>> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |snapshot| {
                snapshot
                    .elements
                    .get(&idx)
                    .map(|element| element.actions.clone())
            })
            .flatten()
    }

    pub fn element_count(&self, pid: u32, xid: u64) -> usize {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |s| s.elements.len())
            .unwrap_or(0)
    }

    pub fn clear_target(&self, pid: u32, xid: u64) {
        self.core.remove(&CacheKey { pid, xid });
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
            description: None,
            depth: 0,
            parent_element_index: None,
            in_web_content: false,
        }
    }

    #[test]
    fn lookups_preserve_sparse_application_indices_and_window_isolation() {
        let cache = ElementCache::new();
        cache.update(42, 7, &[node(130), node(132), node(637)]);
        cache.update(42, 8, &[node(1), node(2), node(3)]);
        assert_eq!(cache.element_count(42, 7), 3);
        for index in [130, 132, 637] {
            assert_eq!(
                cache.get_element_key(42, 7, index),
                Some(1000 + index as u64)
            );
            assert_eq!(
                cache.get_element_identity(42, 7, index),
                node(index).identity
            );
            assert_eq!(
                cache.get_element_actions(42, 7, index),
                Some(node(index).actions)
            );
        }
        for gap in [0, 1, 131, 638] {
            assert_eq!(cache.get_element_key(42, 7, gap), None);
            assert_eq!(cache.get_element_identity(42, 7, gap), None);
            assert_eq!(cache.get_element_actions(42, 7, gap), None);
        }
        cache.update(42, 7, &[node(130)]);
        assert_eq!(cache.get_element_key(42, 7, 637), None);
        assert_eq!(cache.get_element_key(42, 8, 3), Some(1003));
        cache.clear_target(42, 7);
        assert_eq!(cache.get_element_key(42, 7, 130), None);
        assert_eq!(cache.get_element_key(42, 8, 3), Some(1003));
    }
}
