package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/** Process-local execution ledger for tests and single-node use. */
public final class InMemoryToolExecutionRepository
        implements ToolExecutionRepository {
    private final Clock clock;
    private final Map<String, ToolExecutionRecord> recordsById =
            new HashMap<>();
    private final Map<String, String> idsByIdempotencyKey = new HashMap<>();

    public InMemoryToolExecutionRepository() {
        this(Clock.systemUTC());
    }

    public InMemoryToolExecutionRepository(Clock clock) {
        if (clock == null) {
            throw new IllegalArgumentException("clock is required");
        }
        this.clock = clock;
    }

    @Override
    public synchronized ToolExecutionRecord findOrCreate(
            ToolExecutionRecord candidate) {
        requireCandidate(candidate);
        String existingId = idsByIdempotencyKey.get(
                candidate.getIdempotencyKey());
        if (existingId != null) {
            return recordsById.get(existingId);
        }
        ToolExecutionRecord duplicateId = recordsById.get(
                candidate.getExecutionCallId());
        if (duplicateId != null) {
            throw new IllegalArgumentException(
                    "executionCallId already belongs to another request");
        }
        recordsById.put(candidate.getExecutionCallId(), candidate);
        idsByIdempotencyKey.put(candidate.getIdempotencyKey(),
                candidate.getExecutionCallId());
        return candidate;
    }

    @Override
    public synchronized ToolExecutionRecord findByExecutionCallId(
            String executionCallId) {
        return recordsById.get(BrokerValues.requireId(executionCallId,
                "executionCallId"));
    }

    @Override
    public synchronized ToolExecutionRecord findByIdempotencyKey(
            String idempotencyKey) {
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        String executionCallId = idsByIdempotencyKey.get(key);
        return executionCallId == null ? null
                : recordsById.get(executionCallId);
    }

    @Override
    public synchronized ToolExecutionRecord compareAndSet(
            ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        requireReplacement(expected, replacement);
        ToolExecutionRecord current = recordsById.get(
                expected.getExecutionCallId());
        if (current == null
                || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion()) {
            return null;
        }
        ToolExecutionRecord updated = replacement.withVersion(
                expected.getVersion() + 1);
        recordsById.put(updated.getExecutionCallId(), updated);
        return updated;
    }

    @Override
    public synchronized ToolExecutionRecord claimDispatch(
            String executionCallId, String owner, Duration leaseDuration) {
        ToolExecutionRecord current = requireRecord(executionCallId);
        if (current == null || current.isSettled()
                || current.getState() == ToolExecutionRecord.State.UNKNOWN) {
            return null;
        }
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = requireDuration(leaseDuration);
        Instant now = clock.instant();
        if (ownerId.equals(current.getDispatchOwner())
                && current.getDispatchLeaseUntil().isAfter(now)) {
            return current;
        }
        if (current.getDispatchOwner() != null
                && current.getDispatchLeaseUntil().isAfter(now)) {
            return null;
        }
        ToolExecutionRecord.State nextState = current.isCancelRequested()
                && (current.getState() == ToolExecutionRecord.State.EXECUTING
                        || current.getState()
                                == ToolExecutionRecord.State.CANCEL_REQUESTED)
                ? ToolExecutionRecord.State.CANCEL_REQUESTED
                : ToolExecutionRecord.State.DISPATCHING;
        ToolExecutionRecord claimed = current.withDispatch(ownerId,
                now.plus(duration), current.getDispatchGeneration() + 1,
                nextState).withVersion(current.getVersion() + 1);
        recordsById.put(executionCallId, claimed);
        return claimed;
    }

    @Override
    public synchronized ToolExecutionRecord renewDispatch(
            String executionCallId, String owner, long dispatchGeneration,
            Duration leaseDuration) {
        ToolExecutionRecord current = requireRecord(executionCallId);
        if (current == null || current.isSettled()
                || current.getState() == ToolExecutionRecord.State.UNKNOWN) {
            return null;
        }
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = requireDuration(leaseDuration);
        Instant now = clock.instant();
        if (!ownerId.equals(current.getDispatchOwner())
                || dispatchGeneration != current.getDispatchGeneration()
                || !current.getDispatchLeaseUntil().isAfter(now)) {
            return null;
        }
        ToolExecutionRecord renewed = current.withDispatch(ownerId,
                now.plus(duration), dispatchGeneration, current.getState())
                .withVersion(current.getVersion() + 1);
        recordsById.put(executionCallId, renewed);
        return renewed;
    }

    @Override
    public synchronized boolean hasActiveByRuntimeSession(
            String runtimeSessionId) {
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return recordsById.values().stream()
                .anyMatch(record -> id.equals(record.getRuntimeSessionId())
                        && !record.isSettled());
    }

    private ToolExecutionRecord requireRecord(String executionCallId) {
        return recordsById.get(BrokerValues.requireId(executionCallId,
                "executionCallId"));
    }

    private static void requireCandidate(ToolExecutionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getState()
                        != ToolExecutionRecord.State.PREPARED
                || candidate.getDispatchOwner() != null) {
            throw new IllegalArgumentException(
                    "candidate must be a new prepared execution");
        }
    }

    private static void requireReplacement(ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve execution identity and version");
        }
    }

    private static Duration requireDuration(Duration duration) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(
                    "leaseDuration must be positive");
        }
        return duration;
    }
}
