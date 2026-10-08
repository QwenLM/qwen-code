package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionCapabilities;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSessionCapabilities;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnSummary;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ManagedAgentService {
    private static final Logger LOG = LoggerFactory.getLogger(ManagedAgentService.class);
    private static final String CREATE = "CREATE_SESSION";
    private static final String SUBMIT = "SUBMIT_TURN";
    private static final String CANCEL = "CANCEL_TURN";
    private static final String RENAME = "RENAME_SESSION";
    private static final String UNARCHIVE = "UNARCHIVE_SESSION";
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile(
            "^[\\x21-\\x7e]{1,128}$");
    // A Turn cursor is the creation time and ID of the last Turn of a page.
    private static final Pattern TURN_CURSOR = Pattern.compile(
            "^(0|[1-9][0-9]{0,18}):([A-Za-z0-9_-]{1,64})$");
    private static final int TURN_ID_MAX_LENGTH = 64;
    // Catch-up reads of a stream use pages of this size.
    static final int STREAM_PAGE = 100;
    // A context stays ready until cwd changes arrive (W2).
    private static final String WORKSPACE_STATE = "ready";
    // "text" is the spelling that clients used before the contract.
    private static final Set<String> INPUT_TYPES = Set.of("input_text",
            "text");
    private final AgentStateStore store;
    private final ManagedWorkspaceRegistry workspaces;
    private final RequestDigests digests;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;
    private RuntimeWarmer runtimeWarmer;

    @Autowired(required = false)
    void setRuntimeWarmer(RuntimeWarmer runtimeWarmer) {
        this.runtimeWarmer = runtimeWarmer;
    }

    private boolean supportsClose(SessionRecord session) {
        return session.workspace() == null || store.workspaceFilesEnabled()
                && runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose()
                && harness.supportsLifecycle();
    }

    private boolean hasActions(SessionRecord session) {
        return session.workspace() != null
                && !"yolo".equals(session.approvalMode());
    }

    private BooleanSupplier artifactReadsEnabled = () -> false;

    @Autowired
    void configureArtifacts(ManagedAgentProperties properties,
            ManagedArtifactReader reader) {
        artifactReadsEnabled = () -> properties.getArtifacts().isEnabled() && reader.supported();
    }

    private boolean hasArtifacts(SessionRecord session) {
        return session.workspace() != null && !"DELETING".equals(session.status())
                && artifactReadsEnabled.getAsBoolean();
    }

    public ManagedAgentService(AgentStateStore store,
            RequestDigests digests, HarnessCoordinator coordinator,
            HarnessConnector harness, ManagedWorkspaceRegistry workspaces) {
        this.store = store;
        this.workspaces = workspaces;
        this.digests = digests;
        this.coordinator = coordinator;
        this.harness = harness;
    }

    public CommandAdmission createSession(String tenantId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        return createSession(tenantId, null, idempotencyKey, agentId,
                agentRevision, title, metadata, blocks);
    }

    public CommandAdmission createSession(String tenantId, String actorId,
            String idempotencyKey, String agentId, String agentRevision,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = input(blocks, false);
        if (!input.isEmpty()) {
            requireHarness();
        }
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
        if (agentRevision != null) {
            semantic.put("agentRevision", agentRevision);
        }
        semantic.put("title", effectiveTitle);
        semantic.put("input", input);
        String requestDigest = digests.digest(semantic);
        Admission replay = replay(tenantId, CREATE, idempotencyKey,
                requestDigest);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        String payloadDigest = input.isEmpty() ? null
                : SubmitHarnessTurn.computePayloadDigest(input);
        Admission admission;
        try {
            admission = store.insertSessionCommand(tenantId, actorId, CREATE,
                    idempotencyKey, requestDigest, agentId, agentRevision,
                    effectiveTitle, input, payloadDigest);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CREATE,
                    idempotencyKey, requestDigest);
        }
        dispatch(tenantId, admission);
        return response(admission);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String agentRevision, String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection) {
        validateIdempotencyKey(idempotencyKey);
        if (actorId == null || actorId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED,
                    "actor_required", "A trusted actor is required.");
        }
        List<Map<String, Object>> input = input(blocks, false);
        if (!input.isEmpty() && !harness.isWorkspaceFilesAvailable()) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
        if (agentRevision != null) {
            semantic.put("agentRevision", agentRevision);
        }
        semantic.put("title", effectiveTitle);
        semantic.put("input", input);
        semantic.put("workspace", selection == null
                ? Map.of("default", true)
                : Map.of("workspaceId", selection.workspaceId(),
                        "cwdRelative", selection.cwdRelative()));
        String requestDigest = digests.digest(semantic);
        String payloadDigest = input.isEmpty() ? null
                : SubmitHarnessTurn.computePayloadDigest(input);
        Admission admission;
        try {
            admission = store.insertWorkspaceSessionCommand(tenantId,
                    actorId, idempotencyKey, requestDigest, agentId,
                    agentRevision, effectiveTitle, input, payloadDigest,
                    selection);
        } catch (DuplicateKeyException error) {
            admission = store.replayWorkspaceSessionCommand(tenantId,
                    actorId, idempotencyKey, requestDigest);
        }
        dispatch(tenantId, admission);
        return response(admission);
    }

    public CommandAdmission submitTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId,
            List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        requireSubmitter(tenantId, actorId, sessionId);
        requireHarness();
        List<Map<String, Object>> input = input(blocks, true);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "input", input));
        Admission replay = replay(tenantId, SUBMIT, idempotencyKey,
                requestDigest);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        String payloadDigest = SubmitHarnessTurn.computePayloadDigest(input);
        Admission admission;
        try {
            admission = store.insertTurnCommand(tenantId, SUBMIT,
                    idempotencyKey, requestDigest, sessionId, input,
                    payloadDigest);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, SUBMIT,
                    idempotencyKey, requestDigest);
        }
        dispatch(tenantId, admission);
        return response(admission);
    }

    public CommandAdmission cancelTurn(String tenantId, String actorId,
            String idempotencyKey, String sessionId, String turnId) {
        validateIdempotencyKey(idempotencyKey);
        requireSubmitter(tenantId, actorId, sessionId);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "turnId", turnId));
        Admission replay = replay(tenantId, CANCEL, idempotencyKey,
                requestDigest);
        if (replay != null) {
            dispatch(tenantId, replay);
            return response(replay);
        }
        Admission admission;
        try {
            admission = store.insertCancelCommand(tenantId, CANCEL,
                    idempotencyKey, requestDigest, sessionId, turnId);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CANCEL,
                    idempotencyKey, requestDigest);
        }
        if (admission.commandEffect()) {
            coordinator.cancel(tenantId, admission.sessionId(),
                    admission.turnId());
        } else {
            dispatch(tenantId, admission);
        }
        return response(admission);
    }

    public SessionMutationResult<PublicSession> renameSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId,
            String title) {
        validateIdempotencyKey(idempotencyKey);
        requireSubmitter(tenantId, actorId, sessionId);
        String effectiveTitle = validRenameTitle(title);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "title", effectiveTitle));
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                RENAME, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.RENAME);
        if (!"COMPLETED".equals(command.status())) {
            try {
                requireHarness();
                SessionRecord session = store.requireSession(tenantId, sessionId);
                HarnessConnector.Attachment attachment = harness.createOrLoad(tenantId, sessionId,
                        session.harnessBootId() != null);
                harness.rename(tenantId, sessionId, effectiveTitle);
                session = store.completeSessionMutation(tenantId, RENAME,
                        idempotencyKey, sessionId, SessionMutationKind.RENAME,
                        effectiveTitle, attachment.bootId());
                return new SessionMutationResult<>(publicSession(session),
                        command.replayed());
            } catch (RuntimeException error) {
                try {
                    store.abandonSessionMutation(tenantId, RENAME,
                            idempotencyKey, sessionId);
                } catch (RuntimeException cleanupError) {
                    LOG.warn("Failed to retire rename tenant={} session={}",
                            tenantId, sessionId, cleanupError);
                }
                if (error instanceof ApiException failure) {
                    throw failure;
                }
                if (error instanceof RuntimeBrokerException refusal
                        && !refusal.isRetryable()) {
                    HttpStatus status = HttpStatus.resolve(
                            refusal.getStatusCode());
                    throw new ApiException(
                            status == null ? HttpStatus.CONFLICT : status,
                            refusal.getCode(), refusal.getMessage());
                }
                throw dependencyUnavailable("hosted_harness_unavailable",
                        "The Hosted Harness could not persist the Session title.");
            }
        }
        return new SessionMutationResult<>(getPublicSession(tenantId,
                sessionId), true);
    }

    // An archived Session stays closed, so unarchive needs neither the
    // Harness nor the Runtime.
    public SessionMutationResult<PublicSession> unarchiveSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        var result = unarchive(tenantId, actorId, idempotencyKey, sessionId);
        return new SessionMutationResult<>(publicSession(result.session()), result.replayed());
    }

    public SessionMutationResult<WebShellSession> unarchiveWebShellSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        var result = unarchive(tenantId, actorId, idempotencyKey, sessionId);
        return new SessionMutationResult<>(webShellSession(result.session(), actorId), result.replayed());
    }

    private StoreModels.SessionMutation unarchive(String tenantId, String actorId,
            String idempotencyKey, String sessionId) {
        validateIdempotencyKey(idempotencyKey);
        SessionRecord target = store.requireSession(tenantId, sessionId);
        if (target.workspace() != null) {
            requireReadGrant(target, actorId);
            String scopedKey = digests.digest(Map.of("sessionId", sessionId,
                    "actorDigest", digests.digest(Map.of("actorId", actorId)), "idempotencyKey", idempotencyKey));
            return store.unarchiveWorkspaceSession(tenantId, sessionId, actorId,
                    scopedKey, lifecycleDigest(sessionId, UNARCHIVE));
        }
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String requestDigest = lifecycleDigest(sessionId, UNARCHIVE);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                UNARCHIVE, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.UNARCHIVE);
        if (!"COMPLETED".equals(command.status())) {
            SessionRecord session = store.completeSessionMutation(tenantId,
                    UNARCHIVE, idempotencyKey, sessionId,
                    SessionMutationKind.UNARCHIVE, null, null);
            return new StoreModels.SessionMutation(session, command.replayed());
        }
        return new StoreModels.SessionMutation(requireVisibleSession(tenantId, sessionId), true);
    }

    private PublicSession getPublicSession(String tenantId,
            String sessionId) {
        return publicSession(requireVisibleSession(tenantId, sessionId));
    }

    public PublicSession getPublicSession(String tenantId, String actorId,
            String sessionId) {
        return publicSession(requireReadableSession(tenantId, actorId,
                sessionId));
    }

    public WebShellSession getWebShellSession(String tenantId, String actorId,
            String sessionId) {
        return webShellSession(requireReadableSession(tenantId, actorId,
                sessionId), actorId);
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String actorId, String cursor, int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new PublicList<>("list", publicSessions(page.sessions()),
                page.hasMore(), nextCursor(page));
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new WebShellPage<>(webShellSessions(page.sessions(), actorId),
                nextCursor(page), page.hasMore());
    }

    /**
     * A page of a Session's Turns, newest first. Every page checks the
     * Session again, so a cursor never outlives the caller's read access.
     */
    public PublicList<PublicTurn> listPublicTurns(String tenantId,
            String actorId, String sessionId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        TurnCursor decoded = decodeTurnCursor(cursor);
        requireReadableSession(tenantId, actorId, sessionId);
        TurnPage page = store.listTurns(tenantId, sessionId,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.turnId(), limit);
        return new PublicList<>("list", page.turns().stream()
                .map(ManagedAgentService::publicTurn).toList(),
                page.hasMore(), nextTurnCursor(page));
    }

    public PublicTurn getPublicTurn(String tenantId, String actorId,
            String sessionId, String turnId) {
        // The path schema counts characters, not UTF-16 units.
        if (turnId.codePointCount(0, turnId.length()) > TURN_ID_MAX_LENGTH) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The Turn id is invalid.");
        }
        requireReadableSession(tenantId, actorId, sessionId);
        return store.findTurnSummary(tenantId, sessionId, turnId)
                .map(ManagedAgentService::publicTurn)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "turn_not_found", "The Turn was not found."));
    }

    public PublicList<PublicEvent> publicEvents(String tenantId,
            String actorId, String sessionId, long afterSequence,
            int requestedLimit) {
        requireEventCursor(afterSequence);
        SessionRecord session = requireReadableSession(tenantId, actorId,
                sessionId);
        int limit = eventLimit(requestedLimit);
        List<EventRecord> rows = replayableEvents(session, afterSequence,
                limit + 1);
        boolean hasMore = rows.size() > limit;
        List<PublicEvent> events = rows.stream().limit(limit)
                .map(this::publicEvent).toList();
        String nextCursor = hasMore
                ? Long.toString(events.getLast().sequence()) : null;
        return new PublicList<>("list", events, hasMore, nextCursor);
    }

    public PublicItemList listPublicItems(String tenantId, String actorId,
            String sessionId, long afterSequence, int requestedLimit) {
        if (afterSequence < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor",
                    "Item sequence must be non-negative.");
        }
        int limit = limit(requestedLimit);
        requireReadableSession(tenantId, actorId, sessionId);
        SnapshotRecord snapshot = store.findSnapshot(tenantId, sessionId)
                .orElse(null);
        if (snapshot == null) {
            return new PublicItemList("list", List.of(), false, null, 0);
        }
        List<ItemRecord> matching = snapshot.items().stream()
                .filter(item -> item.firstSequence() > afterSequence)
                .toList();
        boolean hasMore = matching.size() > limit;
        List<PublicItem> items = matching.stream().limit(limit)
                .map(this::publicItem).toList();
        String nextCursor = hasMore && !items.isEmpty()
                ? Long.toString(items.get(items.size() - 1).firstSequence())
                : null;
        return new PublicItemList("list", items, hasMore, nextCursor,
                snapshot.coveredSequence());
    }

    public WebShellTranscript transcript(String tenantId, String actorId,
            String sessionId, String cursor, int requestedLimit) {
        SessionRecord session = requireReadableSession(tenantId, actorId,
                sessionId);
        int limit = eventLimit(requestedLimit);
        if (cursor == null || cursor.isBlank()) {
            SnapshotRecord snapshot = store.findSnapshot(tenantId, sessionId)
                    .orElse(null);
            if (snapshot != null) {
                long visibleSequence = Math.max(session.lastSequence(),
                        snapshot.coveredSequence());
                List<EventRecord> events = new ArrayList<>(
                        store.findControlEvents(tenantId, sessionId,
                                snapshot.coveredSequence()));
                events.addAll(tailEvents(tenantId, sessionId,
                        snapshot.coveredSequence(), visibleSequence));
                return new WebShellTranscript(snapshot.items().stream()
                        .map(this::webShellItem).toList(),
                        events.stream().map(this::webShellEvent).toList(),
                        snapshot.coveredSequence(), null, false,
                        visibleSequence);
            }
        }
        EventPage page = store.findTranscriptEvents(tenantId, sessionId,
                transcriptCursor(cursor), limit);
        List<WebShellEvent> events = page.events().stream()
                .map(this::webShellEvent).toList();
        String olderCursor = page.hasMore() && !events.isEmpty()
                ? Long.toString(events.get(0).sequence()) : null;
        return new WebShellTranscript(List.of(), events, 0, olderCursor,
                page.hasMore(), session.lastSequence());
    }

    // Events are read before the floor: a floor that is not above the cursor
    // after the read was not above it during the read either, so no event
    // after the cursor had been pruned.
    private List<EventRecord> replayableEvents(SessionRecord session,
            long afterSequence, int limit) {
        List<EventRecord> events = store.findEvents(session.tenantId(),
                session.sessionId(), afterSequence, limit);
        ReplayWindow window = store.findReplayWindow(session.tenantId(),
                session.sessionId());
        if (afterSequence < window.floorSequence()) {
            throw new ReplayCursorExpired(window);
        }
        return events;
    }

    private static void requireEventCursor(long afterSequence) {
        if (afterSequence < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor",
                    "Event sequence must be non-negative.");
        }
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<PublicSession> publicSessions(List<SessionRecord> sessions) {
        if (sessions.isEmpty()) {
            return List.of();
        }
        String tenantId = sessions.getFirst().tenantId();
        List<String> ids = sessions.stream().map(SessionRecord::sessionId)
                .toList();
        Map<String, TurnSummary> activeTurns = store.findActiveTurns(tenantId,
                ids);
        Map<String, Long> coveredSequences = store
                .findSnapshotCoveredSequences(tenantId, ids);
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        return sessions.stream()
                .map(session -> publicSession(session,
                        activeTurns.get(session.sessionId()),
                        coveredSequences.getOrDefault(session.sessionId(), 0L),
                        retention(session, closed)))
                .toList();
    }

    /** The workspace-close state of each bound Session, in one read. */
    private Set<String> completedWorkspaceCloses(String tenantId,
            List<SessionRecord> sessions) {
        List<String> bound = sessions.stream()
                .filter(session -> session.workspace() != null)
                .map(SessionRecord::sessionId).toList();
        return bound.isEmpty() ? Set.of()
                : store.completedWorkspaceCloses(tenantId, bound);
    }

    private static boolean retention(SessionRecord session,
            Set<String> closed) {
        return session.workspace() == null
                || closed.contains(session.sessionId());
    }

    private PublicSession publicSession(SessionRecord session) {
        return publicSessions(List.of(session)).getFirst();
    }

    private PublicSession publicSession(SessionRecord session,
            TurnSummary activeTurn, long snapshotCoveredSequence,
            boolean retention) {
        Map<String, Object> metadata = session.title() == null ? Map.of()
                : Map.of("title", session.title());
        return new PublicSession(
                session.sessionId(),
                "agent.session",
                session.agentId(),
                session.agentRevision(),
                session.status().toLowerCase(),
                session.createdAt() / 1000,
                session.updatedAt() / 1000,
                metadata,
                activeTurn == null ? null : publicTurn(activeTurn),
                session.lastSequence(),
                session.replayFloorSequence(),
                snapshotCoveredSequence,
                // Bound close is advertised separately from archive/delete.
                new SessionCapabilities(
                        true,
                        true,
                        hasArtifacts(session),
                        true,
                        session.workspace() == null,
                        true,
                        hasActions(session), supportsClose(session), retention, retention, supportsDelete(session, retention)),
                publicWorkspace(session));
    }

    /** A page assembled from grouped batch reads instead of per-row ones. */
    private List<WebShellSession> webShellSessions(
            List<SessionRecord> sessions, String actorId) {
        if (sessions.isEmpty()) {
            return List.of();
        }
        String tenantId = sessions.getFirst().tenantId();
        List<String> ids = sessions.stream().map(SessionRecord::sessionId)
                .toList();
        Map<String, TurnSummary> latestTurns = store.findLatestTurns(tenantId,
                ids);
        Map<String, EventRecord> environmentEvents = store
                .findLatestEnvironmentEvents(tenantId, latestTurns);
        Set<String> closed = completedWorkspaceCloses(tenantId, sessions);
        // The creator-submit capability batches its registry reads like the
        // close state: one IN query over the submit-shaped Sessions, then
        // one over the creator-owned ones' workspaces.
        Set<String> shaped = sessions.stream().filter(this::maySubmitShape)
                .map(SessionRecord::sessionId)
                .collect(java.util.stream.Collectors.toSet());
        Set<String> creatorOwns = shaped.isEmpty() ? Set.of()
                : workspaces.createdSessions(tenantId, actorId,
                        List.copyOf(shaped));
        Set<String> grantWorkspaces = creatorOwns.isEmpty() ? Set.of()
                : sessions.stream()
                        .filter(session -> creatorOwns.contains(
                                session.sessionId()))
                        .map(session -> session.workspace().getWorkspaceId())
                        .collect(java.util.stream.Collectors.toSet());
        Map<String, ManagedWorkspaceRegistry.WorkspaceSummary> grants =
                grantWorkspaces.isEmpty() ? Map.of()
                        : workspaces.findReadable(tenantId, actorId,
                                grantWorkspaces);
        return sessions.stream()
                .map(session -> webShellSession(session,
                        latestTurns.get(session.sessionId()),
                        environmentEvents.get(session.sessionId()),
                        retention(session, closed),
                        maySubmitWorkspaceTurn(session, creatorOwns, grants)))
                .toList();
    }

    private WebShellSession webShellSession(SessionRecord session,
            String actorId) {
        return webShellSessions(List.of(session), actorId).getFirst();
    }

    private WebShellSession webShellSession(SessionRecord session,
            TurnSummary latestTurn, EventRecord environmentEvent,
            boolean retention, boolean maySubmit) {
        return new WebShellSession(
                session.sessionId(),
                session.title(),
                session.agentId(),
                session.status().toLowerCase(),
                session.createdAt(),
                session.updatedAt(),
                latestTurn == null ? null : webShellTurn(latestTurn),
                webShellEnvironment(environmentEvent),
                session.lastSequence(),
                webShellWorkspace(session),
                // Every Session serves its task list and detail; the tasks come from the
                // Stage H records its Session store holds (H0c).
                new WebShellSessionCapabilities(true, hasArtifacts(session),
                        hasActions(session), maySubmit, supportsClose(session),
                        retention, retention, supportsDelete(session, retention)));
    }

    private boolean supportsDelete(SessionRecord session, boolean retention) {
        return retention || session.workspace() != null && store.workspaceFilesEnabled()
                && runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose() && harness.supportsLifecycle();
    }

    private static WebShellWorkspace webShellWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new WebShellWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        WORKSPACE_STATE);
    }

    private static PublicWorkspace publicWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new PublicWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative(),
                        session.workspace().getContextRevision(),
                        WORKSPACE_STATE);
    }

    private static Map<String, Object> webShellEnvironment(
            EventRecord event) {
        if (event == null) {
            return null;
        }
        String state = switch (event.type()) {
            case "environment.provisioning" -> "starting";
            case "environment.ready" -> "ready";
            case "environment.failed" -> "failed";
            default -> throw new IllegalStateException(
                    "Unexpected environment event: " + event.type());
        };
        Map<String, Object> environment = new LinkedHashMap<>();
        environment.put("state", state);
        Object environmentId = event.data().get("environmentId");
        if (environmentId instanceof String) {
            environment.put("environmentId", environmentId);
        }
        Object errorCode = event.data().get("code");
        if (errorCode instanceof String) {
            environment.put("errorCode", errorCode);
        }
        return Map.copyOf(environment);
    }

    private static PublicTurn publicTurn(TurnSummary turn) {
        return new PublicTurn(turn.turnId(), "agent.turn",
                turn.sessionId(), StoreModels.inputItemId(turn.turnId()),
                turn.status().toLowerCase(),
                turn.createdAt() / 1000,
                turn.completedAt() == null ? null
                        : turn.completedAt() / 1000,
                turn.errorCode());
    }

    private static WebShellTurn webShellTurn(TurnSummary turn) {
        return new WebShellTurn(turn.turnId(), turn.sessionId(),
                turn.status().toLowerCase(), turn.createdAt(),
                turn.completedAt(), turn.errorCode(), null);
    }

    PublicEvent publicEvent(EventRecord event) {
        return new PublicEvent(event.schemaVersion(),
                event.projectionVersion(), event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.itemId(),
                event.contentPartId(), event.type(), event.createdAt() / 1000,
                event.data(), event.terminal());
    }

    WebShellEvent webShellEvent(EventRecord event) {
        return new WebShellEvent(event.schemaVersion(),
                event.projectionVersion(), event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.itemId(),
                event.contentPartId(), event.type(), event.createdAt(),
                event.data(), event.terminal());
    }

    private PublicItem publicItem(ItemRecord item) {
        return new PublicItem(item.itemId(), "agent.item",
                item.sessionId(), item.turnId(), item.type(), item.role(),
                item.revision(), item.status(), item.content().stream()
                        .map(this::publicContentPart).toList(),
                item.attributes(), item.firstSequence(), item.lastSequence(),
                item.createdAt() / 1000, item.updatedAt() / 1000);
    }

    private PublicContentPart publicContentPart(ItemPartRecord part) {
        return new PublicContentPart(part.partId(), part.type(), part.text(),
                part.firstSequence(), part.lastSequence());
    }

    private WebShellItem webShellItem(ItemRecord item) {
        return new WebShellItem(item.itemId(), item.sessionId(),
                item.turnId(), item.type(), item.role(), item.status(),
                item.content().stream().map(this::webShellContentPart)
                        .toList(),
                item.attributes(), item.firstSequence(), item.lastSequence(),
                item.createdAt(), item.updatedAt());
    }

    private WebShellContentPart webShellContentPart(ItemPartRecord part) {
        return new WebShellContentPart(part.partId(), part.type(), part.text(),
                part.firstSequence(), part.lastSequence());
    }

    private List<EventRecord> tailEvents(String tenantId, String sessionId,
            long afterSequence, long throughSequence) {
        List<EventRecord> result = new ArrayList<>();
        long cursor = afterSequence;
        while (cursor < throughSequence) {
            // Paged at the snapshot gate's lag bound: a session whose
            // snapshot lags within the gate is served in one round trip.
            List<EventRecord> page = store.findEvents(tenantId, sessionId,
                    cursor, ManagedAgentStore.SNAPSHOT_REFRESH_EVENTS);
            if (page.isEmpty()) {
                break;
            }
            for (EventRecord event : page) {
                if (event.sequence() > throughSequence) {
                    return List.copyOf(result);
                }
                result.add(event);
                cursor = event.sequence();
            }
        }
        return List.copyOf(result);
    }

    private void dispatch(String tenantId, Admission admission) {
        if (admission.turnId() != null) {
            coordinator.dispatch(tenantId, admission.sessionId(),
                    admission.turnId());
        }
    }

    String lifecycleDigest(String sessionId, String operation) {
        return digests.digest(Map.of(
                "sessionId", sessionId, "operation", operation));
    }

    // Later Turns of a Workspace-bound Session run under the creator's
    // Workspace grants (WorkspaceExecutionStore.authorize), so only the
    // creator may submit or cancel them or rename the Session, and only with
    // Workspace files enabled. Everyone else keeps the existing refusal.
    private void requireSubmitter(String tenantId, String actorId,
            String sessionId) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        if (!maySubmitWorkspaceTurn(session, actorId)) {
            requireLegacyWorkspace(session, actorId);
        }
    }

    private boolean maySubmitWorkspaceTurn(SessionRecord session,
            String actorId) {
        if (!maySubmitShape(session)) {
            return false;
        }
        // createdSession precedes findReadable: it answers false for an actor
        // id the registry key cannot encode, where findReadable throws.
        if (!workspaces.createdSession(session.tenantId(), actorId,
                session.sessionId())) {
            return false;
        }
        // The caller is the Session's creator, so this reads the creator's
        // grant row, as the execution authority's join does: can_read (the
        // join's own filter) and can_create, on a registry whose state is
        // ACTIVE.
        ManagedWorkspaceRegistry.WorkspaceSummary summary =
                workspaces.findReadable(session.tenantId(), actorId,
                        session.workspace().getWorkspaceId());
        return summary != null && summary.canCreateSession();
    }

    // The page twin of the singular: the same rule answered from the batch
    // reads the assembler already made.
    private boolean maySubmitWorkspaceTurn(SessionRecord session,
            Set<String> creatorOwns,
            Map<String, ManagedWorkspaceRegistry.WorkspaceSummary> grants) {
        if (!maySubmitShape(session)
                || !creatorOwns.contains(session.sessionId())) {
            return false;
        }
        var summary = grants.get(session.workspace().getWorkspaceId());
        return summary != null && summary.canCreateSession();
    }

    private boolean maySubmitShape(SessionRecord session) {
        if (session.workspace() == null
                || !harness.isWorkspaceFilesAvailable()) {
            return false;
        }
        // The authority execution cites (WorkspaceExecutionStore
        // .authorizePassiveAttachment) fixes these at creation: a Session
        // that fails them can never execute, so admission must not certify
        // it. Empty bound creation skips that validation by design.
        return "ACTIVE".equals(session.status()) && session.deletedAt() == null
                && "qwen-code".equals(session.agentId())
                && WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        session.workspace().getContextConfigRef());
    }

    void requireLegacyWorkspace(String tenantId, String actorId,
            String sessionId) {
        requireLegacyWorkspace(store.requireSession(tenantId, sessionId),
                actorId);
    }

    private void requireLegacyWorkspace(SessionRecord session,
            String actorId) {
        if (session.workspace() != null) {
            if (!workspaces.canRead(session.tenantId(), actorId,
                    session.workspace().getWorkspaceId())) {
                throw new ApiException(HttpStatus.NOT_FOUND,
                        "session_not_found", "The Session was not found.");
            }
            throw new ApiException(HttpStatus.CONFLICT, "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
    }

    SessionRecord requireReadableSession(String tenantId,
            String actorId, String sessionId) {
        SessionRecord session = requireVisibleSession(tenantId, sessionId);
        requireReadGrant(session, actorId);
        return session;
    }

    void requireReadGrant(SessionRecord session, String actorId) {
        if (session.workspace() != null && !workspaces.canRead(session.tenantId(),
                actorId, session.workspace().getWorkspaceId())) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
    }

    /**
     * Reads the next catch-up page of a stream.
     *
     * @throws ReplayCursorExpired when the cursor is below the replay floor
     */
    List<EventRecord> streamEvents(SessionRecord session, long afterSequence) {
        requireEventCursor(afterSequence);
        return replayableEvents(session, afterSequence, STREAM_PAGE);
    }

    private SessionRecord requireVisibleSession(String tenantId,
            String sessionId) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        if ("DELETED".equals(session.status())) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "session_not_found", "The Session was not found.");
        }
        return session;
    }

    private static ApiException dependencyUnavailable(String code,
            String message) {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, code,
                message);
    }

    private Admission replay(String tenantId, String operation,
            String idempotencyKey, String requestDigest) {
        return store.findCommand(tenantId, operation, idempotencyKey)
                .map(ignored -> store.replayCommand(tenantId, operation,
                        idempotencyKey, requestDigest))
                .orElse(null);
    }

    private void requireHarness() {
        if (!harness.isAvailable()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "hosted_harness_disabled",
                    "Hosted Harness is not configured.");
        }
    }

    private static List<Map<String, Object>> input(List<InputBlock> blocks,
            boolean required) {
        if (blocks == null || blocks.isEmpty()) {
            if (required) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "input_required", "At least one input is required.");
            }
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (InputBlock block : blocks) {
            if (block == null || !INPUT_TYPES.contains(block.type())
                    || block.text() == null || block.text().isEmpty()) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "unsupported_input",
                        "Phase 1 accepts non-empty text input only.");
            }
            result.add(Map.of("type", "text", "text", block.text()));
        }
        return List.copyOf(result);
    }

    private static String metadataTitle(String explicitTitle,
            Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return validTitle(explicitTitle);
        }
        if (metadata.size() > 16) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_metadata", "Metadata accepts at most 16 keys.");
        }
        for (Map.Entry<String, Object> entry : metadata.entrySet()) {
            if (!(entry.getValue() instanceof String)
                    || entry.getKey().length() > 64
                    || ((String) entry.getValue()).length() > 512) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "invalid_metadata", "Metadata limits were exceeded.");
            }
            if (!"title".equals(entry.getKey())) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "unsupported_feature",
                        "Phase 1 persists metadata.title only.");
            }
        }
        Object title = metadata.get("title");
        return validTitle(explicitTitle != null ? explicitTitle
                : title instanceof String ? (String) title : null);
    }

    private static String validTitle(String title) {
        if (title != null && title.length() > 512) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must not exceed 512 characters.");
        }
        return title == null || title.isBlank() ? null : title;
    }

    private static String validRenameTitle(String title) {
        if (title == null || title.isBlank() || title.length() > 256) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must contain 1-256 characters.");
        }
        if (title.chars().anyMatch(character -> character <= 31
                || character == 127)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_title",
                    "Title must not contain control characters.");
        }
        return title;
    }

    static void validateIdempotencyKey(String key) {
        if (key == null || !IDEMPOTENCY_KEY.matcher(key).matches()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_idempotency_key",
                    "Idempotency-Key must contain 1-128 visible characters.");
        }
    }

    private static int limit(int requested) {
        if (requested <= 0 || requested > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 100.");
        }
        return requested;
    }

    private static int eventLimit(int requested) {
        if (requested <= 0 || requested > 1000) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_limit",
                    "Limit must be between 1 and 1000.");
        }
        return requested;
    }

    private static String nextCursor(SessionPage page) {
        if (!page.hasMore() || page.sessions().isEmpty()) {
            return null;
        }
        SessionRecord last = page.sessions().get(page.sessions().size() - 1);
        String raw = last.updatedAt() + ":" + last.sessionId();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                raw.getBytes(StandardCharsets.UTF_8));
    }

    private static SessionCursor decodeCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
            int separator = decoded.indexOf(':');
            if (separator <= 0 || separator == decoded.length() - 1) {
                throw new IllegalArgumentException();
            }
            return new SessionCursor(Long.parseLong(
                    decoded.substring(0, separator)),
                    decoded.substring(separator + 1));
        } catch (IllegalArgumentException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_cursor", "Session cursor is invalid.");
        }
    }

    private static String nextTurnCursor(TurnPage page) {
        if (!page.hasMore() || page.turns().isEmpty()) {
            return null;
        }
        TurnSummary last = page.turns().getLast();
        String raw = last.createdAt() + ":" + last.turnId();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                raw.getBytes(StandardCharsets.UTF_8));
    }

    private static TurnCursor decodeTurnCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor),
                    StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            decoded = "";
        }
        var matcher = TURN_CURSOR.matcher(decoded);
        try {
            if (matcher.matches()) {
                return new TurnCursor(Long.parseLong(matcher.group(1)),
                        matcher.group(2));
            }
        } catch (NumberFormatException error) {
            // A creation time beyond a long is not a cursor this server wrote.
        }
        throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor",
                "Turn cursor is invalid.");
    }

    private static Long transcriptCursor(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        try {
            long value = Long.parseLong(cursor);
            if (value <= 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_cursor", "Transcript cursor is invalid.");
        }
    }

    private static CommandAdmission response(Admission admission) {
        return new CommandAdmission(admission.sessionId(),
                admission.turnId(), "accepted", admission.replayed());
    }

    private record SessionCursor(long updatedAt, String sessionId) {
    }

    private record TurnCursor(long createdAt, String turnId) {
    }

    public record SessionMutationResult<T>(T body, boolean replayed) {
    }
}
