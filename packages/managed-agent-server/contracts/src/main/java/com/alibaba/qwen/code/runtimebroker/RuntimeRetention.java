package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;

public interface RuntimeRetention {
    public enum Phase { BINDINGS, EXECUTIONS, SESSIONS }

    public record Cursor(String bindingState, Instant lastActiveAt, String bindingId,
            Phase phase, String childState, String childKey) { }

    public record BatchResult(Cursor cursor, int bindingsScanned, int childrenScanned, int skipped,
            int executionsDeleted, int sessionsDeleted, int bindingsDeleted) { }

    public BatchResult sweep(Duration maxAge, int batchSize, Cursor cursor);
}
