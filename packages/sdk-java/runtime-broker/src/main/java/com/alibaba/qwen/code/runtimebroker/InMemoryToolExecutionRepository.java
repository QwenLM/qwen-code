package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Comparator;
import java.util.Map;
import java.util.List;
import java.util.TreeMap;

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

    synchronized void abandonByBinding(RuntimeBindingRecord binding) {
        recordsById.values().stream()
                .filter(record -> !record.isTerminal())
                .filter(record -> record.getBindingId().equals(binding.getBindingId())
                        && record.getRuntimeGeneration() == binding.getGeneration())
                .sorted(Comparator.comparing(ToolExecutionRecord::getExecutionCallId))
                .limit(100).toList().forEach(record -> recordsById.put(
                        record.getExecutionCallId(), record.abandon(binding, clock.instant())
                                .withVersion(record.getVersion() + 1)));
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
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration) {
        return compareAndSet(expected, replacement, owner, dispatchGeneration, false);
    }

    synchronized ToolExecutionRecord authorizeDispatch(ToolExecutionRecord expected,
            String owner, long dispatchGeneration, long bindingVersion) {
        return compareAndSet(expected, expected.authorizeDispatch(bindingVersion), owner,
                dispatchGeneration, true);
    }

    private ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner, long dispatchGeneration,
            boolean authorizing) {
        requireReplacement(expected, replacement);
        if (!authorizing && !expected.sameAuthorization(replacement)) {
            throw new IllegalArgumentException("replacement must preserve dispatch authorization");
        }
        ToolExecutionRecord current = recordsById.get(
                expected.getExecutionCallId());
        if (current == null
                || !current.sameIdentity(expected)
                || !current.sameAuthorization(expected)
                || authorizing && (current.getState() != ToolExecutionRecord.State.DISPATCHING
                        || current.isCancelRequested()
                        || current.getAuthorizedDispatchGeneration() != null)
                || current.getVersion() != expected.getVersion()
                || current.isTerminal()
                || current.getState() == ToolExecutionRecord.State.UNKNOWN
                || !current.sameDispatch(expected)
                || !current.hasLiveDispatchAt(clock.instant())
                || !current.getDispatchOwner().equals(owner)
                || current.getDispatchGeneration() != dispatchGeneration) {
            return null;
        }
        ToolExecutionRecord.State to = replacement.getState();
        if (to == ToolExecutionRecord.State.ABANDONED
                || to == ToolExecutionRecord.State.PREPARED
                || to == ToolExecutionRecord.State.DISPATCHING
                        && current.getState()
                                != ToolExecutionRecord.State.DISPATCHING) {
            throw new IllegalArgumentException(
                    "execution state must not move backwards");
        }
        if (current.isCancelRequested()
                && !replacement.isCancelRequested()) {
            throw new IllegalArgumentException(
                    "replacement must not drop a cancellation request");
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
        if (current == null || current.isTerminal()
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
        if (current.getState() == ToolExecutionRecord.State.EXECUTING
                || current.getState()
                        == ToolExecutionRecord.State.CANCEL_REQUESTED) {
            // The prior dispatch may still be physically running; fence the
            // execution off for reconciliation instead of re-dispatching it.
            ToolExecutionRecord unknown = current.withUnknown()
                    .withVersion(current.getVersion() + 1);
            recordsById.put(executionCallId, unknown);
            return null;
        }
        ToolExecutionRecord claimed = current.withDispatch(ownerId,
                now.plus(duration), current.getDispatchGeneration() + 1,
                ToolExecutionRecord.State.DISPATCHING).withVersion(
                        current.getVersion() + 1);
        recordsById.put(executionCallId, claimed);
        return claimed;
    }

    @Override
    public synchronized ToolExecutionRecord renewDispatch(
            String executionCallId, String owner, long dispatchGeneration,
            Duration leaseDuration) {
        ToolExecutionRecord current = requireRecord(executionCallId);
        if (current == null || current.isTerminal()
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
    public synchronized ToolExecutionRecord requestCancel(
            String executionCallId, long expectedVersion) {
        ToolExecutionRecord current = requireRecord(executionCallId);
        if (current == null || current.isTerminal()
                || current.getVersion() != expectedVersion) {
            return null;
        }
        if (current.isCancelRequested()) {
            return current;
        }
        ToolExecutionRecord requested = current.withState(
                current.getState() == ToolExecutionRecord.State.EXECUTING
                        ? ToolExecutionRecord.State.CANCEL_REQUESTED
                        : current.getState(),
                true);
        if (current.getState() == ToolExecutionRecord.State.PREPARED) {
            // Never dispatched: no dispatcher exists to observe the intent,
            // so the cancel settles immediately without stop evidence.
            requested = requested.withResult(
                    current.cancellationBeforeDispatch(),
                    current.getLastSequence(), clock.instant());
        }
        ToolExecutionRecord updated = requested.withVersion(
                current.getVersion() + 1);
        recordsById.put(executionCallId, updated);
        return updated;
    }

    @Override
    public synchronized ToolExecutionRecord settlePrepared(
            ToolExecutionRecord expected, Map<String, Object> result,
            Instant settlementTime) {
        if (expected == null || result == null || settlementTime == null) {
            throw new IllegalArgumentException(
                    "expected, result and time are required");
        }
        ToolExecutionRecord current = recordsById.get(
                expected.getExecutionCallId());
        if (current == null || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion()
                || current.isTerminal()
                || current.getState() != ToolExecutionRecord.State.PREPARED) {
            return null;
        }
        ToolExecutionRecord settled = current.withResult(result,
                current.getLastSequence(), settlementTime)
                .withVersion(current.getVersion() + 1);
        recordsById.put(settled.getExecutionCallId(), settled);
        return settled;
    }

    @Override
    public synchronized ToolExecutionRecord resolveUnknown(
            ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return resolve(expected, resolutionResult, resolutionTime, true);
    }

    @Override
    public synchronized ToolExecutionRecord resolveUnsettled(
            ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return resolve(expected, resolutionResult, resolutionTime, false);
    }

    private ToolExecutionRecord resolve(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime,
            boolean unknownOnly) {
        if (expected == null) {
            throw new IllegalArgumentException("expected is required");
        }
        ToolExecutionRecord current = recordsById.get(
                expected.getExecutionCallId());
        if (current == null || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion()
                || !current.needsReconciliation()
                || unknownOnly && current.getState() != ToolExecutionRecord.State.UNKNOWN) {
            return null;
        }
        ToolExecutionRecord resolved = current.resolveUnsettled(
                resolutionResult, resolutionTime)
                .withVersion(current.getVersion() + 1);
        recordsById.put(resolved.getExecutionCallId(), resolved);
        return resolved;
    }

    @Override
    public synchronized List<ToolExecutionRecord> findUnsettled(
            RuntimeSessionRecord session, String afterExecutionCallId, int limit) {
        if (session == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException("session and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
        TreeMap<String, ToolExecutionRecord> batch = new TreeMap<>();
        for (ToolExecutionRecord record : recordsById.values()) {
            if (record.belongsTo(session) && record.needsReconciliation()) {
                String key = JdbcRepositorySupport.valueKey(record.getExecutionCallId());
                if (key.compareTo(after) > 0) {
                    batch.put(key, record);
                    if (batch.size() > limit) {
                        batch.pollLastEntry();
                    }
                }
            }
        }
        return List.copyOf(batch.values());
    }

    @Override
    public synchronized List<ToolExecutionRecord> findBackgroundProcesses(
            RuntimeSessionRecord session, String afterExecutionCallId, int limit) {
        if (session == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException("session and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
        TreeMap<String, ToolExecutionRecord> batch = new TreeMap<>();
        for (ToolExecutionRecord record : recordsById.values()) {
            if (record.belongsTo(session) && !record.isTerminal()
                    && "background_v3_process".equals(
                            record.getReference().get("dispatchMode"))) {
                String key = JdbcRepositorySupport.valueKey(record.getExecutionCallId());
                if (key.compareTo(after) > 0) {
                    batch.put(key, record);
                    if (batch.size() > limit) {
                        batch.pollLastEntry();
                    }
                }
            }
        }
        return List.copyOf(batch.values());
    }

    @Override
    public synchronized List<ToolExecutionRecord> findByBinding(
            String bindingId, long runtimeGeneration,
            String afterExecutionCallId, int limit) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0 || limit < 1 || limit > 100) {
            throw new IllegalArgumentException(
                    "positive runtimeGeneration and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireWellFormed(
                        BrokerValues.requireId(afterExecutionCallId, "cursor"), "cursor"));
        TreeMap<String, ToolExecutionRecord> batch = new TreeMap<>();
        for (ToolExecutionRecord record : recordsById.values()) {
            if (id.equals(record.getBindingId())
                    && runtimeGeneration == record.getRuntimeGeneration()) {
                BrokerValues.requireWellFormed(record.getExecutionCallId(), "executionCallId");
                String key = JdbcRepositorySupport.valueKey(record.getExecutionCallId());
                if (key.compareTo(after) > 0) {
                    ToolExecutionRecord previous = batch.put(key, record);
                    if (previous != null
                            && !previous.getExecutionCallId().equals(record.getExecutionCallId())) {
                        throw new IllegalStateException("Tool execution-call hash collision");
                    }
                    if (batch.size() > limit) {
                        batch.pollLastEntry();
                    }
                }
            }
        }
        return List.copyOf(batch.values());
    }

    @Override
    public synchronized boolean hasActiveByRuntimeSession(
            String runtimeSessionId) {
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return recordsById.values().stream()
                .anyMatch(record -> id.equals(record.getRuntimeSessionId())
                        && !record.isTerminal());
    }

    @Override
    public synchronized boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        return recordsById.values().stream().anyMatch(record -> !record.isTerminal()
                && record.getBindingId().equals(bindingId)
                && record.getRuntimeGeneration() == runtimeGeneration
                && record.getRuntimeSessionId().equals(runtimeSessionId));
    }

    @Override
    public synchronized boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds) {
        return recordsById.values().stream().anyMatch(record -> !record.isTerminal()
                && record.getBindingId().equals(bindingId)
                && record.getRuntimeGeneration() == runtimeGeneration
                && record.getRuntimeSessionId().equals(runtimeSessionId)
                && !excludingExecutionCallIds.contains(record.getExecutionCallId()));
    }

    @Override
    public synchronized boolean hasActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return recordsById.values().stream()
                .anyMatch(record -> id.equals(record.getBindingId())
                        && record.getRuntimeGeneration() == runtimeGeneration
                        && !record.isTerminal());
    }

    private ToolExecutionRecord requireRecord(String executionCallId) {
        return recordsById.get(BrokerValues.requireId(executionCallId,
                "executionCallId"));
    }

    private static void requireCandidate(ToolExecutionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getLastSequence() != 0
                || candidate.getState()
                        != ToolExecutionRecord.State.PREPARED
                || candidate.getDispatchOwner() != null
                || candidate.getAuthorizedDispatchGeneration() != null) {
            throw new IllegalArgumentException(
                    "candidate must be a new prepared execution");
        }
    }

    private static void requireReplacement(ToolExecutionRecord expected,
            ToolExecutionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || !expected.sameDispatch(replacement)
                || replacement.getVersion() != expected.getVersion()
                || replacement.getLastSequence()
                        < expected.getLastSequence()) {
            throw new IllegalArgumentException(
                    "replacement must preserve execution identity, dispatch"
                            + " claim, version, and result sequence");
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
