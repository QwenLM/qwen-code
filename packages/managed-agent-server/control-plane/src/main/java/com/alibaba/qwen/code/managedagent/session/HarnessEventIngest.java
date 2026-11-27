package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.IngestEventsRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.IngestReceipt;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Records the event envelopes a Hosted Harness pushes for a Turn whose
 * dispatch lease it holds, by the same rules as the dispatcher's stream
 * consumer. Each request renews that lease.
 */
@Component
public class HarnessEventIngest {
    static final String OWNER_PREFIX = "harness:";
    private static final Set<String> ACTIVE = Set.of("ACCEPTED", "RUNNING", "CANCELLING");

    private final AgentStateStore store;
    private final ManagedSessionStore sessionStore;
    private final HarnessEventProjector projector;
    private final Clock clock;
    private final Duration leaseDuration;
    private final Duration renewInterval;
    private final int batchMaxEvents;
    private final int batchMaxBytes;

    public HarnessEventIngest(AgentStateStore store, ManagedSessionStore sessionStore,
            HarnessEventProjector projector, @Qualifier("managedAgentClock") Clock clock,
            ManagedAgentSettings properties) {
        this.store = store;
        this.sessionStore = sessionStore;
        this.projector = projector;
        this.clock = clock;
        this.leaseDuration = properties.getDispatch().getLeaseDuration();
        this.renewInterval = properties.getDispatch().getLeaseRenewInterval();
        this.batchMaxEvents = properties.getEvents().getBatchMaxEvents();
        this.batchMaxBytes = properties.getEvents().getBatchMaxBytes();
    }

    public IngestReceipt ingest(String tenantId, String sessionId, String writerToken,
            IngestEventsRequest request) {
        List<SourceEvent> events = decode(request);
        long committedSequence = sessionStore.authenticateEventIngest(tenantId, sessionId,
                writerToken, request.workspaceId(), request.writerId(), request.writerGeneration(),
                ManagedSessionStoreModels.INGEST_END_PARKED.equals(request.end()));
        String owner = OWNER_PREFIX + request.writerId();
        TurnRecord turn = requireOwned(tenantId, sessionId, request, owner);
        long cursor = cursor(turn);
        if (request.afterSequence() > cursor) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_CURSOR_MISMATCH,
                    "The batch does not continue the recorded cursor.", cursor);
        }
        if (request.throughSequence() > cursor) {
            try {
                if (record(turn, owner, request, events, cursor)) {
                    return receipt(tenantId, sessionId, request);
                }
            } catch (IllegalStateException lost) {
                requireOwned(tenantId, sessionId, request, owner);
                throw lost;
            }
        }
        if (request.end() != null) {
            end(turn, owner, request, committedSequence);
            return receipt(tenantId, sessionId, request);
        }
        if (!store.renewTurn(tenantId, sessionId, turn.turnId(), owner, leaseDuration)) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_NOT_OWNER,
                    "The Harness no longer holds the Turn.", null);
        }
        return receipt(tenantId, sessionId, request);
    }

    private boolean record(TurnRecord turn, String owner, IngestEventsRequest request,
            List<SourceEvent> events, long cursor) {
        HarnessEventRecorder recorder = new HarnessEventRecorder(store, projector, turn, owner,
                request.writerId(), request.eventEpoch(), batchMaxEvents, batchMaxBytes, () -> {});
        for (SourceEvent event : events) {
            if (event.id() > cursor && recorder.accept(event)) {
                return true;
            }
        }
        recorder.flush();
        // Envelopes the Turn filtered out still move its cursor to the end
        // of the batch, so an end marker can prove the journal was drained.
        TurnRecord recorded = store.findTurn(turn.tenantId(), turn.sessionId(), turn.turnId())
                .orElseThrow();
        if (cursor(recorded) < request.throughSequence()) {
            store.recordHarnessEvents(turn.tenantId(), turn.sessionId(), turn.turnId(), owner,
                    request.eventEpoch(), List.of(new HarnessEvent(request.throughSequence(),
                            request.writerId() + ":" + request.eventEpoch() + ":"
                                    + request.throughSequence(), null)));
        }
        return false;
    }

    private void end(TurnRecord turn, String owner, IngestEventsRequest request,
            long committedSequence) {
        if (request.throughSequence() != committedSequence) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_END_REFUSED,
                    "The end marker does not follow the committed journal.", null);
        }
        boolean ended = ManagedSessionStoreModels.INGEST_END_PARKED.equals(request.end())
                ? store.parkTurnForAction(turn.tenantId(), turn.sessionId(), turn.turnId(), owner)
                : store.markTurnRecoveryBlocked(turn.tenantId(), turn.sessionId(), turn.turnId(),
                        owner, AgentStateStore.HARNESS_RECOVERY_BLOCKED,
                        "The Hosted Harness stopped with recovery blocked;"
                                + " reconcile its saved execution before continuing.");
        if (!ended) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_END_REFUSED,
                    "The Turn's durable state does not support the end marker.", null);
        }
    }

    private TurnRecord requireOwned(String tenantId, String sessionId,
            IngestEventsRequest request, String owner) {
        TurnRecord turn = store.findTurn(tenantId, sessionId, request.turnId()).orElse(null);
        if (turn == null || !request.promptId().equals(turn.promptId())
                || !ACTIVE.contains(turn.status())) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_NOT_OWNER,
                    "The Turn is not active for this prompt.", null);
        }
        if (!request.eventEpoch().equals(turn.harnessEventEpoch())) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_NOT_READY,
                    "The Turn's admission at this event epoch is not recorded.", null);
        }
        if (!owner.equals(turn.dispatchOwner()) || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < clock.millis()) {
            throw refusal(ManagedSessionStoreModels.ERROR_INGEST_NOT_OWNER,
                    "The Harness no longer holds the Turn.", null);
        }
        return turn;
    }

    private IngestReceipt receipt(String tenantId, String sessionId, IngestEventsRequest request) {
        long cursor = store.findTurn(tenantId, sessionId, request.turnId()).map(HarnessEventIngest::cursor)
                .orElse(request.throughSequence());
        return new IngestReceipt(cursor, renewInterval.toMillis());
    }

    private static long cursor(TurnRecord turn) {
        return turn.harnessLastEventId() == null ? 0 : turn.harnessLastEventId();
    }

    // The SDK stream decoder's envelope rules, so the projector sees the
    // values the stream path would give it.
    private static List<SourceEvent> decode(IngestEventsRequest request) {
        if (request.throughSequence() < request.afterSequence()) {
            throw invalid("throughSequence must not precede afterSequence.");
        }
        List<SourceEvent> events = new ArrayList<>(request.events().size());
        long previous = request.afterSequence();
        for (Map<String, Object> envelope : request.events()) {
            if (envelope == null || !Integer.valueOf(1).equals(envelope.get("v"))) {
                throw invalid("Each event must be a version 1 envelope.");
            }
            if (!(envelope.get("type") instanceof String type) || type.isEmpty()) {
                throw invalid("Each event must name its type.");
            }
            if (!(envelope.get("id") instanceof Integer || envelope.get("id") instanceof Long)) {
                throw invalid("Each event must carry its journal sequence.");
            }
            long id = ((Number) envelope.get("id")).longValue();
            if (id <= previous || id > request.throughSequence()) {
                throw invalid("Event sequences must increase within the batch range.");
            }
            previous = id;
            if (!envelope.containsKey("data")) {
                throw invalid("Each event must carry data.");
            }
            Object promptId = envelope.get("promptId");
            Object metadata = envelope.get("_meta");
            if (promptId != null && !(promptId instanceof String)
                    || metadata != null && !(metadata instanceof Map<?, ?>)) {
                throw invalid("An event promptId must be a string and its _meta an object.");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> meta = metadata == null ? Map.of() : (Map<String, Object>) metadata;
            events.add(new SourceEvent(id, type, envelope.get("data"), (String) promptId, meta));
        }
        return events;
    }

    private static ManagedAgentException invalid(String message) {
        return new ManagedAgentException(400, ManagedSessionStoreModels.ERROR_INVALID_REQUEST, message);
    }

    private static ManagedAgentException refusal(String code, String message, Long cursor) {
        return cursor == null ? new ManagedAgentException(409, code, message)
                : new ManagedAgentException(409, code, message, Map.of("cursor", cursor));
    }
}
