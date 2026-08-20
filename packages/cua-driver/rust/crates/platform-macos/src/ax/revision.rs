use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use cua_driver_core::observation_revision::{
    current_observation_session_identity, CapturedNode, FullResyncReason, ObservationLineage,
    ObservationRevisionError, ObservationRevisionRequest, ObservationRevisionResult,
    ObservationSessionIdentity,
};

use super::tree::{format_revision_body, AXIdentity, AXNode};

const RETAINED_REVISIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RevisionKey {
    session: ObservationSessionIdentity,
    pid: i32,
    window_id: u32,
    max_elements: usize,
    max_depth: usize,
}

pub struct MacObservationRevisions {
    lineages: Mutex<HashMap<RevisionKey, ObservationLineage<AXIdentity>>>,
}

impl MacObservationRevisions {
    pub fn new() -> Self {
        Self {
            lineages: Mutex::new(HashMap::new()),
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
        let captured = nodes
            .iter()
            .map(|node| {
                Ok(CapturedNode {
                    identity: node.identity.clone().ok_or_else(|| {
                        "macOS AX capture did not retain a native identity".to_owned()
                    })?,
                    depth: node.depth,
                    body: format_revision_body(node),
                    actionable_index: node.element_index,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let key = RevisionKey {
            session,
            pid,
            window_id,
            max_elements,
            max_depth,
        };
        let mut lineages = self.lineages.lock().unwrap();
        let identity_available = {
            let mut seen = HashSet::with_capacity(captured.len());
            captured.iter().all(|node| seen.insert(&node.identity))
        };
        if !complete || !identity_available {
            if let Some(previous) = lineages.remove(&key) {
                cua_driver_core::observation_revision::revision_tokens()
                    .clear_lineage(previous.lineage_id());
            }
            let mut transient = ObservationLineage::new(
                format!("l_{}", uuid::Uuid::new_v4().simple()),
                RETAINED_REVISIONS,
            )
            .map_err(|error| error.to_string())?;
            let reason = if complete {
                FullResyncReason::IdentityUnavailable
            } else {
                FullResyncReason::CaptureIncomplete
            };
            return transient
                .observe_unretained_full(captured, reason)
                .map_err(|error: ObservationRevisionError| error.to_string());
        }
        let lineage = match lineages.entry(key) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                ObservationLineage::new(
                    format!("l_{}", uuid::Uuid::new_v4().simple()),
                    RETAINED_REVISIONS,
                )
                .map_err(|error| error.to_string())?,
            ),
        };
        let forced_reason = if request.force_full {
            Some(FullResyncReason::Requested)
        } else {
            None
        };
        lineage
            .observe_with_reason(captured, request.base_revision_id.as_deref(), forced_reason)
            .map_err(|error: ObservationRevisionError| error.to_string())
    }

    pub fn clear_session(&self, session_id: &str) {
        self.lineages
            .lock()
            .unwrap()
            .retain(|key, _| key.session.session_id != session_id);
    }

    pub fn clear_runtime(&self, runtime_scope: &str) {
        self.lineages
            .lock()
            .unwrap()
            .retain(|key, _| key.session.runtime_scope != runtime_scope);
    }
}

impl Default for MacObservationRevisions {
    fn default() -> Self {
        Self::new()
    }
}
