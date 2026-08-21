use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::hash::Hash;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::Value;

const REVISION_TOKEN_PREFIX: &str = "rv1:";
pub const OBSERVATION_REVISION_VERSION: u32 = 1;
pub const ACCESSIBILITY_SERIALIZER_VERSION: &str = "accessibility-render-v1";
pub const ACCESSIBILITY_PROJECTION_VERSION: &str = "full-tree-v1";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationRevisionRequest {
    pub version: u32,
    pub serializer_version: String,
    pub projection_version: String,
    #[serde(default)]
    pub base_revision_id: Option<String>,
    #[serde(default)]
    pub force_full: bool,
}

pub fn parse_observation_revision_request(
    value: Option<&Value>,
) -> Result<Option<ObservationRevisionRequest>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let request: ObservationRevisionRequest = serde_json::from_value(value.clone())
        .map_err(|error| format!("invalid observation_revision request: {error}"))?;
    if request.version != OBSERVATION_REVISION_VERSION {
        return Err(format!(
            "unsupported observation_revision version {}; expected {}",
            request.version, OBSERVATION_REVISION_VERSION
        ));
    }
    if request
        .base_revision_id
        .as_deref()
        .is_some_and(|revision| revision.is_empty() || revision.len() > 256)
    {
        return Err("observation_revision.base_revision_id must contain 1-256 bytes".to_owned());
    }
    for (field, value) in [
        ("serializer_version", request.serializer_version.as_str()),
        ("projection_version", request.projection_version.as_str()),
    ] {
        if value.is_empty() || value.len() > 128 {
            return Err(format!(
                "observation_revision.{field} must contain 1-128 bytes"
            ));
        }
    }
    Ok(Some(request))
}

pub fn requested_format_resync_reason(
    request: &ObservationRevisionRequest,
) -> Option<FullResyncReason> {
    if request.serializer_version != ACCESSIBILITY_SERIALIZER_VERSION {
        Some(FullResyncReason::SerializerChanged)
    } else if request.projection_version != ACCESSIBILITY_PROJECTION_VERSION {
        Some(FullResyncReason::ProjectionChanged)
    } else {
        None
    }
}

/// Fresh lineage/revision identifier pair for a non-retained full response.
///
/// Backends without an approved stable native identity (the explicit
/// full-only platforms) answer every versioned observation request with a
/// transient full snapshot; nothing is retained, so each response gets a
/// fresh lineage that can never be named as a future base.
pub fn unretained_full_ids() -> (String, String) {
    let lineage_id = format!("l_{}", uuid::Uuid::new_v4().simple());
    let revision_id = format!("{lineage_id}:r0");
    (lineage_id, revision_id)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObservationSessionIdentity {
    pub runtime_scope: String,
    pub session_id: String,
    pub transport_session_id: String,
}

#[doc(hidden)]
pub fn current_observation_session_identity() -> Option<ObservationSessionIdentity> {
    let identity = crate::tool::current_dispatch_session_identity()?;
    Some(ObservationSessionIdentity {
        runtime_scope: identity.runtime_scope,
        session_id: identity.session_id,
        transport_session_id: identity.transport_session_id,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationMode {
    Full,
    Diff,
    NoChange,
}

impl ObservationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Diff => "diff",
            Self::NoChange => "no_change",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullResyncReason {
    Requested,
    MissingBase,
    BaseEvicted,
    TargetChanged,
    RuntimeChanged,
    SerializerChanged,
    ProjectionChanged,
    CaptureIncomplete,
    IdentityUnavailable,
    ProviderInvalidated,
    UnsupportedBackend,
    ValidationFailed,
    DiffNotSmaller,
}

impl FullResyncReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::MissingBase => "missing_base",
            Self::BaseEvicted => "base_evicted",
            Self::TargetChanged => "target_changed",
            Self::RuntimeChanged => "runtime_changed",
            Self::SerializerChanged => "serializer_changed",
            Self::ProjectionChanged => "projection_changed",
            Self::CaptureIncomplete => "capture_incomplete",
            Self::IdentityUnavailable => "identity_unavailable",
            Self::ProviderInvalidated => "provider_invalidated",
            Self::UnsupportedBackend => "unsupported_backend",
            Self::ValidationFailed => "validation_failed",
            Self::DiffNotSmaller => "diff_not_smaller",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedNode<I> {
    pub identity: I,
    pub depth: usize,
    pub body: String,
    pub actionable_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionNode {
    pub element_id: u64,
    pub order: usize,
    pub depth: usize,
    pub parent_id: Option<u64>,
    pub body: String,
    pub actionable_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationRevisionResult {
    pub lineage_id: String,
    pub revision_id: String,
    pub base_revision_id: Option<String>,
    pub mode: ObservationMode,
    pub full_resync_reason: Option<FullResyncReason>,
    pub stable_element_ids: bool,
    pub text: String,
    pub full_text: String,
    pub nodes: Vec<RevisionNode>,
    pub serializer_duration_us: u64,
    pub cache_estimate_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationRevisionError {
    EmptyLineageId,
    InvalidRetention,
    DuplicateIdentity,
}

impl fmt::Display for ObservationRevisionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyLineageId => "observation lineage id must not be empty",
            Self::InvalidRetention => "observation revision retention must be at least one",
            Self::DuplicateIdentity => {
                "one native identity appeared more than once in an observation"
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ObservationRevisionError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionTokenError {
    InvalidFormat,
    SessionUnavailable,
    SessionMismatch,
    RuntimeMismatch,
    TargetMismatch,
    StaleLineage,
    StaleElement,
}

impl RevisionTokenError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidFormat => "invalid_element_token",
            Self::SessionUnavailable => "session_unavailable",
            Self::SessionMismatch => "session_mismatch",
            Self::RuntimeMismatch => "generation_mismatch",
            Self::TargetMismatch => "conflicting_element_target",
            Self::StaleLineage | Self::StaleElement => "stale_element_token",
        }
    }
}

impl fmt::Display for RevisionTokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidFormat => "revision element_token has invalid format",
            Self::SessionUnavailable => {
                "revision element_token requires a bound trusted driver session"
            }
            Self::SessionMismatch => "revision element_token belongs to another driver session",
            Self::RuntimeMismatch => "revision element_token belongs to another runtime generation",
            Self::TargetMismatch => "revision element_token belongs to another target",
            Self::StaleLineage => "revision element_token lineage is stale",
            Self::StaleElement => "revision element_token no longer names a current element",
        })
    }
}

impl std::error::Error for RevisionTokenError {}

struct RevisionTokenEntry {
    session: ObservationSessionIdentity,
    pid: i32,
    window_id: u32,
    snapshot_id: u32,
    actionable_indices: HashMap<u64, usize>,
}

pub struct RevisionTokenRegistry {
    entries: Mutex<HashMap<String, RevisionTokenEntry>>,
}

impl RevisionTokenRegistry {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn register_current(
        &self,
        lineage_id: &str,
        pid: i32,
        window_id: u32,
        snapshot_id: u32,
        nodes: &[RevisionNode],
    ) -> Result<(), RevisionTokenError> {
        let session =
            current_observation_session_identity().ok_or(RevisionTokenError::SessionUnavailable)?;
        let actionable_indices = nodes
            .iter()
            .filter_map(|node| node.actionable_index.map(|index| (node.element_id, index)))
            .collect();
        self.register_for_session(
            session,
            lineage_id,
            pid,
            window_id,
            snapshot_id,
            actionable_indices,
        )
    }

    pub fn resolve_current(
        &self,
        pid: i32,
        token: &str,
    ) -> Result<(u32, usize, u32), RevisionTokenError> {
        let session =
            current_observation_session_identity().ok_or(RevisionTokenError::SessionUnavailable)?;
        self.resolve_for_session(&session, pid, token)
    }

    pub fn clear_session(&self, session_id: &str) {
        self.entries
            .lock()
            .unwrap()
            .retain(|_, entry| entry.session.session_id != session_id);
    }

    pub fn clear_runtime(&self, runtime_scope: &str) {
        self.entries
            .lock()
            .unwrap()
            .retain(|_, entry| entry.session.runtime_scope != runtime_scope);
    }

    pub fn clear_lineage(&self, lineage_id: &str) {
        self.entries.lock().unwrap().remove(lineage_id);
    }

    fn register_for_session(
        &self,
        session: ObservationSessionIdentity,
        lineage_id: &str,
        pid: i32,
        window_id: u32,
        snapshot_id: u32,
        actionable_indices: HashMap<u64, usize>,
    ) -> Result<(), RevisionTokenError> {
        if lineage_id.trim().is_empty() {
            return Err(RevisionTokenError::InvalidFormat);
        }
        let mut entries = self.entries.lock().unwrap();
        if let Some(existing) = entries.get(lineage_id) {
            if existing.session.runtime_scope != session.runtime_scope {
                return Err(RevisionTokenError::RuntimeMismatch);
            }
            if existing.session.session_id != session.session_id
                || existing.session.transport_session_id != session.transport_session_id
            {
                return Err(RevisionTokenError::SessionMismatch);
            }
            if existing.pid != pid || existing.window_id != window_id {
                return Err(RevisionTokenError::TargetMismatch);
            }
        }
        entries.insert(
            lineage_id.to_owned(),
            RevisionTokenEntry {
                session,
                pid,
                window_id,
                snapshot_id,
                actionable_indices,
            },
        );
        Ok(())
    }

    fn resolve_for_session(
        &self,
        session: &ObservationSessionIdentity,
        pid: i32,
        token: &str,
    ) -> Result<(u32, usize, u32), RevisionTokenError> {
        let (lineage_id, element_id) = parse_revision_token(token)?;
        let entries = self.entries.lock().unwrap();
        let entry = entries
            .get(lineage_id)
            .ok_or(RevisionTokenError::StaleLineage)?;
        if entry.session.runtime_scope != session.runtime_scope {
            return Err(RevisionTokenError::RuntimeMismatch);
        }
        if entry.session.session_id != session.session_id
            || entry.session.transport_session_id != session.transport_session_id
        {
            return Err(RevisionTokenError::SessionMismatch);
        }
        if entry.pid != pid {
            return Err(RevisionTokenError::TargetMismatch);
        }
        let element_index = entry
            .actionable_indices
            .get(&element_id)
            .copied()
            .ok_or(RevisionTokenError::StaleElement)?;
        Ok((entry.window_id, element_index, entry.snapshot_id))
    }
}

pub fn revision_tokens() -> &'static RevisionTokenRegistry {
    static REGISTRY: OnceLock<RevisionTokenRegistry> = OnceLock::new();
    REGISTRY.get_or_init(RevisionTokenRegistry::new)
}

pub fn revision_token_for(lineage_id: &str, element_id: u64) -> String {
    format!("{REVISION_TOKEN_PREFIX}{lineage_id}:{element_id:x}")
}

pub fn is_revision_token(token: &str) -> bool {
    token.starts_with(REVISION_TOKEN_PREFIX)
}

fn parse_revision_token(token: &str) -> Result<(&str, u64), RevisionTokenError> {
    let rest = token
        .strip_prefix(REVISION_TOKEN_PREFIX)
        .ok_or(RevisionTokenError::InvalidFormat)?;
    let (lineage_id, element_id) = rest
        .rsplit_once(':')
        .ok_or(RevisionTokenError::InvalidFormat)?;
    if lineage_id.is_empty() || element_id.is_empty() {
        return Err(RevisionTokenError::InvalidFormat);
    }
    let element_id =
        u64::from_str_radix(element_id, 16).map_err(|_| RevisionTokenError::InvalidFormat)?;
    Ok((lineage_id, element_id))
}

#[derive(Clone)]
struct StoredNode<I> {
    identity: I,
    rendered: RevisionNode,
}

#[derive(Clone)]
struct StoredRevision<I> {
    revision_id: String,
    nodes: Vec<StoredNode<I>>,
}

pub struct ObservationLineage<I> {
    lineage_id: String,
    max_revisions: usize,
    next_revision_id: u64,
    next_element_id: u64,
    revisions: VecDeque<StoredRevision<I>>,
}

impl<I> ObservationLineage<I>
where
    I: Clone + Eq + Hash,
{
    pub fn new(
        lineage_id: impl Into<String>,
        max_revisions: usize,
    ) -> Result<Self, ObservationRevisionError> {
        let lineage_id = lineage_id.into();
        if lineage_id.trim().is_empty() {
            return Err(ObservationRevisionError::EmptyLineageId);
        }
        if max_revisions == 0 {
            return Err(ObservationRevisionError::InvalidRetention);
        }
        Ok(Self {
            lineage_id,
            max_revisions,
            next_revision_id: 1,
            next_element_id: 0,
            revisions: VecDeque::new(),
        })
    }

    pub fn observe(
        &mut self,
        captured: Vec<CapturedNode<I>>,
        base_revision_id: Option<&str>,
        force_full: bool,
    ) -> Result<ObservationRevisionResult, ObservationRevisionError> {
        self.observe_inner(
            captured,
            base_revision_id,
            force_full.then_some(FullResyncReason::Requested),
            true,
            true,
        )
    }

    pub fn observe_with_reason(
        &mut self,
        captured: Vec<CapturedNode<I>>,
        base_revision_id: Option<&str>,
        force_full_reason: Option<FullResyncReason>,
    ) -> Result<ObservationRevisionResult, ObservationRevisionError> {
        self.observe_inner(captured, base_revision_id, force_full_reason, true, true)
    }

    pub fn observe_unretained_full(
        &mut self,
        captured: Vec<CapturedNode<I>>,
        reason: FullResyncReason,
    ) -> Result<ObservationRevisionResult, ObservationRevisionError> {
        self.observe_inner(captured, None, Some(reason), false, false)
    }

    fn observe_inner(
        &mut self,
        captured: Vec<CapturedNode<I>>,
        base_revision_id: Option<&str>,
        force_full_reason: Option<FullResyncReason>,
        stable_element_ids: bool,
        retain: bool,
    ) -> Result<ObservationRevisionResult, ObservationRevisionError> {
        let serializer_started = std::time::Instant::now();
        if stable_element_ids || retain {
            ensure_unique_identities(&captured)?;
        }

        let latest = self.revisions.back();
        let previous_ids = latest
            .map(|revision| {
                revision
                    .nodes
                    .iter()
                    .map(|node| (&node.identity, node.rendered.element_id))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        let mut depth_stack: Vec<Option<u64>> = Vec::new();
        let mut stored_nodes = Vec::with_capacity(captured.len());
        for (order, node) in captured.into_iter().enumerate() {
            let element_id = previous_ids
                .get(&node.identity)
                .copied()
                .unwrap_or_else(|| {
                    let id = self.next_element_id;
                    self.next_element_id += 1;
                    id
                });
            let parent_id = depth_stack.iter().take(node.depth).rev().find_map(|id| *id);
            if depth_stack.len() <= node.depth {
                depth_stack.resize(node.depth + 1, None);
            } else {
                depth_stack.truncate(node.depth + 1);
            }
            depth_stack[node.depth] = Some(element_id);
            stored_nodes.push(StoredNode {
                identity: node.identity,
                rendered: RevisionNode {
                    element_id,
                    order,
                    depth: node.depth,
                    parent_id,
                    body: node.body,
                    actionable_index: node.actionable_index,
                },
            });
        }

        let revision_id = format!("{}:r{}", self.lineage_id, self.next_revision_id);
        self.next_revision_id += 1;
        let current = StoredRevision {
            revision_id: revision_id.clone(),
            nodes: stored_nodes,
        };
        let full_text = render_full(&current.nodes, &self.lineage_id, stable_element_ids);

        let requested_base = base_revision_id.and_then(|id| {
            self.revisions
                .iter()
                .find(|revision| revision.revision_id == id)
        });
        let missing_reason = if base_revision_id.is_none() {
            Some(FullResyncReason::MissingBase)
        } else if requested_base.is_none() {
            Some(FullResyncReason::BaseEvicted)
        } else {
            None
        };

        let (mode, actual_base, full_resync_reason, text) = if let Some(reason) = force_full_reason
        {
            (ObservationMode::Full, None, Some(reason), full_text.clone())
        } else if let Some(reason) = missing_reason {
            (ObservationMode::Full, None, Some(reason), full_text.clone())
        } else {
            let base = requested_base.expect("checked above");
            let changes = ChangeSet::between(base, &current);
            if changes.is_empty() {
                let candidate = render_no_change(&base.revision_id);
                if candidate.len() >= full_text.len() {
                    (
                        ObservationMode::Full,
                        None,
                        Some(FullResyncReason::DiffNotSmaller),
                        full_text.clone(),
                    )
                } else {
                    (
                        ObservationMode::NoChange,
                        Some(base.revision_id.clone()),
                        None,
                        candidate,
                    )
                }
            } else {
                let candidate =
                    changes.render(base, &current, &self.lineage_id, stable_element_ids);
                if !changes.replays_to(base, &current) {
                    (
                        ObservationMode::Full,
                        None,
                        Some(FullResyncReason::ValidationFailed),
                        full_text.clone(),
                    )
                } else if candidate.len() >= full_text.len() {
                    (
                        ObservationMode::Full,
                        None,
                        Some(FullResyncReason::DiffNotSmaller),
                        full_text.clone(),
                    )
                } else {
                    (
                        ObservationMode::Diff,
                        Some(base.revision_id.clone()),
                        None,
                        candidate,
                    )
                }
            }
        };

        let nodes = current
            .nodes
            .iter()
            .map(|node| node.rendered.clone())
            .collect();
        if retain {
            self.revisions.push_back(current);
            while self.revisions.len() > self.max_revisions {
                self.revisions.pop_front();
            }
        }

        let cache_estimate_bytes = if retain {
            self.retained_cache_estimate_bytes()
        } else {
            0
        };
        let serializer_duration_us =
            u64::try_from(serializer_started.elapsed().as_micros()).unwrap_or(u64::MAX);

        Ok(ObservationRevisionResult {
            lineage_id: self.lineage_id.clone(),
            revision_id,
            base_revision_id: actual_base,
            mode,
            full_resync_reason,
            stable_element_ids,
            text,
            full_text,
            nodes,
            serializer_duration_us,
            cache_estimate_bytes,
        })
    }

    fn retained_cache_estimate_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.lineage_id.capacity()
            + self
                .revisions
                .iter()
                .map(|revision| {
                    std::mem::size_of::<StoredRevision<I>>()
                        + revision.revision_id.capacity()
                        + revision.nodes.capacity() * std::mem::size_of::<StoredNode<I>>()
                        + revision
                            .nodes
                            .iter()
                            .map(|node| node.rendered.body.capacity())
                            .sum::<usize>()
                })
                .sum::<usize>()
    }

    pub fn retained_revision_count(&self) -> usize {
        self.revisions.len()
    }

    pub fn lineage_id(&self) -> &str {
        &self.lineage_id
    }

    pub fn resolve_current(&self, element_id: u64) -> Option<(&I, &RevisionNode)> {
        self.revisions
            .back()?
            .nodes
            .iter()
            .find(|node| node.rendered.element_id == element_id)
            .map(|node| (&node.identity, &node.rendered))
    }
}

fn ensure_unique_identities<I>(captured: &[CapturedNode<I>]) -> Result<(), ObservationRevisionError>
where
    I: Eq + Hash,
{
    let mut seen = HashSet::with_capacity(captured.len());
    if captured.iter().any(|node| !seen.insert(&node.identity)) {
        return Err(ObservationRevisionError::DuplicateIdentity);
    }
    Ok(())
}

#[derive(Default)]
struct ChangeSet {
    added: HashSet<u64>,
    removed: HashSet<u64>,
    updated: HashSet<u64>,
    context: HashSet<u64>,
    affected_at: HashMap<usize, u64>,
}

impl ChangeSet {
    fn between<I>(base: &StoredRevision<I>, current: &StoredRevision<I>) -> Self {
        let before = node_map(&base.nodes);
        let after = node_map(&current.nodes);
        let before_ids = before.keys().copied().collect::<HashSet<_>>();
        let after_ids = after.keys().copied().collect::<HashSet<_>>();
        let added: HashSet<u64> = after_ids.difference(&before_ids).copied().collect();
        let removed: HashSet<u64> = before_ids.difference(&after_ids).copied().collect();
        let mut updated = before_ids
            .intersection(&after_ids)
            .filter_map(|id| {
                let old = before[id];
                let new = after[id];
                (old.body != new.body
                    || old.depth != new.depth
                    || old.parent_id != new.parent_id
                    || old.actionable_index.is_some() != new.actionable_index.is_some())
                .then_some(*id)
            })
            .collect::<HashSet<_>>();

        for id in reordered_ids(base, current, &before_ids, &after_ids) {
            updated.insert(id);
        }

        let mut context = HashSet::new();
        for id in added.iter().chain(updated.iter()) {
            add_current_ancestors(*id, &after, &added, &updated, &mut context);
        }
        for id in &removed {
            let mut parent = before[id].parent_id;
            while let Some(parent_id) = parent {
                if after.contains_key(&parent_id)
                    && !added.contains(&parent_id)
                    && !updated.contains(&parent_id)
                {
                    context.insert(parent_id);
                }
                parent = before.get(&parent_id).and_then(|node| node.parent_id);
            }
        }

        let affected_at = current
            .nodes
            .iter()
            .filter(|node| {
                added.contains(&node.rendered.element_id)
                    || updated.contains(&node.rendered.element_id)
            })
            .map(|node| (node.rendered.order, node.rendered.element_id))
            .collect();

        Self {
            added,
            removed,
            updated,
            context,
            affected_at,
        }
    }

    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    fn replays_to<I>(&self, base: &StoredRevision<I>, current: &StoredRevision<I>) -> bool {
        let mut replay = node_map(&base.nodes)
            .into_iter()
            .map(|(id, node)| (id, node.clone()))
            .collect::<HashMap<_, _>>();
        let current_map = node_map(&current.nodes);
        for id in &self.removed {
            replay.remove(id);
        }
        for id in self.added.iter().chain(self.updated.iter()) {
            if let Some(node) = current_map.get(id) {
                replay.insert(*id, (**node).clone());
            }
        }
        if replay.len() != current_map.len()
            || replay.iter().any(|(id, replayed)| {
                current_map
                    .get(id)
                    .is_none_or(|current| !same_rendered_node(replayed, current))
            })
        {
            return false;
        }

        let mut unaffected = base
            .nodes
            .iter()
            .map(|node| node.rendered.element_id)
            .filter(|id| {
                !self.removed.contains(id) && !self.added.contains(id) && !self.updated.contains(id)
            });
        let mut replayed_order = Vec::with_capacity(current.nodes.len());
        for order in 0..current.nodes.len() {
            if let Some(id) = self.affected_at.get(&order) {
                replayed_order.push(*id);
            } else if let Some(id) = unaffected.next() {
                replayed_order.push(id);
            } else {
                return false;
            }
        }
        unaffected.next().is_none()
            && replayed_order
                == current
                    .nodes
                    .iter()
                    .map(|node| node.rendered.element_id)
                    .collect::<Vec<_>>()
    }

    fn render<I>(
        &self,
        base: &StoredRevision<I>,
        current: &StoredRevision<I>,
        lineage_id: &str,
        stable_element_ids: bool,
    ) -> String {
        let mut sections = vec![format!(
            "Accessibility diff from revision {}:",
            base.revision_id
        )];
        if !self.context.is_empty() {
            sections.push(render_current_section(
                "CONTEXT",
                ' ',
                &current.nodes,
                &self.context,
                lineage_id,
                stable_element_ids,
            ));
        }
        if !self.added.is_empty() {
            sections.push(render_current_section(
                "ADDED",
                '+',
                &current.nodes,
                &self.added,
                lineage_id,
                stable_element_ids,
            ));
        }
        if !self.updated.is_empty() {
            sections.push(render_current_section(
                "CHANGED",
                '~',
                &current.nodes,
                &self.updated,
                lineage_id,
                stable_element_ids,
            ));
        }
        if !self.removed.is_empty() {
            sections.push(render_current_section(
                "REMOVED",
                '-',
                &base.nodes,
                &self.removed,
                lineage_id,
                false,
            ));
        }
        sections.join("\n")
    }
}

fn node_map<I>(nodes: &[StoredNode<I>]) -> HashMap<u64, &RevisionNode> {
    nodes
        .iter()
        .map(|node| (node.rendered.element_id, &node.rendered))
        .collect()
}

fn same_rendered_node(left: &RevisionNode, right: &RevisionNode) -> bool {
    left.element_id == right.element_id
        && left.depth == right.depth
        && left.parent_id == right.parent_id
        && left.body == right.body
        && left.actionable_index.is_some() == right.actionable_index.is_some()
}

fn reordered_ids<I>(
    base: &StoredRevision<I>,
    current: &StoredRevision<I>,
    before_ids: &HashSet<u64>,
    after_ids: &HashSet<u64>,
) -> HashSet<u64> {
    let common = before_ids
        .intersection(after_ids)
        .copied()
        .collect::<HashSet<_>>();
    let base_groups = sibling_groups(&base.nodes, &common);
    let current_groups = sibling_groups(&current.nodes, &common);
    let mut reordered = HashSet::new();
    for (parent, current_ids) in current_groups {
        if let Some(base_ids) = base_groups.get(&parent) {
            let base_set = base_ids.iter().copied().collect::<HashSet<_>>();
            let current_set = current_ids.iter().copied().collect::<HashSet<_>>();
            let same_parent = base_set
                .intersection(&current_set)
                .copied()
                .collect::<HashSet<_>>();
            let base_order = base_ids
                .iter()
                .filter(|id| same_parent.contains(id))
                .copied()
                .collect::<Vec<_>>();
            let current_order = current_ids
                .iter()
                .filter(|id| same_parent.contains(id))
                .copied()
                .collect::<Vec<_>>();
            if base_order != current_order {
                let retained = longest_ordered_subsequence(&base_order, &current_order);
                reordered.extend(same_parent.difference(&retained).copied());
            }
        }
    }
    reordered
}

fn longest_ordered_subsequence(base: &[u64], current: &[u64]) -> HashSet<u64> {
    let positions = base
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<HashMap<_, _>>();
    let sequence = current
        .iter()
        .filter_map(|id| positions.get(id).map(|position| (*id, *position)))
        .collect::<Vec<_>>();
    if sequence.is_empty() {
        return HashSet::new();
    }

    let mut lengths = vec![1usize; sequence.len()];
    let mut previous = vec![None; sequence.len()];
    for index in 0..sequence.len() {
        for candidate in 0..index {
            if sequence[candidate].1 < sequence[index].1 && lengths[candidate] + 1 > lengths[index]
            {
                lengths[index] = lengths[candidate] + 1;
                previous[index] = Some(candidate);
            }
        }
    }
    let mut cursor = lengths
        .iter()
        .enumerate()
        .max_by_key(|(index, length)| (**length, std::cmp::Reverse(*index)))
        .map(|(index, _)| index);
    let mut retained = HashSet::new();
    while let Some(index) = cursor {
        retained.insert(sequence[index].0);
        cursor = previous[index];
    }
    retained
}

fn sibling_groups<I>(
    nodes: &[StoredNode<I>],
    included: &HashSet<u64>,
) -> HashMap<Option<u64>, Vec<u64>> {
    let mut groups = HashMap::<Option<u64>, Vec<u64>>::new();
    for node in nodes {
        if included.contains(&node.rendered.element_id) {
            groups
                .entry(node.rendered.parent_id)
                .or_default()
                .push(node.rendered.element_id);
        }
    }
    groups
}

fn add_current_ancestors(
    id: u64,
    current: &HashMap<u64, &RevisionNode>,
    added: &HashSet<u64>,
    updated: &HashSet<u64>,
    context: &mut HashSet<u64>,
) {
    let mut parent = current.get(&id).and_then(|node| node.parent_id);
    while let Some(parent_id) = parent {
        if !added.contains(&parent_id) && !updated.contains(&parent_id) {
            context.insert(parent_id);
        }
        parent = current.get(&parent_id).and_then(|node| node.parent_id);
    }
}

fn render_full<I>(nodes: &[StoredNode<I>], lineage_id: &str, stable_element_ids: bool) -> String {
    if nodes.is_empty() {
        return "Full accessibility state: no elements.".to_owned();
    }
    let lines = nodes
        .iter()
        .map(|node| render_node(' ', &node.rendered, lineage_id, stable_element_ids))
        .collect::<Vec<_>>()
        .join("\n");
    format!("Full accessibility state:\n{lines}")
}

fn render_no_change(base_revision_id: &str) -> String {
    format!("Accessibility tree unchanged from revision {base_revision_id}.")
}

fn render_current_section<I>(
    title: &str,
    marker: char,
    nodes: &[StoredNode<I>],
    included: &HashSet<u64>,
    lineage_id: &str,
    stable_element_ids: bool,
) -> String {
    let lines = nodes
        .iter()
        .filter(|node| included.contains(&node.rendered.element_id))
        .map(|node| render_node(marker, &node.rendered, lineage_id, stable_element_ids))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{title}\n{lines}")
}

fn render_node(
    marker: char,
    node: &RevisionNode,
    lineage_id: &str,
    stable_element_ids: bool,
) -> String {
    let mut rendered = format!(
        "{marker}{}[{}] {}",
        "  ".repeat(node.depth),
        node.element_id,
        node.body
    );
    if stable_element_ids && node.actionable_index.is_some() {
        rendered.push_str(" element_token=");
        rendered.push_str(&revision_token_for(lineage_id, node.element_id));
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(
        identity: &'static str,
        depth: usize,
        body: &str,
        actionable_index: Option<usize>,
    ) -> CapturedNode<&'static str> {
        CapturedNode {
            identity,
            depth,
            body: body.to_owned(),
            actionable_index,
        }
    }

    fn lineage(retention: usize) -> ObservationLineage<&'static str> {
        ObservationLineage::new("lineage", retention).unwrap()
    }

    #[test]
    fn revision_request_is_versioned_and_closed() {
        let request = parse_observation_revision_request(Some(&serde_json::json!({
            "version": 1,
            "serializer_version": ACCESSIBILITY_SERIALIZER_VERSION,
            "projection_version": ACCESSIBILITY_PROJECTION_VERSION,
            "base_revision_id": "lineage:r1",
            "force_full": true
        })))
        .unwrap()
        .unwrap();
        assert_eq!(request.version, 1);
        assert_eq!(request.serializer_version, ACCESSIBILITY_SERIALIZER_VERSION);
        assert_eq!(request.projection_version, ACCESSIBILITY_PROJECTION_VERSION);
        assert_eq!(request.base_revision_id.as_deref(), Some("lineage:r1"));
        assert!(request.force_full);

        assert!(parse_observation_revision_request(Some(&serde_json::json!({
            "version": 2
        })))
        .is_err());
        assert!(parse_observation_revision_request(Some(&serde_json::json!({
            "version": 1,
            "serializer_version": ACCESSIBILITY_SERIALIZER_VERSION,
            "projection_version": ACCESSIBILITY_PROJECTION_VERSION,
            "unexpected": true
        })))
        .is_err());

        let serializer_changed = parse_observation_revision_request(Some(&serde_json::json!({
            "version": 1,
            "serializer_version": "accessibility-render-v0",
            "projection_version": ACCESSIBILITY_PROJECTION_VERSION
        })))
        .unwrap()
        .unwrap();
        assert_eq!(
            requested_format_resync_reason(&serializer_changed),
            Some(FullResyncReason::SerializerChanged)
        );

        let projection_changed = parse_observation_revision_request(Some(&serde_json::json!({
            "version": 1,
            "serializer_version": ACCESSIBILITY_SERIALIZER_VERSION,
            "projection_version": "full-tree-v0"
        })))
        .unwrap()
        .unwrap();
        assert_eq!(
            requested_format_resync_reason(&projection_changed),
            Some(FullResyncReason::ProjectionChanged)
        );
    }

    fn padded(mut changing: Vec<CapturedNode<&'static str>>) -> Vec<CapturedNode<&'static str>> {
        const IDENTITIES: [&str; 12] = [
            "pad-0", "pad-1", "pad-2", "pad-3", "pad-4", "pad-5", "pad-6", "pad-7", "pad-8",
            "pad-9", "pad-10", "pad-11",
        ];
        let mut nodes = vec![node("root", 0, "window stable fixture", None)];
        nodes.append(&mut changing);
        nodes.extend(IDENTITIES.map(|identity| {
            node(
                identity,
                1,
                "unchanged fixture element with deterministic state",
                None,
            )
        }));
        nodes
    }

    #[test]
    fn first_observation_is_full_and_assigns_stable_ids() {
        let mut lineage = lineage(4);
        let result = lineage
            .observe(
                vec![
                    node("root", 0, "window", None),
                    node("field", 1, "text value=one", Some(0)),
                ],
                None,
                false,
            )
            .unwrap();

        assert_eq!(result.mode, ObservationMode::Full);
        assert_eq!(
            result.full_resync_reason,
            Some(FullResyncReason::MissingBase)
        );
        assert_eq!(result.nodes[0].element_id, 0);
        assert_eq!(result.nodes[1].element_id, 1);
        assert_eq!(result.nodes[1].parent_id, Some(0));
        assert!(result.stable_element_ids);
        assert!(result.cache_estimate_bytes > 0);
        assert!(
            result.text.contains("element_token=rv1:lineage:1"),
            "actionable rows must expose their stable revision token"
        );
    }

    #[test]
    fn unchanged_observation_names_the_requested_base() {
        let mut lineage = lineage(4);
        let first = lineage.observe(padded(Vec::new()), None, false).unwrap();
        let second = lineage
            .observe(padded(Vec::new()), Some(&first.revision_id), false)
            .unwrap();

        assert_eq!(second.mode, ObservationMode::NoChange);
        assert_eq!(
            second.base_revision_id.as_deref(),
            Some(first.revision_id.as_str())
        );
        assert_eq!(second.nodes[0].element_id, first.nodes[0].element_id);
    }

    #[test]
    fn no_change_larger_than_full_falls_back_to_full() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(vec![node("root", 0, "x", None)], None, false)
            .unwrap();
        let second = lineage
            .observe(
                vec![node("root", 0, "x", None)],
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Full);
        assert_eq!(
            second.full_resync_reason,
            Some(FullResyncReason::DiffNotSmaller)
        );
        assert_eq!(second.text, second.full_text);
    }

    #[test]
    fn rename_is_an_update_with_the_same_id() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![node("button", 1, "button old", Some(0))]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![node("button", 1, "button new", Some(0))]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert_eq!(second.nodes[1].element_id, first.nodes[1].element_id);
        assert!(second.text.contains("CHANGED"));
        assert!(!second.text.contains("REMOVED"));
    }

    #[test]
    fn inserting_duplicate_sibling_does_not_renumber_existing_nodes() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![
                    node("a", 1, "button same", Some(0)),
                    node("b", 1, "button same", Some(1)),
                ]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![
                    node("new", 1, "button same", Some(0)),
                    node("a", 1, "button same", Some(1)),
                    node("b", 1, "button same", Some(2)),
                ]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert_eq!(second.nodes[2].element_id, first.nodes[1].element_id);
        assert_eq!(second.nodes[3].element_id, first.nodes[2].element_id);
        assert!(second.nodes[1].element_id > first.nodes[2].element_id);
        assert!(!second.text.contains("CHANGED"));
        assert!(second.text.contains("ADDED"));
    }

    #[test]
    fn recreated_lookalike_gets_a_new_id() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![node("old", 1, "button same", Some(0))]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![node("new", 1, "button same", Some(0))]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert_ne!(second.nodes[1].element_id, first.nodes[1].element_id);
        assert!(second.text.contains("ADDED"));
        assert!(second.text.contains("REMOVED"));
    }

    #[test]
    fn insertion_only_does_not_mark_common_siblings_as_reordered() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![node("a", 1, "a", None), node("b", 1, "b", None)]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![
                    node("new", 1, "new", None),
                    node("a", 1, "a", None),
                    node("b", 1, "b", None),
                ]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert!(!second.text.contains("CHANGED"));
    }

    #[test]
    fn reordering_common_siblings_marks_them_changed() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![node("a", 1, "a", None), node("b", 1, "b", None)]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![node("b", 1, "b", None), node("a", 1, "a", None)]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert!(second.text.contains("CHANGED"));
    }

    #[test]
    fn reparent_keeps_identity_and_marks_the_node_changed() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![
                    node("parent-a", 1, "group a", None),
                    node("moving", 2, "button moving", Some(0)),
                    node("parent-b", 1, "group b", None),
                ]),
                None,
                false,
            )
            .unwrap();
        let moving_id = first
            .nodes
            .iter()
            .find(|node| node.body == "button moving")
            .unwrap()
            .element_id;
        let second = lineage
            .observe(
                padded(vec![
                    node("parent-a", 1, "group a", None),
                    node("parent-b", 1, "group b", None),
                    node("moving", 2, "button moving", Some(0)),
                ]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();
        let moved = second
            .nodes
            .iter()
            .find(|node| node.body == "button moving")
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        assert_eq!(moved.element_id, moving_id);
        assert!(second.text.contains("CHANGED"));
    }

    #[test]
    fn current_action_index_can_change_without_a_model_visible_update() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![node("button", 1, "button stable", Some(0))]),
                None,
                false,
            )
            .unwrap();
        let second = lineage
            .observe(
                padded(vec![node("button", 1, "button stable", Some(7))]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::NoChange);
        assert_eq!(second.nodes[1].actionable_index, Some(7));
        assert_eq!(second.nodes[1].element_id, first.nodes[1].element_id);
    }

    #[test]
    fn candidate_larger_than_full_falls_back_to_full() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(vec![node("button", 0, "old", Some(0))], None, false)
            .unwrap();
        let second = lineage
            .observe(
                vec![node("button", 0, "new", Some(0))],
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Full);
        assert_eq!(
            second.full_resync_reason,
            Some(FullResyncReason::DiffNotSmaller)
        );
    }

    #[test]
    fn can_diff_from_an_older_retained_model_base() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(padded(vec![node("a", 1, "value=one", None)]), None, false)
            .unwrap();
        let _undelivered = lineage
            .observe(
                padded(vec![node("a", 1, "value=two", None)]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();
        let third = lineage
            .observe(
                padded(vec![node("a", 1, "value=three", None)]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(third.mode, ObservationMode::Diff);
        assert_eq!(
            third.base_revision_id.as_deref(),
            Some(first.revision_id.as_str())
        );
    }

    #[test]
    fn evicted_base_forces_full() {
        let mut lineage = lineage(1);
        let first = lineage
            .observe(vec![node("a", 0, "one", None)], None, false)
            .unwrap();
        let _second = lineage
            .observe(
                vec![node("a", 0, "two", None)],
                Some(&first.revision_id),
                false,
            )
            .unwrap();
        let third = lineage
            .observe(
                vec![node("a", 0, "three", None)],
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(third.mode, ObservationMode::Full);
        assert_eq!(
            third.full_resync_reason,
            Some(FullResyncReason::BaseEvicted)
        );
    }

    #[test]
    fn explicit_full_becomes_a_retained_revision() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(padded(vec![node("a", 1, "one", None)]), None, false)
            .unwrap();
        let full = lineage
            .observe(
                padded(vec![node("a", 1, "two", None)]),
                Some(&first.revision_id),
                true,
            )
            .unwrap();
        let third = lineage
            .observe(
                padded(vec![node("a", 1, "two", None)]),
                Some(&full.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(full.mode, ObservationMode::Full);
        assert_eq!(full.full_resync_reason, Some(FullResyncReason::Requested));
        assert_eq!(third.mode, ObservationMode::NoChange);
    }

    #[test]
    fn platform_full_reason_is_preserved() {
        let mut lineage = lineage(4);
        let result = lineage
            .observe_with_reason(
                vec![node("a", 0, "one", None)],
                None,
                Some(FullResyncReason::CaptureIncomplete),
            )
            .unwrap();

        assert_eq!(result.mode, ObservationMode::Full);
        assert_eq!(
            result.full_resync_reason,
            Some(FullResyncReason::CaptureIncomplete)
        );
    }

    #[test]
    fn incomplete_capture_is_unretained_and_has_no_stable_tokens() {
        let mut lineage = lineage(4);
        let result = lineage
            .observe_unretained_full(
                vec![node("button", 0, "button", Some(0))],
                FullResyncReason::CaptureIncomplete,
            )
            .unwrap();

        assert_eq!(result.mode, ObservationMode::Full);
        assert!(!result.stable_element_ids);
        assert_eq!(result.cache_estimate_bytes, 0);
        assert!(!result.text.contains("element_token="));
        assert_eq!(lineage.retained_revision_count(), 0);
    }

    #[test]
    fn current_resolution_survives_unrelated_diff_and_rejects_removal() {
        let mut lineage = lineage(4);
        let first = lineage
            .observe(
                padded(vec![
                    node("button", 1, "button stable", Some(0)),
                    node("field", 1, "value=one", Some(1)),
                ]),
                None,
                false,
            )
            .unwrap();
        let button_id = first.nodes[1].element_id;
        let second = lineage
            .observe(
                padded(vec![
                    node("button", 1, "button stable", Some(7)),
                    node("field", 1, "value=two", Some(8)),
                ]),
                Some(&first.revision_id),
                false,
            )
            .unwrap();

        assert_eq!(second.mode, ObservationMode::Diff);
        let (identity, current) = lineage.resolve_current(button_id).unwrap();
        assert_eq!(*identity, "button");
        assert_eq!(current.actionable_index, Some(7));

        lineage
            .observe(
                padded(vec![node("field", 1, "value=two", Some(0))]),
                Some(&second.revision_id),
                false,
            )
            .unwrap();
        assert!(lineage.resolve_current(button_id).is_none());
    }

    fn session(runtime: &str, session: &str, transport: &str) -> ObservationSessionIdentity {
        ObservationSessionIdentity {
            runtime_scope: runtime.to_owned(),
            session_id: session.to_owned(),
            transport_session_id: transport.to_owned(),
        }
    }

    #[test]
    fn revision_token_tracks_the_current_action_index() {
        let registry = RevisionTokenRegistry::new();
        let owner = session("runtime-a", "session-a", "transport-a");
        registry
            .register_for_session(
                owner.clone(),
                "lineage-a",
                42,
                7,
                10,
                HashMap::from([(3, 1)]),
            )
            .unwrap();
        let token = revision_token_for("lineage-a", 3);
        assert_eq!(
            registry.resolve_for_session(&owner, 42, &token),
            Ok((7, 1, 10))
        );

        registry
            .register_for_session(
                owner.clone(),
                "lineage-a",
                42,
                7,
                11,
                HashMap::from([(3, 9)]),
            )
            .unwrap();
        assert_eq!(
            registry.resolve_for_session(&owner, 42, &token),
            Ok((7, 9, 11))
        );

        registry
            .register_for_session(owner.clone(), "lineage-a", 42, 7, 12, HashMap::new())
            .unwrap();
        assert_eq!(
            registry.resolve_for_session(&owner, 42, &token),
            Err(RevisionTokenError::StaleElement)
        );
    }

    #[test]
    fn revision_token_is_session_runtime_and_target_scoped() {
        let registry = RevisionTokenRegistry::new();
        let owner = session("runtime-a", "session-a", "transport-a");
        registry
            .register_for_session(
                owner.clone(),
                "lineage-a",
                42,
                7,
                10,
                HashMap::from([(3, 1)]),
            )
            .unwrap();
        let token = revision_token_for("lineage-a", 3);

        assert_eq!(
            registry.resolve_for_session(
                &session("runtime-a", "session-b", "transport-b"),
                42,
                &token,
            ),
            Err(RevisionTokenError::SessionMismatch)
        );
        assert_eq!(
            registry.resolve_for_session(
                &session("runtime-b", "session-a", "transport-a"),
                42,
                &token,
            ),
            Err(RevisionTokenError::RuntimeMismatch)
        );
        assert_eq!(
            registry.resolve_for_session(&owner, 99, &token),
            Err(RevisionTokenError::TargetMismatch)
        );

        registry.clear_session("session-a");
        assert_eq!(
            registry.resolve_for_session(&owner, 42, &token),
            Err(RevisionTokenError::StaleLineage)
        );
    }

    #[test]
    fn clearing_one_lineage_does_not_invalidate_another() {
        let registry = RevisionTokenRegistry::new();
        let owner = session("runtime-a", "session-a", "transport-a");
        for lineage_id in ["lineage-a", "lineage-b"] {
            registry
                .register_for_session(
                    owner.clone(),
                    lineage_id,
                    42,
                    7,
                    10,
                    HashMap::from([(3, 1)]),
                )
                .unwrap();
        }

        registry.clear_lineage("lineage-a");

        assert_eq!(
            registry.resolve_for_session(&owner, 42, &revision_token_for("lineage-a", 3),),
            Err(RevisionTokenError::StaleLineage)
        );
        assert_eq!(
            registry.resolve_for_session(&owner, 42, &revision_token_for("lineage-b", 3),),
            Ok((7, 1, 10))
        );
    }

    #[test]
    fn duplicate_native_identity_is_rejected() {
        let mut lineage = lineage(4);
        let error = lineage
            .observe(
                vec![node("same", 0, "a", None), node("same", 0, "b", None)],
                None,
                false,
            )
            .unwrap_err();

        assert_eq!(error, ObservationRevisionError::DuplicateIdentity);
        assert_eq!(lineage.retained_revision_count(), 0);
    }

    #[test]
    fn unstable_unretained_full_can_report_duplicate_provider_nodes() {
        let mut lineage = lineage(4);
        let result = lineage
            .observe_unretained_full(
                vec![node("same", 0, "a", None), node("same", 0, "b", None)],
                FullResyncReason::IdentityUnavailable,
            )
            .unwrap();

        assert_eq!(result.mode, ObservationMode::Full);
        assert_eq!(
            result.full_resync_reason,
            Some(FullResyncReason::IdentityUnavailable)
        );
        assert!(!result.stable_element_ids);
        assert_eq!(result.nodes[0].element_id, 0);
        assert_eq!(result.nodes[1].element_id, 1);
        assert_eq!(lineage.retained_revision_count(), 0);
    }
}
