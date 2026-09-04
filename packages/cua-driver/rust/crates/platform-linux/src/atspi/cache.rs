//! AT-SPI element cache for Linux.
//! Stores element keys (u64 hash) indexed by (pid, xid) → element_index.
//!
//! The locked-HashMap plumbing lives in `cua_driver_core::element_cache` — see
//! `docs/dedup-audit.md` item #3. This module owns the Linux-specific
//! `CacheKey` and `CachedSnapshot` (no Drop needed — `Vec<u64>` frees
//! itself).

use super::{AtspiIdentity, AtspiNode};
use cua_driver_core::element_cache::ElementCacheCore;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub pid: u32,
    pub xid: u64,
}

pub struct CachedSnapshot {
    pub elements: Vec<CachedElement>,
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
            .filter(|n| n.element_index.is_some())
            .map(|node| CachedElement {
                element_key: node.element_key,
                identity: node.identity.clone(),
                actions: node.actions.clone(),
            })
            .collect();
        self.core
            .insert(CacheKey { pid, xid }, CachedSnapshot { elements });
    }

    pub fn get_element_key(&self, pid: u32, xid: u64, idx: usize) -> Option<u64> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |s| {
                s.elements.get(idx).map(|element| element.element_key)
            })
            .flatten()
    }

    pub fn get_element_identity(&self, pid: u32, xid: u64, idx: usize) -> Option<AtspiIdentity> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |snapshot| {
                snapshot
                    .elements
                    .get(idx)
                    .and_then(|element| element.identity.clone())
            })
            .flatten()
    }

    pub fn get_element_actions(&self, pid: u32, xid: u64, idx: usize) -> Option<Vec<String>> {
        self.core
            .with_snapshot(&CacheKey { pid, xid }, |snapshot| {
                snapshot
                    .elements
                    .get(idx)
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
