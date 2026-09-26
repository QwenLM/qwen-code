package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.DeletedSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicItemList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellWorkspace;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellContentPart;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellItem;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemPartRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class ManagedAgentService {
    private static final String CREATE = "CREATE_SESSION";
    private static final String SUBMIT = "SUBMIT_TURN";
    private static final String CANCEL = "CANCEL_TURN";
    private static final String RENAME = "RENAME_SESSION";
    private static final String ARCHIVE = "ARCHIVE_SESSION";
    private static final String UNARCHIVE = "UNARCHIVE_SESSION";
    private static final String DELETE = "DELETE_SESSION";
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile(
            "^[\\x21-\\x7e]{1,128}$");
    private final AgentStateStore store;
    private final ManagedWorkspaceRegistry workspaces;
    private final RequestDigests digests;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;
    private final RuntimeWarmer runtimeWarmer;

    public ManagedAgentService(AgentStateStore store,
            RequestDigests digests, HarnessCoordinator coordinator,
            HarnessConnector harness, RuntimeWarmer runtimeWarmer,
            ManagedWorkspaceRegistry workspaces) {
        this.store = store;
        this.workspaces = workspaces;
        this.digests = digests;
        this.coordinator = coordinator;
        this.harness = harness;
        this.runtimeWarmer = runtimeWarmer;
    }

    public CommandAdmission createSession(String tenantId,
            String idempotencyKey, String agentId, String title,
            Map<String, Object> metadata, List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
        List<Map<String, Object>> input = input(blocks, false);
        if (!input.isEmpty()) {
            requireHarness();
        }
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
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
            admission = store.insertSessionCommand(tenantId, CREATE,
                    idempotencyKey, requestDigest, agentId, effectiveTitle,
                    input, payloadDigest);
        } catch (DuplicateKeyException error) {
            admission = store.replayCommand(tenantId, CREATE,
                    idempotencyKey, requestDigest);
        }
        dispatch(tenantId, admission);
        return response(admission);
    }

    public CommandAdmission createWorkspaceSession(String tenantId,
            String actorId, String idempotencyKey, String agentId,
            String title, Map<String, Object> metadata,
            List<InputBlock> blocks, WorkspaceSelection selection) {
        validateIdempotencyKey(idempotencyKey);
        if (actorId == null || actorId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED,
                    "actor_required", "A trusted actor is required.");
        }
        List<Map<String, Object>> input = input(blocks, false);
        if (!input.isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "workspace_unavailable",
                    "Hosted Workspace execution is not available.");
        }
        String effectiveTitle = metadataTitle(title, metadata);
        Map<String, Object> semantic = new LinkedHashMap<>();
        semantic.put("agentId", agentId);
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
                    effectiveTitle, input, payloadDigest, selection);
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
        requireLegacyWorkspace(tenantId, actorId, sessionId);
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
        requireLegacyWorkspace(tenantId, actorId, sessionId);
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
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String effectiveTitle = validRenameTitle(title);
        String requestDigest = digests.digest(Map.of(
                "sessionId", sessionId, "title", effectiveTitle));
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                RENAME, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.RENAME);
        if (!"COMPLETED".equals(command.status())) {
            requireHarness();
            SessionRecord session = store.requireSession(tenantId, sessionId);
            HarnessConnector.Attachment attachment;
            try {
                attachment = harness.createOrLoad(tenantId, sessionId,
                        session.harnessBootId() != null);
                harness.rename(tenantId, sessionId, effectiveTitle);
            } catch (RuntimeException error) {
                throw dependencyUnavailable("hosted_harness_unavailable",
                        "The Hosted Harness could not persist the Session title.");
            }
            session = store.completeSessionMutation(tenantId, RENAME,
                    idempotencyKey, sessionId, SessionMutationKind.RENAME,
                    effectiveTitle, attachment.bootId());
            return new SessionMutationResult<>(publicSession(session),
                    command.replayed());
        }
        return new SessionMutationResult<>(getPublicSession(tenantId,
                sessionId), true);
    }

    public SessionMutationResult<PublicSession> archiveSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        return lifecycleMutation(tenantId, actorId, idempotencyKey, sessionId,
                ARCHIVE, SessionMutationKind.ARCHIVE);
    }

    public SessionMutationResult<PublicSession> unarchiveSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        validateIdempotencyKey(idempotencyKey);
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String requestDigest = lifecycleDigest(sessionId, UNARCHIVE);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                UNARCHIVE, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.UNARCHIVE);
        if (!"COMPLETED".equals(command.status())) {
            try {
                runtimeWarmer.resume(sessionId);
            } catch (RuntimeException error) {
                throw dependencyUnavailable("runtime_broker_unavailable",
                        "The Runtime Broker could not resume the Session.");
            }
            SessionRecord session = store.completeSessionMutation(tenantId,
                    UNARCHIVE, idempotencyKey, sessionId,
                    SessionMutationKind.UNARCHIVE, null, null);
            return new SessionMutationResult<>(publicSession(session),
                    command.replayed());
        }
        return new SessionMutationResult<>(getPublicSession(tenantId,
                sessionId), true);
    }

    public SessionMutationResult<DeletedSession> deleteSession(
            String tenantId, String actorId, String idempotencyKey, String sessionId) {
        validateIdempotencyKey(idempotencyKey);
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String requestDigest = lifecycleDigest(sessionId, DELETE);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                DELETE, idempotencyKey, requestDigest, sessionId,
                SessionMutationKind.DELETE);
        if (!"COMPLETED".equals(command.status())) {
            SessionRecord session = store.requireSession(tenantId, sessionId);
            closeAndDrain(session, command.sessionStatusBefore());
            store.completeSessionMutation(tenantId, DELETE, idempotencyKey,
                    sessionId, SessionMutationKind.DELETE, null, null);
        }
        return new SessionMutationResult<>(new DeletedSession(sessionId,
                "agent.session.deleted", true), command.replayed());
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
                sessionId));
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String actorId, String cursor, int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        List<PublicSession> sessions = page.sessions().stream()
                .map(this::publicSession).toList();
        return new PublicList<>("list", sessions, page.hasMore(),
                nextCursor(page));
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String actorId, String cursor,
            int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId, actorId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new WebShellPage<>(page.sessions().stream()
                .map(this::webShellSession).toList(), nextCursor(page),
                page.hasMore());
    }

    public List<PublicEvent> publicEvents(String tenantId, String actorId,
            String sessionId, long afterSequence, int requestedLimit) {
        return events(tenantId, actorId, sessionId, afterSequence,
                requestedLimit)
                .stream().map(this::publicEvent).toList();
    }

    public List<WebShellEvent> webShellEvents(String tenantId, String actorId,
            String sessionId, long afterSequence, int requestedLimit) {
        return events(tenantId, actorId, sessionId, afterSequence,
                requestedLimit)
                .stream().map(this::webShellEvent).toList();
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
        int limit = limit(requestedLimit);
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

    private List<EventRecord> events(String tenantId, String actorId,
            String sessionId, long afterSequence, int requestedLimit) {
        if (afterSequence < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor",
                    "Event sequence must be non-negative.");
        }
        requireReadableSession(tenantId, actorId, sessionId);
        return store.findEvents(tenantId, sessionId, afterSequence,
                limit(requestedLimit));
    }

    private PublicSession publicSession(SessionRecord session) {
        TurnRecord activeTurn = store.findActiveTurn(session.tenantId(),
                session.sessionId()).orElse(null);
        Map<String, Object> metadata = session.title() == null ? Map.of()
                : Map.of("title", session.title());
        return new PublicSession(session.sessionId(), "agent.session",
                session.agentId(), session.status().toLowerCase(),
                session.createdAt() / 1000, session.updatedAt() / 1000,
                metadata, activeTurn == null ? null : publicTurn(activeTurn),
                session.lastSequence(), publicWorkspace(session));
    }

    private WebShellSession webShellSession(SessionRecord session) {
        TurnRecord latestTurn = store.findLatestTurn(session.tenantId(),
                session.sessionId()).orElse(null);
        EventRecord environmentEvent = store.findLatestEnvironmentEvent(
                session.tenantId(), session.sessionId()).orElse(null);
        return new WebShellSession(session.sessionId(), session.title(),
                session.agentId(), session.status().toLowerCase(),
                session.createdAt(), session.updatedAt(),
                latestTurn == null ? null : webShellTurn(latestTurn),
                webShellEnvironment(environmentEvent),
                session.lastSequence(), webShellWorkspace(session));
    }

    private static WebShellWorkspace webShellWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new WebShellWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative());
    }

    private static PublicWorkspace publicWorkspace(SessionRecord session) {
        return session.workspace() == null ? null
                : new PublicWorkspace(session.workspace().getWorkspaceId(),
                        session.workspace().getCwdRelative());
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

    private static PublicTurn publicTurn(TurnRecord turn) {
        return new PublicTurn(turn.turnId(), "agent.turn",
                turn.sessionId(), turn.status().toLowerCase(),
                turn.createdAt() / 1000,
                turn.completedAt() == null ? null
                        : turn.completedAt() / 1000,
                turn.errorCode());
    }

    private static WebShellTurn webShellTurn(TurnRecord turn) {
        return new WebShellTurn(turn.turnId(), turn.sessionId(),
                turn.status().toLowerCase(), turn.createdAt(),
                turn.completedAt(), turn.errorCode(), null);
    }

    PublicEvent publicEvent(EventRecord event) {
        return new PublicEvent(event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.type(),
                event.createdAt() / 1000, event.data(), event.terminal());
    }

    WebShellEvent webShellEvent(EventRecord event) {
        return new WebShellEvent(event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.type(),
                event.createdAt(), event.data(), event.terminal());
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
            List<EventRecord> page = store.findEvents(tenantId, sessionId,
                    cursor, 100);
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

    private SessionMutationResult<PublicSession> lifecycleMutation(
            String tenantId, String actorId, String idempotencyKey, String sessionId,
            String operation, SessionMutationKind kind) {
        validateIdempotencyKey(idempotencyKey);
        requireLegacyWorkspace(tenantId, actorId, sessionId);
        String requestDigest = lifecycleDigest(sessionId, operation);
        SessionMutationCommand command = store.beginSessionMutation(tenantId,
                operation, idempotencyKey, requestDigest, sessionId, kind);
        if (!"COMPLETED".equals(command.status())) {
            SessionRecord session = store.requireSession(tenantId, sessionId);
            closeAndDrain(session, command.sessionStatusBefore());
            session = store.completeSessionMutation(tenantId, operation,
                    idempotencyKey, sessionId, kind, null, null);
            return new SessionMutationResult<>(publicSession(session),
                    command.replayed());
        }
        return new SessionMutationResult<>(getPublicSession(tenantId,
                sessionId), true);
    }

    private void closeAndDrain(SessionRecord session,
            String sessionStatusBefore) {
        boolean alreadyClosed = "ARCHIVED".equals(sessionStatusBefore);
        if (!alreadyClosed && harness.isAvailable()) {
            try {
                harness.closeSession(session.tenantId(),
                        session.sessionId());
            } catch (RuntimeException error) {
                throw dependencyUnavailable("hosted_harness_unavailable",
                        "The Hosted Harness could not close the Session.");
            }
        } else if (!alreadyClosed && session.harnessBootId() != null) {
            throw dependencyUnavailable("hosted_harness_unavailable",
                    "The Hosted Harness is required to close the Session.");
        }
        try {
            runtimeWarmer.drain(session.sessionId()).toCompletableFuture()
                    .join();
        } catch (RuntimeException error) {
            throw dependencyUnavailable("runtime_broker_unavailable",
                    "The Runtime Broker could not drain the Session.");
        }
    }

    private String lifecycleDigest(String sessionId, String operation) {
        return digests.digest(Map.of(
                "sessionId", sessionId, "operation", operation));
    }

    private void requireLegacyWorkspace(String tenantId, String actorId,
            String sessionId) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        if (session.workspace() != null) {
            if (!workspaces.canRead(tenantId, actorId,
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

    List<EventRecord> streamEvents(SessionRecord session, long afterSequence) {
        return store.findEvents(session.tenantId(), session.sessionId(),
                afterSequence, 100);
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
            if (block == null || !"text".equals(block.type())
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

    private static void validateIdempotencyKey(String key) {
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

    public record SessionMutationResult<T>(T body, boolean replayed) {
    }
}
