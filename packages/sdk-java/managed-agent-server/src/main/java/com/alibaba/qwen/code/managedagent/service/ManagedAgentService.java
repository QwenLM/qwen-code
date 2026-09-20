package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.api.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicList;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicTurn;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellEvent;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellPage;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellSession;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTranscript;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellTurn;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
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
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile(
            "^[\\x21-\\x7e]{1,128}$");
    private final ManagedAgentStore store;
    private final RequestDigests digests;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;

    public ManagedAgentService(ManagedAgentStore store,
            RequestDigests digests, HarnessCoordinator coordinator,
            HarnessConnector harness) {
        this.store = store;
        this.digests = digests;
        this.coordinator = coordinator;
        this.harness = harness;
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

    public CommandAdmission submitTurn(String tenantId,
            String idempotencyKey, String sessionId,
            List<InputBlock> blocks) {
        validateIdempotencyKey(idempotencyKey);
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

    public CommandAdmission cancelTurn(String tenantId,
            String idempotencyKey, String sessionId, String turnId) {
        validateIdempotencyKey(idempotencyKey);
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

    public PublicSession getPublicSession(String tenantId,
            String sessionId) {
        return publicSession(store.requireSession(tenantId, sessionId));
    }

    public WebShellSession getWebShellSession(String tenantId,
            String sessionId) {
        return webShellSession(store.requireSession(tenantId, sessionId));
    }

    public PublicList<PublicSession> listPublicSessions(String tenantId,
            String cursor, int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        List<PublicSession> sessions = page.sessions().stream()
                .map(this::publicSession).toList();
        return new PublicList<>("list", sessions, page.hasMore(),
                nextCursor(page));
    }

    public WebShellPage<WebShellSession> listWebShellSessions(
            String tenantId, String cursor, int requestedLimit) {
        int limit = limit(requestedLimit);
        SessionCursor decoded = decodeCursor(cursor);
        SessionPage page = store.listSessions(tenantId,
                decoded == null ? null : decoded.updatedAt(),
                decoded == null ? null : decoded.sessionId(), limit);
        return new WebShellPage<>(page.sessions().stream()
                .map(this::webShellSession).toList(), nextCursor(page),
                page.hasMore());
    }

    public List<PublicEvent> publicEvents(String tenantId, String sessionId,
            long afterSequence, int requestedLimit) {
        return events(tenantId, sessionId, afterSequence, requestedLimit)
                .stream().map(this::publicEvent).toList();
    }

    public List<WebShellEvent> webShellEvents(String tenantId,
            String sessionId, long afterSequence, int requestedLimit) {
        return events(tenantId, sessionId, afterSequence, requestedLimit)
                .stream().map(this::webShellEvent).toList();
    }

    public WebShellTranscript transcript(String tenantId, String sessionId,
            String cursor, int requestedLimit) {
        SessionRecord session = store.requireSession(tenantId, sessionId);
        int limit = limit(requestedLimit);
        EventPage page = store.findTranscriptEvents(tenantId, sessionId,
                transcriptCursor(cursor), limit);
        List<WebShellEvent> events = page.events().stream()
                .map(this::webShellEvent).toList();
        String olderCursor = page.hasMore() && !events.isEmpty()
                ? Long.toString(events.get(0).sequence()) : null;
        return new WebShellTranscript(events, olderCursor, page.hasMore(),
                session.lastSequence());
    }

    public long lastSequence(String tenantId, String sessionId) {
        return store.requireSession(tenantId, sessionId).lastSequence();
    }

    private List<EventRecord> events(String tenantId, String sessionId,
            long afterSequence, int requestedLimit) {
        if (afterSequence < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "invalid_event_cursor",
                    "Event sequence must be non-negative.");
        }
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
                session.lastSequence());
    }

    private WebShellSession webShellSession(SessionRecord session) {
        TurnRecord latestTurn = store.findLatestTurn(session.tenantId(),
                session.sessionId()).orElse(null);
        return new WebShellSession(session.sessionId(), session.title(),
                session.agentId(), session.status().toLowerCase(),
                session.createdAt(), session.updatedAt(),
                latestTurn == null ? null : webShellTurn(latestTurn), null,
                session.lastSequence());
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

    private PublicEvent publicEvent(EventRecord event) {
        return new PublicEvent(event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.type(),
                event.createdAt() / 1000, event.data(), event.terminal());
    }

    private WebShellEvent webShellEvent(EventRecord event) {
        return new WebShellEvent(event.sequence(), event.eventId(),
                event.sessionId(), event.turnId(), event.type(),
                event.createdAt(), event.data(), event.terminal());
    }

    private void dispatch(String tenantId, Admission admission) {
        if (admission.turnId() != null) {
            coordinator.dispatch(tenantId, admission.sessionId(),
                    admission.turnId());
        }
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
}
