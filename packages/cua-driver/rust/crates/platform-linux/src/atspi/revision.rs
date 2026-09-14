use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use cua_driver_core::observation_revision::{
    CapturedNode, FullResyncReason, ObservationLineage, ObservationRevisionError,
    ObservationRevisionRequest, ObservationRevisionResult, ObservationSessionIdentity,
};

use super::{format_revision_body, AtspiBackend, AtspiIdentity, AtspiNode, AtspiTreeResult};

const RETAINED_REVISIONS: usize = 8;
const MAX_LINEAGES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RevisionKey {
    session: ObservationSessionIdentity,
    pid: u32,
    xid: u64,
    max_elements: usize,
    max_depth: usize,
    bounded: bool,
    serializer_version: String,
    projection_version: String,
}

struct LinuxLineage {
    revision: ObservationLineage<AtspiIdentity>,
    owners: HashSet<String>,
}

impl LinuxLineage {
    fn new() -> Result<Self, String> {
        Ok(Self {
            revision: ObservationLineage::new(
                format!("l_{}", uuid::Uuid::new_v4().simple()),
                RETAINED_REVISIONS,
            )
            .map_err(|error| error.to_string())?,
            owners: HashSet::new(),
        })
    }
}

#[derive(Default)]
struct RevisionStore {
    lineages: HashMap<RevisionKey, LinuxLineage>,
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
                .clear_lineage(lineage.revision.lineage_id());
        }
    }
}

pub struct LinuxObservationRevisions {
    store: Mutex<RevisionStore>,
}

impl LinuxObservationRevisions {
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
        xid: u64,
        max_elements: usize,
        max_depth: usize,
        tree: &AtspiTreeResult,
        request: &ObservationRevisionRequest,
    ) -> Result<ObservationRevisionResult, String> {
        let key = RevisionKey {
            session,
            pid,
            xid,
            max_elements,
            max_depth,
            bounded: tree.truncated,
            serializer_version: request.serializer_version.clone(),
            projection_version: request.projection_version.clone(),
        };
        let mut store = self.store.lock().unwrap();
        store.remove(&RevisionKey {
            bounded: !key.bounded,
            ..key.clone()
        });
        if tree.backend == AtspiBackend::X11 {
            store.remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::UnsupportedBackend);
        }
        if !tree.read_complete() {
            store.remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::CaptureIncomplete);
        }
        let identities = tree
            .nodes
            .iter()
            .map(|node| node.identity.clone())
            .collect::<Option<Vec<_>>>();
        let Some(identities) = identities else {
            store.remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
        };
        if identities.iter().collect::<HashSet<_>>().len() != identities.len() {
            store.remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::IdentityUnavailable);
        }
        let owners = identities
            .iter()
            .map(|identity| identity.unique_owner.clone())
            .collect::<HashSet<_>>();

        if store
            .lineages
            .get(&key)
            .is_some_and(|lineage| !lineage.owners.is_empty() && lineage.owners != owners)
        {
            store.remove(&key);
            return transient_full(&tree.nodes, FullResyncReason::ProviderInvalidated);
        }
        if !store.lineages.contains_key(&key) {
            store.ensure_capacity();
            store.lineages.insert(key.clone(), LinuxLineage::new()?);
        }
        store.touch(&key);
        let lineage = store.lineages.get_mut(&key).expect("inserted above");
        let captured = tree
            .nodes
            .iter()
            .zip(identities)
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
        let result = if tree.truncated {
            lineage.revision.observe_bounded(
                captured,
                request.base_revision_id.as_deref(),
                forced_reason,
            )
        } else {
            lineage.revision.observe_with_reason(
                captured,
                request.base_revision_id.as_deref(),
                forced_reason,
            )
        }
        .map_err(|error: ObservationRevisionError| error.to_string())?;
        lineage.owners = owners;
        Ok(result)
    }

    pub fn clear_session(&self, session_id: &str) {
        self.clear_where(|key| key.session.session_id == session_id);
    }

    pub fn clear_runtime(&self, runtime_scope: &str) {
        self.clear_where(|key| key.session.runtime_scope == runtime_scope);
    }

    pub fn clear_target(&self, pid: u32, xid: u64) {
        self.clear_where(|key| key.pid == pid && key.xid == xid);
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

impl Default for LinuxObservationRevisions {
    fn default() -> Self {
        Self::new()
    }
}

fn transient_full(
    nodes: &[AtspiNode],
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

#[cfg(test)]
mod tests {
    use super::*;
    use cua_driver_core::observation_revision::{
        ObservationMode, ACCESSIBILITY_PROJECTION_VERSION, ACCESSIBILITY_SERIALIZER_VERSION,
        OBSERVATION_REVISION_VERSION,
    };

    fn session() -> ObservationSessionIdentity {
        ObservationSessionIdentity {
            runtime_scope: "runtime".into(),
            session_id: "session".into(),
            transport_session_id: "transport".into(),
        }
    }

    fn request(base_revision_id: Option<String>) -> ObservationRevisionRequest {
        ObservationRevisionRequest {
            version: OBSERVATION_REVISION_VERSION,
            serializer_version: ACCESSIBILITY_SERIALIZER_VERSION.into(),
            projection_version: ACCESSIBILITY_PROJECTION_VERSION.into(),
            base_revision_id,
            force_full: false,
        }
    }

    fn node(path: &str, name: &str) -> AtspiNode {
        AtspiNode {
            element_index: Some(0),
            role: "button".into(),
            name: Some(name.into()),
            value: None,
            checked: None,
            enabled: Some(true),
            selected: None,
            description: None,
            actions: vec!["click".into()],
            element_key: 0,
            depth: 0,
            parent_element_index: None,
            in_web_content: false,
            identity: Some(AtspiIdentity {
                unique_owner: ":1.5".into(),
                object_path: path.into(),
            }),
        }
    }

    fn tree(nodes: Vec<AtspiNode>) -> AtspiTreeResult {
        AtspiTreeResult {
            tree_markdown: String::new(),
            nodes,
            bounds: Vec::new(),
            trusted: true,
            degraded_reason: None,
            window_scoped: true,
            backend: AtspiBackend::Atspi,
            complete: true,
            truncated: false,
            incomplete_notes: Vec::new(),
        }
    }

    #[test]
    fn budget_captures_retain_lineage_but_failures_and_coverage_changes_invalidate_it() {
        for reason in ["max_elements_reached", "max_depth_reached"] {
            let revisions = LinuxObservationRevisions::new();
            let mut bounded = tree(vec![node("/button", "Before")]);
            bounded.complete = false;
            bounded.truncated = true;
            bounded.incomplete_notes = vec![reason.into()];
            let observe = |tree: &AtspiTreeResult, base| {
                revisions
                    .observe(session(), 10, 20, 1, 3, tree, &request(base))
                    .unwrap()
            };
            let first = observe(&bounded, None);
            assert!(bounded.read_complete());
            assert!(first.stable_element_ids);
            let unchanged = observe(&bounded, Some(first.revision_id.clone()));
            assert_eq!(unchanged.mode, ObservationMode::NoChange);
            assert_eq!(unchanged.lineage_id, first.lineage_id);
            bounded.nodes[0].name = Some("After".into());
            let changed = observe(&bounded, Some(unchanged.revision_id));
            assert_eq!(changed.mode, ObservationMode::Full);
            assert!(changed.stable_element_ids);
            assert_eq!(changed.lineage_id, first.lineage_id);
            assert_eq!(changed.nodes[0].element_id, first.nodes[0].element_id);
            for failure in [
                "provider_unresponsive",
                "walk_deadline_reached",
                "read_failed",
            ] {
                bounded.incomplete_notes.push(failure.into());
                assert!(!bounded.read_complete());
                let failed = observe(&bounded, Some(changed.revision_id.clone()));
                assert!(!failed.stable_element_ids);
                assert_eq!(
                    failed.full_resync_reason,
                    Some(FullResyncReason::CaptureIncomplete)
                );
                bounded.incomplete_notes.pop();
            }
            bounded.window_scoped = false;
            assert!(!bounded.read_complete());
            assert!(!observe(&bounded, None).stable_element_ids);
            bounded.window_scoped = true;
            let recovered = observe(&bounded, Some(changed.revision_id));
            assert_ne!(recovered.lineage_id, first.lineage_id);
            let full = observe(
                &tree(vec![node("/button", "After")]),
                Some(recovered.revision_id),
            );
            assert_eq!(full.mode, ObservationMode::Full);
            assert_ne!(full.lineage_id, recovered.lineage_id);
            let bounded_again = observe(&bounded, Some(full.revision_id));
            assert_eq!(bounded_again.mode, ObservationMode::Full);
            assert_ne!(bounded_again.lineage_id, recovered.lineage_id);
        }
    }

    #[test]
    fn stable_owner_and_path_retain_no_change_and_diff_lineage() {
        let revisions = LinuxObservationRevisions::new();
        let capture = |name| {
            tree(
                (0..8)
                    .map(|index| {
                        let mut captured = node(
                            &format!("/button/{index}"),
                            if index == 0 { name } else { "Unchanged" },
                        );
                        captured.element_index = Some(index);
                        captured
                    })
                    .collect(),
            )
        };
        let initial = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &capture("Before"),
                &request(None),
            )
            .unwrap();
        assert_eq!(initial.mode, ObservationMode::Full);
        assert!(initial.stable_element_ids);

        let unchanged = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &capture("Before"),
                &request(Some(initial.revision_id.clone())),
            )
            .unwrap();
        assert_eq!(unchanged.mode, ObservationMode::NoChange);

        let changed = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &capture("After"),
                &request(Some(unchanged.revision_id)),
            )
            .unwrap();
        assert_eq!(changed.mode, ObservationMode::Diff);
        assert_eq!(changed.lineage_id, initial.lineage_id);
        assert_eq!(changed.nodes[0].element_id, initial.nodes[0].element_id);
    }

    #[test]
    fn named_editable_changes_and_clearing_remain_visible() {
        let revisions = LinuxObservationRevisions::new();
        let mut captured = tree(
            (0..8)
                .map(|index| {
                    let mut item = node(&format!("/field/{index}"), "Name");
                    item.element_index = Some(index);
                    item.role = "entry".into();
                    item.value = Some(String::new());
                    item
                })
                .collect(),
        );
        let mut base = None;
        let mut element_id = None;
        for (value, mode) in [
            ("", ObservationMode::Full),
            ("prefix|X", ObservationMode::Diff),
            ("prefix|X", ObservationMode::NoChange),
            ("", ObservationMode::Diff),
        ] {
            captured.nodes[0].value = Some(value.into());
            let observation = revisions
                .observe(
                    session(),
                    10,
                    20,
                    5000,
                    usize::MAX,
                    &captured,
                    &request(base),
                )
                .unwrap();
            assert_eq!(observation.mode, mode);
            assert!(observation.nodes[0]
                .body
                .contains(&format!("value={value:?}")));
            if let Some(id) = &element_id {
                assert_eq!(&observation.nodes[0].element_id, id);
            }
            element_id = Some(observation.nodes[0].element_id.clone());
            base = Some(observation.revision_id);
        }
    }

    #[test]
    fn compact_rows_preserve_text_state_and_secondary_actions() {
        let mut control = node("/entry", "Line 1\n\"Line 2\"");
        control.role = "entry".into();
        control.value = control.name.clone();
        control.enabled = Some(false);
        control.selected = Some(true);
        control.actions = vec!["activate".into(), "showContextMenu".into()];
        let body = format_revision_body(&control);
        assert_eq!(
            body,
            "<entry> \"Line 1\\n\\\"Line 2\\\"\" disabled selected actions=[\"showContextMenu\"]"
        );
        let disabled = body.clone();
        control.enabled = Some(true);
        assert_ne!(format_revision_body(&control), disabled);
        let selected = format_revision_body(&control);
        control.selected = Some(false);
        assert_ne!(format_revision_body(&control), selected);
        let secondary = format_revision_body(&control);
        control.actions.pop();
        assert_ne!(format_revision_body(&control), secondary);
        assert_eq!(control.actions, ["activate"]);
    }

    #[test]
    fn owner_change_and_incomplete_capture_fail_closed() {
        let revisions = LinuxObservationRevisions::new();
        let initial = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &tree(vec![node("/button", "Before")]),
                &request(None),
            )
            .unwrap();

        let mut restarted = node("/button", "After");
        restarted.identity.as_mut().unwrap().unique_owner = ":1.9".into();
        let provider_changed = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &tree(vec![restarted]),
                &request(Some(initial.revision_id.clone())),
            )
            .unwrap();
        assert_eq!(provider_changed.mode, ObservationMode::Full);
        assert_eq!(
            provider_changed.full_resync_reason,
            Some(FullResyncReason::ProviderInvalidated)
        );
        assert!(!provider_changed.stable_element_ids);

        let mut incomplete = tree(vec![node("/button", "After")]);
        incomplete.complete = false;
        incomplete.truncated = true;
        let partial = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &incomplete,
                &request(Some(initial.revision_id)),
            )
            .unwrap();
        assert_eq!(partial.mode, ObservationMode::Full);
        assert_eq!(
            partial.full_resync_reason,
            Some(FullResyncReason::CaptureIncomplete)
        );
        assert!(!partial.stable_element_ids);
    }

    #[test]
    fn x11_fallback_retires_the_previous_atspi_lineage() {
        let revisions = LinuxObservationRevisions::new();
        let initial = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &tree(vec![node("/button", "Before")]),
                &request(None),
            )
            .unwrap();

        let mut x11 = tree(vec![node("/button", "Fallback")]);
        x11.backend = AtspiBackend::X11;
        let fallback = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &x11,
                &request(Some(initial.revision_id.clone())),
            )
            .unwrap();
        assert_eq!(
            fallback.full_resync_reason,
            Some(FullResyncReason::UnsupportedBackend)
        );
        assert!(!fallback.stable_element_ids);

        let recovered = revisions
            .observe(
                session(),
                10,
                20,
                5000,
                usize::MAX,
                &tree(vec![node("/button", "Before")]),
                &request(Some(initial.revision_id)),
            )
            .unwrap();
        assert_eq!(recovered.mode, ObservationMode::Full);
        assert_ne!(recovered.lineage_id, initial.lineage_id);
    }
}
