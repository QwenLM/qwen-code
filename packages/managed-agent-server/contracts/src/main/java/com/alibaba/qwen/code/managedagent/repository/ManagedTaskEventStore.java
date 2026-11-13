package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

public interface ManagedTaskEventStore {
    public static final int SCHEMA_VERSION = 1;

    public static final int PROJECTION_VERSION = 1;

    public static final int MAX_OUTPUT_CHARS = 16384;

    public static final int ARTIFACT_REF_BOUND = 100;

    public static final int RETAIN_TARGET = 256;

    public static final int BACKLOG_BOUND = 512;

    public static final String CODE_ADMISSION_REFUSED =
            "managed_task_output_admission_refused";

    public static final String CODE_FLOOR_PINNED =
            "managed_task_event_floor_pinned";

    public static final String CODE_BACKLOG_FULL =
            "managed_task_event_backlog_full";

    public static final String CODE_SEGMENT_CONFLICT =
            "managed_task_event_segment_conflict";

    public record TaskEvent(long sequence, String type, long occurredAt,
            int schemaVersion, int projectionVersion, String state,
            String runtimeState, String text, Boolean truncated,
            String artifactId, String captureId, String streamId,
            Long firstOrdinal, Long endOrdinal, boolean archived) {
    }

    public record EventPage(List<TaskEvent> events, boolean hasMore) {
    }

    public record CursorPositions(long lastSequence, long expiredThrough,
            List<String> artifactRefs) {
        public static final CursorPositions EMPTY = new CursorPositions(0, 0,
                List.of());
    }

    public CursorPositions positions(String tenantId, String sessionId, String taskId);

    public EventPage read(String tenantId, String sessionId, String taskId, long after, int limit);

    public void appendStateChange(String tenantId, String sessionId, String taskId, String state,
            String runtimeState, long occurredAt);

    public long appendOutput(String tenantId, String sessionId, String taskId, String text, boolean truncated,
            String captureId, String streamId, Long firstOrdinal, Long endOrdinal, long occurredAt);

    public long appendArtifact(String tenantId, String sessionId, String taskId, String artifactId, long occurredAt);

    public int markOutputArchived(String tenantId, String sessionId, String taskId, long throughSequence);

    public long expireThrough(String tenantId, String sessionId, String taskId, long throughSequence);

    public static String encodeCursor(String tenantId, String sessionId, String taskId, long sequence) {
        if (sequence < 0) {
            throw new IllegalArgumentException("A task cursor requires a nonnegative sequence");
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("tev2:" + ManagedSchemaKeys.key(tenantId, sessionId, taskId) + ":" + sequence)
                        .getBytes(StandardCharsets.US_ASCII));
    }

    public static long decodeCursor(String tenantId, String sessionId, String taskId, String cursor) {
        if (cursor == null || cursor.length() > 128) {
            throw invalidCursor();
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.US_ASCII);
        } catch (IllegalArgumentException error) {
            throw invalidCursor();
        }
        String[] parts = decoded.split(":", -1);
        if (parts.length != 3 || !"tev2".equals(parts[0])
                || !ManagedSchemaKeys.key(tenantId, sessionId, taskId).equals(parts[1])) {
            throw invalidCursor();
        }
        try {
            long position = Long.parseLong(parts[2]);
            if (position < 0) {
                throw new NumberFormatException();
            }
            return position;
        } catch (NumberFormatException error) {
            throw invalidCursor();
        }
    }

    public static ManagedAgentException invalidCursor() {
        return new ManagedAgentException(400, "invalid_event_cursor", "The task event cursor is invalid.");
    }
}
