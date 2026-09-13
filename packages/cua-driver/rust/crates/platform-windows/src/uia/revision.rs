use std::collections::{HashMap, VecDeque};
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
            .map(|node| {
                if node.element_ptr == 0 {
                    None
                } else {
                    node.runtime_id.clone()
                }
            })
            .collect::<Vec<_>>();
        let runtime_id_counts = runtime_id_counts(&runtime_ids);

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
        let stable_ids = reconcile_runtime_ids(
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
        );

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
            let Some(runtime_id) = runtime_id else {
                continue;
            };
            if runtime_id_counts.get(&runtime_id) != Some(&1) {
                continue;
            }
            let Ok(element) = (unsafe { RetainedUiaElement::retain(node.element_ptr) }) else {
                continue;
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

fn runtime_id_counts(runtime_ids: &[Option<Vec<i32>>]) -> HashMap<Vec<i32>, usize> {
    let mut counts = HashMap::new();
    for runtime_id in runtime_ids.iter().flatten() {
        *counts.entry(runtime_id.clone()).or_insert(0) += 1;
    }
    counts
}

fn reconcile_runtime_ids(
    previous: &HashMap<Vec<i32>, u64>,
    current: &[Option<Vec<i32>>],
    next_identity: &mut u64,
    mut compare: impl FnMut(&[i32], usize) -> Result<bool, String>,
) -> Vec<u64> {
    let counts = runtime_id_counts(current);
    current
        .iter()
        .enumerate()
        .map(|(index, runtime_id)| {
            if let Some(runtime_id) = runtime_id {
                if counts.get(runtime_id) != Some(&1) {
                    let stable_id = *next_identity;
                    *next_identity += 1;
                    return stable_id;
                }
                if let Some(stable_id) = previous.get(runtime_id) {
                    match compare(runtime_id, index) {
                        Ok(true) => return *stable_id,
                        Ok(false) => {}
                        Err(error) => {
                            tracing::debug!(
                                target: "uia",
                                "CompareElements failed for one node; replacing its identity: {error}"
                            );
                        }
                    }
                }
            }
            let stable_id = *next_identity;
            *next_identity += 1;
            stable_id
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_capture_evicts_the_current_lineage() {
        let revisions = WindowsObservationRevisions::new();
        let session = ObservationSessionIdentity {
            runtime_scope: "runtime".into(),
            session_id: "session".into(),
            transport_session_id: "transport".into(),
        };
        let request = ObservationRevisionRequest {
            version: 1,
            serializer_version: "serializer".into(),
            projection_version: "projection".into(),
            base_revision_id: None,
            force_full: false,
        };
        let key = RevisionKey {
            session: session.clone(),
            pid: 42,
            hwnd: 7,
            max_elements: 100,
            max_depth: 10,
            serializer_version: request.serializer_version.clone(),
            projection_version: request.projection_version.clone(),
        };
        {
            let mut store = revisions.store.lock().unwrap();
            store
                .lineages
                .insert(key.clone(), WindowsLineageEntry::new().unwrap());
            store.touch(&key);
        }
        let tree = UiaTreeResult {
            tree_markdown: "button".into(),
            nodes: vec![UiaNode {
                element_index: Some(0),
                control_type: "Button".into(),
                name: Some("Retry".into()),
                value: None,
                automation_id: Some("retry".into()),
                help_text: None,
                actions: vec!["invoke".into()],
                runtime_id: Some(vec![1]),
                enabled: Some(true),
                selected: None,
                element_ptr: 0,
                center_x: 0,
                center_y: 0,
                rect: None,
                msaa_role: None,
                depth: 0,
                parent_element_index: None,
                in_web_content: false,
            }],
            backend: UiaBackend::Uia,
            complete: false,
            truncated: false,
            incomplete_notes: vec!["provider timed out".into()],
        };

        let result = revisions
            .observe(session, 42, 7, 100, 10, &tree, &request)
            .unwrap();

        assert_eq!(
            result.full_resync_reason,
            Some(FullResyncReason::CaptureIncomplete)
        );
        assert!(!result.stable_element_ids);
        assert!(!revisions.store.lock().unwrap().lineages.contains_key(&key));
    }

    #[test]
    fn runtime_id_candidate_requires_native_confirmation() {
        let previous = HashMap::from([(vec![1, 2], 9)]);
        let mut next = 10;
        let same =
            reconcile_runtime_ids(&previous, &[Some(vec![1, 2])], &mut next, |_, _| Ok(true));
        assert_eq!(same, vec![9]);
        assert_eq!(next, 10);

        let recreated =
            reconcile_runtime_ids(&previous, &[Some(vec![1, 2])], &mut next, |_, _| Ok(false));
        assert_eq!(recreated, vec![10]);
        assert_eq!(next, 11);
    }

    #[test]
    fn insertion_and_reorder_keep_confirmed_existing_identities() {
        let previous = HashMap::from([(vec![1], 4), (vec![2], 5)]);
        let mut next = 6;
        let identities = reconcile_runtime_ids(
            &previous,
            &[Some(vec![2]), Some(vec![3]), Some(vec![1])],
            &mut next,
            |_, _| Ok(true),
        );
        assert_eq!(identities, vec![5, 6, 4]);
        assert_eq!(next, 7);
    }

    #[test]
    fn unavailable_or_ambiguous_identities_are_replaced_locally() {
        let previous = HashMap::from([(vec![1], 4), (vec![2], 5)]);
        let mut next = 6;
        assert_eq!(
            reconcile_runtime_ids(
                &previous,
                &[Some(vec![1]), None, Some(vec![1]), Some(vec![2])],
                &mut next,
                |_, _| Ok(true),
            ),
            vec![6, 7, 8, 5]
        );
        assert_eq!(next, 9);

        assert_eq!(
            reconcile_runtime_ids(&previous, &[Some(vec![1])], &mut next, |_, _| Err(
                "provider disconnected".into()
            ),),
            vec![9]
        );
        assert_eq!(next, 10);
    }
}
