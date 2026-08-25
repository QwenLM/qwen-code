use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use cua_driver_core::observation_revision::{
    CapturedNode, FullResyncReason, ObservationLineage, ObservationRevisionRequest,
    ObservationRevisionResult, ObservationSessionIdentity,
};
use windows::core::Interface;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationElement};

use super::{format_revision_body, UiaBackend, UiaNode, UiaTreeResult};

const RETAINED_REVISIONS: usize = 8;
const MAX_LINEAGES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RevisionKey {
    session: ObservationSessionIdentity,
    pid: u32,
    hwnd: u64,
    max_elements: usize,
    max_depth: usize,
    serializer_version: String,
    projection_version: String,
}

struct RetainedUiaElement(usize);

impl RetainedUiaElement {
    unsafe fn retain(ptr: usize) -> Result<Self, String> {
        if ptr == 0 {
            return Err("UIA element pointer is null".into());
        }
        let borrowed = std::mem::ManuallyDrop::new(IUIAutomationElement::from_raw(ptr as *mut _));
        let retained = (*borrowed).clone();
        let retained_ptr = retained.as_raw() as usize;
        std::mem::forget(retained);
        Ok(Self(retained_ptr))
    }

    fn as_ptr(&self) -> usize {
        self.0
    }
}

impl Drop for RetainedUiaElement {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { drop(IUIAutomationElement::from_raw(self.0 as *mut _)) };
        }
    }
}

struct NativeIdentity {
    stable_id: u64,
    element: RetainedUiaElement,
}

struct WindowsLineage {
    revision: ObservationLineage<u64>,
    identities: HashMap<Vec<i32>, NativeIdentity>,
    next_native_identity: u64,
}

impl WindowsLineage {
    fn new(lineage_id: String) -> Result<Self, String> {
        Ok(Self {
            revision: ObservationLineage::new(lineage_id, RETAINED_REVISIONS)
                .map_err(|error| error.to_string())?,
            identities: HashMap::new(),
            next_native_identity: 0,
        })
    }
}

struct WindowsLineageEntry {
    lineage_id: String,
    state: Arc<Mutex<WindowsLineage>>,
}

impl WindowsLineageEntry {
    fn new() -> Result<Self, String> {
        let lineage_id = format!("l_{}", uuid::Uuid::new_v4().simple());
        Ok(Self {
            state: Arc::new(Mutex::new(WindowsLineage::new(lineage_id.clone())?)),
            lineage_id,
        })
    }
}

#[derive(Default)]
struct RevisionStore {
    lineages: HashMap<RevisionKey, WindowsLineageEntry>,
    lru: VecDeque<RevisionKey>,
}

impl RevisionStore {
    fn touch(&mut self, key: &RevisionKey) {
        self.lru.retain(|candidate| candidate != key);
        self.lru.push_back(key.clone());
    }

    fn ensure_capacity(&mut self) {
        while self.lineages.len() >= MAX_LINEAGES {
            let Some(key) = self.lru.pop_front() else {
                break;
            };
            self.remove(&key);
        }
    }

    fn remove(&mut self, key: &RevisionKey) {
        self.lru.retain(|candidate| candidate != key);
        if let Some(lineage) = self.lineages.remove(key) {
            cua_driver_core::observation_revision::revision_tokens()
                .clear_lineage(&lineage.lineage_id);
        }
    }

    fn remove_if_current(&mut self, key: &RevisionKey, state: &Arc<Mutex<WindowsLineage>>) {
        if self
            .lineages
            .get(key)
            .is_some_and(|entry| Arc::ptr_eq(&entry.state, state))
        {
            self.remove(key);
        }
    }
}

pub struct WindowsObservationRevisions {
    store: Mutex<RevisionStore>,
}

impl WindowsObservationRevisions {
    pub fn new() -> Self {
        Self {
            store: Mutex::new(RevisionStore::default()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &self,
        session: ObservationSessionIdentity,
        pid: u32,
        hwnd: u64,
        max_elements: usize,
        max_depth: usize,
        tree: &UiaTreeResult,
        request: &ObservationRevisionRequest,
    ) -> Result<ObservationRevisionResult, String> {
        let key = RevisionKey {
            session,
            pid,
            hwnd,
            max_elements,
            max_depth,
            serializer_version: request.serializer_version.clone(),
            projection_version: request.projection_version.clone(),
        };

        if tree.backend == UiaBackend::Msaa {
            self.store.lock().unwrap().remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::UnsupportedBackend);
        }
        if !tree.complete {
            self.store.lock().unwrap().remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::CaptureIncomplete);
        }

        let runtime_ids = tree
            .nodes
            .iter()
            .map(|node| node.runtime_id.clone())
            .collect::<Option<Vec<_>>>();
        let Some(runtime_ids) = runtime_ids else {
            self.store.lock().unwrap().remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
        };
        if runtime_ids.iter().collect::<HashSet<_>>().len() != runtime_ids.len() {
            self.store.lock().unwrap().remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
        }
        if tree.nodes.iter().any(|node| node.element_ptr == 0) {
            self.store.lock().unwrap().remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
        }

        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let automation: IUIAutomation =
            match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                Ok(automation) => automation,
                Err(error) => {
                    self.store.lock().unwrap().remove(&key);
                    tracing::debug!(target: "uia", "UIA comparison initialization failed: {error}");
                    return transient_full(&tree.nodes, FullResyncReason::ProviderInvalidated);
                }
            };

        let lineage_state = {
            let mut store = self.store.lock().unwrap();
            if !store.lineages.contains_key(&key) {
                store.ensure_capacity();
                store
                    .lineages
                    .insert(key.clone(), WindowsLineageEntry::new()?);
            }
            store.touch(&key);
            store
                .lineages
                .get(&key)
                .expect("inserted above")
                .state
                .clone()
        };
        // UIA provider calls can block. Serialize only this lineage while
        // comparing native elements so target/session cleanup and unrelated
        // observations never wait on a provider-owned COM call.
        let mut lineage = lineage_state.lock().unwrap();

        let previous = lineage
            .identities
            .iter()
            .map(|(runtime_id, identity)| (runtime_id.clone(), identity.stable_id))
            .collect::<HashMap<_, _>>();
        let previous_ptrs = lineage
            .identities
            .iter()
            .map(|(runtime_id, identity)| (runtime_id.clone(), identity.element.as_ptr()))
            .collect::<HashMap<_, _>>();
        let stable_ids = match reconcile_runtime_ids(
            &previous,
            &runtime_ids,
            &mut lineage.next_native_identity,
            |runtime_id, current_index| {
                let previous_ptr = previous_ptrs
                    .get(runtime_id)
                    .expect("candidate came from identities");
                compare_elements(
                    &automation,
                    *previous_ptr,
                    tree.nodes[current_index].element_ptr,
                )
            },
        ) {
            Ok(ids) => ids,
            Err(ReconcileError::DuplicateIdentity) => {
                drop(lineage);
                self.store
                    .lock()
                    .unwrap()
                    .remove_if_current(&key, &lineage_state);
                return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
            }
            Err(ReconcileError::ProviderInvalidated(error)) => {
                drop(lineage);
                self.store
                    .lock()
                    .unwrap()
                    .remove_if_current(&key, &lineage_state);
                tracing::debug!(target: "uia", "CompareElements failed: {error}");
                return transient_full(&tree.nodes, FullResyncReason::ProviderInvalidated);
            }
        };

        let captured = tree
            .nodes
            .iter()
            .zip(stable_ids.iter().copied())
            .map(|(node, identity)| CapturedNode {
                identity,
                depth: node.depth,
                body: format_revision_body(node),
                actionable_index: node.element_index,
            })
            .collect::<Vec<_>>();
        let forced_reason =
            cua_driver_core::observation_revision::requested_format_resync_reason(request)
                .or_else(|| request.force_full.then_some(FullResyncReason::Requested));
        let result = match lineage.revision.observe_with_reason(
            captured,
            request.base_revision_id.as_deref(),
            forced_reason,
        ) {
            Ok(result) => result,
            Err(error) => {
                drop(lineage);
                self.store
                    .lock()
                    .unwrap()
                    .remove_if_current(&key, &lineage_state);
                return Err(error.to_string());
            }
        };

        let mut next_identities = HashMap::with_capacity(tree.nodes.len());
        for ((node, runtime_id), stable_id) in tree.nodes.iter().zip(runtime_ids).zip(stable_ids) {
            let element = match unsafe { RetainedUiaElement::retain(node.element_ptr) } {
                Ok(element) => element,
                Err(error) => {
                    drop(lineage);
                    self.store
                        .lock()
                        .unwrap()
                        .remove_if_current(&key, &lineage_state);
                    return Err(error);
                }
            };
            next_identities.insert(runtime_id, NativeIdentity { stable_id, element });
        }
        lineage.identities = next_identities;
        drop(lineage);
        let still_current = {
            let mut store = self.store.lock().unwrap();
            let current = store
                .lineages
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(&entry.state, &lineage_state));
            if current {
                store.touch(&key);
            }
            current
        };
        if !still_current {
            return transient_full(&tree.nodes, FullResyncReason::ProviderInvalidated);
        }
        Ok(result)
    }

    pub fn clear_session(&self, session_id: &str) {
        self.clear_where(|key| key.session.session_id == session_id);
    }

    pub fn clear_runtime(&self, runtime_scope: &str) {
        self.clear_where(|key| key.session.runtime_scope == runtime_scope);
    }

    pub fn clear_target(&self, pid: u32, hwnd: u64) {
        self.clear_where(|key| key.pid == pid && key.hwnd == hwnd);
    }

    fn clear_where(&self, predicate: impl Fn(&RevisionKey) -> bool) {
        let mut store = self.store.lock().unwrap();
        let keys = store
            .lineages
            .keys()
            .filter(|key| predicate(key))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            store.remove(&key);
        }
    }
}

impl Default for WindowsObservationRevisions {
    fn default() -> Self {
        Self::new()
    }
}

fn transient_full(
    nodes: &[UiaNode],
    reason: FullResyncReason,
) -> Result<ObservationRevisionResult, String> {
    let captured = nodes
        .iter()
        .enumerate()
        .map(|(identity, node)| CapturedNode {
            identity,
            depth: node.depth,
            body: format_revision_body(node),
            actionable_index: node.element_index,
        })
        .collect::<Vec<_>>();
    let mut lineage = ObservationLineage::new(
        format!("l_{}", uuid::Uuid::new_v4().simple()),
        RETAINED_REVISIONS,
    )
    .map_err(|error| error.to_string())?;
    lineage
        .observe_unretained_full(captured, reason)
        .map_err(|error| error.to_string())
}

fn compare_elements(
    automation: &IUIAutomation,
    previous_ptr: usize,
    current_ptr: usize,
) -> Result<bool, String> {
    if previous_ptr == 0 || current_ptr == 0 {
        return Err("UIA comparison received a null element".into());
    }
    unsafe {
        let previous =
            std::mem::ManuallyDrop::new(IUIAutomationElement::from_raw(previous_ptr as *mut _));
        let current =
            std::mem::ManuallyDrop::new(IUIAutomationElement::from_raw(current_ptr as *mut _));
        automation
            .CompareElements(&*previous, &*current)
            .map(|same| same.as_bool())
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ReconcileError {
    DuplicateIdentity,
    ProviderInvalidated(String),
}

fn reconcile_runtime_ids(
    previous: &HashMap<Vec<i32>, u64>,
    current: &[Vec<i32>],
    next_identity: &mut u64,
    mut compare: impl FnMut(&[i32], usize) -> Result<bool, String>,
) -> Result<Vec<u64>, ReconcileError> {
    if current.iter().collect::<HashSet<_>>().len() != current.len() {
        return Err(ReconcileError::DuplicateIdentity);
    }
    current
        .iter()
        .enumerate()
        .map(|(index, runtime_id)| {
            if let Some(stable_id) = previous.get(runtime_id) {
                if compare(runtime_id, index).map_err(ReconcileError::ProviderInvalidated)? {
                    return Ok(*stable_id);
                }
            }
            let stable_id = *next_identity;
            *next_identity += 1;
            Ok(stable_id)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_id_candidate_requires_native_confirmation() {
        let previous = HashMap::from([(vec![1, 2], 9)]);
        let mut next = 10;
        let same =
            reconcile_runtime_ids(&previous, &[vec![1, 2]], &mut next, |_, _| Ok(true)).unwrap();
        assert_eq!(same, vec![9]);
        assert_eq!(next, 10);

        let recreated =
            reconcile_runtime_ids(&previous, &[vec![1, 2]], &mut next, |_, _| Ok(false)).unwrap();
        assert_eq!(recreated, vec![10]);
        assert_eq!(next, 11);
    }

    #[test]
    fn insertion_and_reorder_keep_confirmed_existing_identities() {
        let previous = HashMap::from([(vec![1], 4), (vec![2], 5)]);
        let mut next = 6;
        let identities = reconcile_runtime_ids(
            &previous,
            &[vec![2], vec![3], vec![1]],
            &mut next,
            |_, _| Ok(true),
        )
        .unwrap();
        assert_eq!(identities, vec![5, 6, 4]);
        assert_eq!(next, 7);
    }

    #[test]
    fn duplicates_and_provider_errors_fail_closed() {
        let previous = HashMap::from([(vec![1], 4)]);
        let mut next = 5;
        assert_eq!(
            reconcile_runtime_ids(&previous, &[vec![1], vec![1]], &mut next, |_, _| Ok(true)),
            Err(ReconcileError::DuplicateIdentity)
        );
        assert!(matches!(
            reconcile_runtime_ids(&previous, &[vec![1]], &mut next, |_, _| {
                Err("provider disconnected".into())
            }),
            Err(ReconcileError::ProviderInvalidated(_))
        ));
    }
}
