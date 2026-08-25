use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use cua_driver_core::observation_revision::{
    current_observation_session_identity, CapturedNode, FullResyncReason, ObservationLineage,
    ObservationRevisionError, ObservationRevisionRequest, ObservationRevisionResult,
    ObservationSessionIdentity,
};

use super::tree::{format_revision_body, AXIdentity, AXNode};

const RETAINED_REVISIONS: usize = 8;
const MAX_LINEAGES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RevisionKey {
    session: ObservationSessionIdentity,
    pid: i32,
    window_id: u32,
    max_elements: usize,
    max_depth: usize,
    serializer_version: String,
    projection_version: String,
}

#[derive(Default)]
struct RevisionStore {
    lineages: HashMap<RevisionKey, ObservationLineage<AXIdentity>>,
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
                .clear_lineage(lineage.lineage_id());
        }
    }
}

pub struct MacObservationRevisions {
    store: Mutex<RevisionStore>,
}

impl MacObservationRevisions {
    pub fn new() -> Self {
        Self {
            store: Mutex::new(RevisionStore::default()),
        }
    }

    pub fn observe(
        &self,
        pid: i32,
        window_id: u32,
        max_elements: usize,
        max_depth: usize,
        nodes: &[AXNode],
        complete: bool,
        request: &ObservationRevisionRequest,
    ) -> Result<ObservationRevisionResult, String> {
        let session = current_observation_session_identity().ok_or_else(|| {
            "observation_revision requires a bound trusted driver session".to_owned()
        })?;
        let key = RevisionKey {
            session,
            pid,
            window_id,
            max_elements,
            max_depth,
            serializer_version: request.serializer_version.clone(),
            projection_version: request.projection_version.clone(),
        };
        let mut store = self.store.lock().unwrap();
        let identities = nodes
            .iter()
            .map(|node| node.identity.clone())
            .collect::<Option<Vec<_>>>();
        let identity_available = identities.as_ref().is_some_and(|identities| {
            let mut seen = HashSet::with_capacity(identities.len());
            identities.iter().all(|identity| seen.insert(identity))
        });
        if !complete || !identity_available {
            store.remove(&key);
            let reason = if complete {
                FullResyncReason::IdentityUnavailable
            } else {
                FullResyncReason::CaptureIncomplete
            };
            return transient_full(nodes, reason);
        }
        let captured = nodes
            .iter()
            .zip(identities.expect("checked above"))
            .map(|(node, identity)| CapturedNode {
                identity,
                depth: node.depth,
                body: format_revision_body(node),
                actionable_index: node.element_index,
            })
            .collect::<Vec<_>>();
        if !store.lineages.contains_key(&key) {
            store.ensure_capacity();
            store.lineages.insert(
                key.clone(),
                ObservationLineage::new(
                    format!("l_{}", uuid::Uuid::new_v4().simple()),
                    RETAINED_REVISIONS,
                )
                .map_err(|error| error.to_string())?,
            );
        }
        store.touch(&key);
        let lineage = store.lineages.get_mut(&key).expect("inserted above");
        let forced_reason =
            cua_driver_core::observation_revision::requested_format_resync_reason(request)
                .or_else(|| request.force_full.then_some(FullResyncReason::Requested));
        lineage
            .observe_with_reason(captured, request.base_revision_id.as_deref(), forced_reason)
            .map_err(|error: ObservationRevisionError| error.to_string())
    }

    pub fn clear_session(&self, session_id: &str) {
        self.clear_where(|key| key.session.session_id == session_id);
    }

    pub fn clear_runtime(&self, runtime_scope: &str) {
        self.clear_where(|key| key.session.runtime_scope == runtime_scope);
    }

    pub fn clear_target(&self, pid: i32, window_id: u32) {
        self.clear_where(|key| key.pid == pid && key.window_id == window_id);
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

impl Default for MacObservationRevisions {
    fn default() -> Self {
        Self::new()
    }
}

fn transient_full(
    nodes: &[AXNode],
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
