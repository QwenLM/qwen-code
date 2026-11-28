package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Records one Turn's Hosted Harness source events, whether they arrive on
 * the Harness event stream or in ingest requests: filtering, retraction,
 * projection and batching are the same for both.
 */
final class HarnessEventRecorder {
    private final AgentStateStore store;
    private final HarnessEventProjector projector;
    private final TurnRecord turn;
    private final String owner;
    private final String bootId;
    private final String eventEpoch;
    private final int batchMaxEvents;
    private final int batchMaxBytes;
    private final Runnable beforeWrite;
    private final List<HarnessEvent> batch = new ArrayList<>();
    private int batchBytes;
    private boolean flushFirstVisibleText = true;

    HarnessEventRecorder(AgentStateStore store, HarnessEventProjector projector,
            TurnRecord turn, String owner, String bootId, String eventEpoch,
            int batchMaxEvents, int batchMaxBytes, Runnable beforeWrite) {
        this.store = store;
        this.projector = projector;
        this.turn = turn;
        this.owner = owner;
        this.bootId = bootId;
        this.eventEpoch = eventEpoch;
        this.batchMaxEvents = batchMaxEvents;
        this.batchMaxBytes = batchMaxBytes;
        this.beforeWrite = beforeWrite;
    }

    /** Accepts the next source event; true once the Turn's terminal event is recorded. */
    boolean accept(SourceEvent source) {
        if (source.id() == null
                || source.promptId() != null
                && !turn.promptId().equals(source.promptId())) {
            return false;
        }
        if ("message_retracted".equals(source.type())) {
            // A restarted model attempt retracts the prefix the failed
            // one published (#13319). Flush the pending batch first:
            // the retraction range covers deltas this stream already
            // read but has not recorded yet.
            flush();
            Map<?, ?> retraction = source.data() instanceof Map<?, ?> data ? data : Map.of();
            if (retraction.containsKey("throughSequence")) {
                Object through = retraction.get("throughSequence");
                Object sourceBoot = retraction.get("sourceBootId");
                Object sourceEpoch = retraction.get("sourceEventEpoch");
                if (!(through instanceof Number) || !(sourceBoot instanceof String) || !(sourceEpoch instanceof String)) {
                    throw new IllegalStateException("Invalid bounded Hosted retraction source");
                }
                store.retractHarnessTurnOutput(turn.tenantId(), turn.sessionId(), turn.turnId(), owner,
                        eventEpoch, retractionFromSequence(source), source.id(),
                        (String) sourceBoot, (String) sourceEpoch, ((Number) through).longValue());
            } else {
                store.retractHarnessTurnOutput(turn.tenantId(), turn.sessionId(), turn.turnId(), owner,
                        eventEpoch, retractionFromSequence(source), source.id());
            }

            // The replay's first chunk is the new first visible text:
            // the transcript it replaces was just blanked.
            flushFirstVisibleText = true;
            return false;
        }
        ProjectedEvent projection = projector.project(source, turn.turnId());
        HarnessEvent event = new HarnessEvent(source.id(),
                bootId + ":" + eventEpoch + ":" + source.id(), projection);
        if (projection != null && !isTextDelta(projection)) {
            flush();
            record(List.of(event));
            return projection.terminal();
        }
        batch.add(event);
        batchBytes += estimatedBytes(projection);
        if (projection != null && flushFirstVisibleText) {
            flush();
            flushFirstVisibleText = false;
        } else if (batch.size() >= batchMaxEvents
                || batchBytes >= batchMaxBytes) {
            flush();
        }
        return false;
    }

    void flush() {
        if (!batch.isEmpty()) {
            record(List.copyOf(batch));
            batch.clear();
        }
        batchBytes = 0;
    }

    boolean isEmpty() {
        return batch.isEmpty();
    }

    private void record(List<HarnessEvent> events) {
        beforeWrite.run();
        store.recordHarnessEvents(turn.tenantId(), turn.sessionId(),
                turn.turnId(), owner, eventEpoch, events);
    }

    private static boolean isTextDelta(ProjectedEvent event) {
        return "item.output_text.delta".equals(event.type())
                || "item.reasoning.delta".equals(event.type());
    }

    // The journal sequence of the retracted message's first delta (#13319).
    // Fail closed on a malformed event: skipping it would keep the orphaned
    // prefix in the public transcript.
    private static long retractionFromSequence(SourceEvent event) {
        Object data = event.data();
        if (data instanceof Map<?, ?> map) {
            Object fromSequence = map.get("fromSequence");
            if (fromSequence instanceof Number number) {
                return number.longValue();
            }
        }
        throw new IllegalStateException(
                "Hosted Harness retraction is missing fromSequence");
    }

    private static int estimatedBytes(ProjectedEvent event) {
        if (event == null) {
            return 64;
        }
        Object text = event.data().get("text");
        return 128 + (text instanceof String
                ? ((String) text).getBytes(StandardCharsets.UTF_8).length
                : event.data().toString().getBytes(StandardCharsets.UTF_8)
                        .length);
    }
}
