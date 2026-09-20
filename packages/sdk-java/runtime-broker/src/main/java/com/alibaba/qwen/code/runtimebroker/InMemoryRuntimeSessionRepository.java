package com.alibaba.qwen.code.runtimebroker;

import java.util.HashMap;
import java.util.Map;

/** Process-local logical Session repository for tests and single-node use. */
public final class InMemoryRuntimeSessionRepository
        implements RuntimeSessionRepository {
    private final Map<String, RuntimeSessionRecord> records = new HashMap<>();

    @Override
    public synchronized RuntimeSessionRecord findOrCreate(
            RuntimeSessionRecord candidate) {
        if (candidate == null || candidate.getVersion() != 0
                || candidate.getState()
                        != RuntimeSessionRecord.State.ACQUIRING) {
            throw new IllegalArgumentException(
                    "candidate must be a new acquiring Session");
        }
        RuntimeSessionRecord existing = records.get(
                candidate.getRuntimeSessionId());
        if (existing != null) {
            if (!existing.sameIdentity(candidate)) {
                throw new IllegalArgumentException(
                        "runtimeSessionId is bound to another Session identity");
            }
            return existing;
        }
        records.put(candidate.getRuntimeSessionId(), candidate);
        return candidate;
    }

    @Override
    public synchronized RuntimeSessionRecord findById(
            String runtimeSessionId) {
        return records.get(BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId"));
    }

    @Override
    public synchronized RuntimeSessionRecord compareAndSet(
            RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) {
        requireReplacement(expected, replacement);
        RuntimeSessionRecord current = records.get(
                expected.getRuntimeSessionId());
        if (current == null
                || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion()) {
            return null;
        }
        if (!current.isActive() && replacement.isActive()) {
            throw new IllegalArgumentException(
                    "terminal Session cannot be reactivated");
        }
        RuntimeSessionRecord updated = replacement.withVersion(
                expected.getVersion() + 1);
        records.put(updated.getRuntimeSessionId(), updated);
        return updated;
    }

    @Override
    public synchronized long countActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return records.values().stream()
                .filter(RuntimeSessionRecord::isActive)
                .filter(record -> id.equals(record.getBindingId()))
                .filter(record -> runtimeGeneration
                        == record.getRuntimeGeneration())
                .count();
    }

    private static void requireReplacement(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve Session identity and version");
        }
    }
}
