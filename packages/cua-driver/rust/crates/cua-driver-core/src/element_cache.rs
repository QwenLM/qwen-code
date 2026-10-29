//! Generic locked target directory for per-platform element caches.
//!
//! Platform caches store weak references here. Native snapshots are owned by
//! the token registry and resolved actions, so replacing a directory entry
//! cannot change the native object or metadata bound to an in-flight action.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;

/// Generic locked-HashMap holding one snapshot of type `S` per key.
///
/// The `K: Clone` bound lets the wrapper build a key value on the
/// stack and pass `&K` in for lookups without forcing callers to
/// hand out owned keys on every read.
pub struct ElementCacheCore<K: Eq + Hash, S> {
    inner: Mutex<HashMap<K, S>>,
}

impl<K: Eq + Hash, S> ElementCacheCore<K, S> {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Replace the entry for `key`, dropping the previous stored value.
    pub fn insert(&self, key: K, snapshot: S) {
        let mut inner = self.inner.lock().unwrap();
        inner.insert(key, snapshot);
    }

    /// Run `f` against the snapshot for `key` while the lock is
    /// held. Returns `None` if there is no entry.
    pub fn with_snapshot<R>(&self, key: &K, f: impl FnOnce(&S) -> R) -> Option<R> {
        let inner = self.inner.lock().unwrap();
        inner.get(key).map(f)
    }

    /// Drop the snapshot for `key` if present.
    #[allow(dead_code)]
    pub fn remove(&self, key: &K) {
        let mut inner = self.inner.lock().unwrap();
        inner.remove(key);
    }
}

impl<K: Eq + Hash, S> Default for ElementCacheCore<K, S> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    struct TestKey {
        pid: u32,
        window_id: u64,
    }

    struct TestSnapshot {
        elements: Vec<usize>,
    }

    #[test]
    fn insert_then_get_returns_projection() {
        let cache: ElementCacheCore<TestKey, TestSnapshot> = ElementCacheCore::new();
        let key = TestKey {
            pid: 42,
            window_id: 7,
        };
        cache.insert(
            key,
            TestSnapshot {
                elements: vec![10, 20, 30],
            },
        );

        let third = cache.with_snapshot(&key, |s| s.elements.get(2).copied());
        assert_eq!(third, Some(Some(30)));
    }

    #[test]
    fn miss_returns_none() {
        let cache: ElementCacheCore<TestKey, TestSnapshot> = ElementCacheCore::new();
        let key = TestKey {
            pid: 1,
            window_id: 1,
        };
        let v = cache.with_snapshot(&key, |s| s.elements.len());
        assert_eq!(v, None);
    }

    #[test]
    fn count_via_with_snapshot() {
        let cache: ElementCacheCore<TestKey, TestSnapshot> = ElementCacheCore::new();
        let key = TestKey {
            pid: 9,
            window_id: 99,
        };

        // Before insert: None.
        assert_eq!(cache.with_snapshot(&key, |s| s.elements.len()), None);

        cache.insert(
            key,
            TestSnapshot {
                elements: vec![1, 2, 3, 4, 5],
            },
        );
        assert_eq!(cache.with_snapshot(&key, |s| s.elements.len()), Some(5));
    }

    #[test]
    fn insert_replaces_existing_and_runs_drop() {
        // Smoke test that re-inserting under the same key replaces
        // the prior stored value — its Drop fires here in this
        // code (CFRelease/COM Release). We can't exercise FFI in a
        // unit test, but we can confirm the value was replaced.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        struct DropCounter {
            counter: Arc<AtomicUsize>,
        }
        impl Drop for DropCounter {
            fn drop(&mut self) {
                self.counter.fetch_add(1, Ordering::SeqCst);
            }
        }

        let drops = Arc::new(AtomicUsize::new(0));
        let cache: ElementCacheCore<u32, DropCounter> = ElementCacheCore::new();

        cache.insert(
            1,
            DropCounter {
                counter: drops.clone(),
            },
        );
        assert_eq!(drops.load(Ordering::SeqCst), 0);

        cache.insert(
            1,
            DropCounter {
                counter: drops.clone(),
            },
        );
        assert_eq!(
            drops.load(Ordering::SeqCst),
            1,
            "replacement should drop the prior snapshot"
        );

        cache.remove(&1);
        assert_eq!(
            drops.load(Ordering::SeqCst),
            2,
            "remove should drop the snapshot"
        );
    }

    #[test]
    fn default_impl_matches_new() {
        let _cache: ElementCacheCore<TestKey, TestSnapshot> = ElementCacheCore::default();
    }
}
