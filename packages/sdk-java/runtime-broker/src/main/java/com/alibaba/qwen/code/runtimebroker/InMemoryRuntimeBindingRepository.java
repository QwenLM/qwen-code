package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

/** Process-local Runtime binding repository for tests and single-node use. */
public final class InMemoryRuntimeBindingRepository
        implements RuntimeBindingRepository {
    private final Clock clock;
    private final Supplier<String> idSupplier;
    private final Map<String, RuntimeBindingRecord> records = new HashMap<>();
    private final Map<RuntimeProvisionRequest, String> active =
            new HashMap<>();
    private final Map<RuntimeProvisionRequest, Long> generations =
            new HashMap<>();

    public InMemoryRuntimeBindingRepository() {
        this(Clock.systemUTC(), () -> UUID.randomUUID().toString());
    }

    public InMemoryRuntimeBindingRepository(Clock clock,
            Supplier<String> idSupplier) {
        if (clock == null || idSupplier == null) {
            throw new IllegalArgumentException(
                    "clock and idSupplier are required");
        }
        this.clock = clock;
        this.idSupplier = idSupplier;
    }

    @Override
    public synchronized RuntimeBindingRecord findOrCreate(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        RuntimeBindingRecord existing = findActive(request);
        if (existing != null) {
            return existing;
        }
        long generation = generations.getOrDefault(request, 0L) + 1;
        generations.put(request, generation);
        Instant now = clock.instant();
        RuntimeBindingRecord created = new RuntimeBindingRecord(
                BrokerValues.requireId(idSupplier.get(), "bindingId"),
                request, generation,
                RuntimeBindingRecord.State.PROVISIONING, null, false, null,
                null, 0, 0, null, now);
        records.put(created.getBindingId(), created);
        active.put(request, created.getBindingId());
        return created;
    }

    @Override
    public synchronized RuntimeBindingRecord findActive(
            RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        String bindingId = active.get(request);
        RuntimeBindingRecord record = bindingId == null
                ? null : records.get(bindingId);
        if (record == null || !record.isActive()) {
            active.remove(request, bindingId);
            return null;
        }
        return record;
    }

    @Override
    public synchronized RuntimeBindingRecord findById(String bindingId) {
        return records.get(BrokerValues.requireId(bindingId, "bindingId"));
    }

    @Override
    public synchronized List<RuntimeBindingRecord> findActiveByIsolationKey(
            String isolationKey) {
        String key = BrokerValues.requireId(isolationKey, "isolationKey");
        List<RuntimeBindingRecord> matches = new ArrayList<>();
        for (RuntimeBindingRecord record : records.values()) {
            if (record.isActive() && key.equals(
                    record.getRequest().getIsolationKey())) {
                matches.add(record);
            }
        }
        return List.copyOf(matches);
    }

    @Override
    public synchronized RuntimeBindingRecord compareAndSet(
            RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        requireReplacement(expected, replacement);
        RuntimeBindingRecord current = records.get(expected.getBindingId());
        if (current == null
                || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion()) {
            return null;
        }
        RuntimeBindingRecord updated = replacement.withVersion(
                expected.getVersion() + 1);
        records.put(updated.getBindingId(), updated);
        if (updated.isActive()) {
            active.put(updated.getRequest(), updated.getBindingId());
        } else {
            active.remove(updated.getRequest(), updated.getBindingId());
        }
        return updated;
    }

    @Override
    public synchronized RuntimeBindingRecord claimOperation(String bindingId,
            String owner, Duration leaseDuration) {
        RuntimeBindingRecord current = requireRecord(bindingId);
        if (current == null) {
            return null;
        }
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = requireDuration(leaseDuration);
        Instant now = clock.instant();
        if (ownerId.equals(current.getOperationOwner())
                && current.getOperationLeaseUntil().isAfter(now)) {
            return current;
        }
        if (current.getOperationOwner() != null
                && current.getOperationLeaseUntil().isAfter(now)) {
            return null;
        }
        RuntimeBindingRecord claimed = current.withOperation(ownerId,
                now.plus(duration), current.getOperationGeneration() + 1)
                .withVersion(current.getVersion() + 1);
        records.put(bindingId, claimed);
        return claimed;
    }

    @Override
    public synchronized RuntimeBindingRecord renewOperation(String bindingId,
            String owner, long operationGeneration, Duration leaseDuration) {
        RuntimeBindingRecord current = requireRecord(bindingId);
        if (current == null) {
            return null;
        }
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = requireDuration(leaseDuration);
        Instant now = clock.instant();
        if (!ownerId.equals(current.getOperationOwner())
                || operationGeneration != current.getOperationGeneration()
                || !current.getOperationLeaseUntil().isAfter(now)) {
            return null;
        }
        RuntimeBindingRecord renewed = current.withOperation(ownerId,
                now.plus(duration), operationGeneration)
                .withVersion(current.getVersion() + 1);
        records.put(bindingId, renewed);
        return renewed;
    }

    private RuntimeBindingRecord requireRecord(String bindingId) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        RuntimeBindingRecord current = records.get(id);
        if (current == null || !current.isActive()) {
            return null;
        }
        return current;
    }

    private static void requireReplacement(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve binding identity and version");
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
