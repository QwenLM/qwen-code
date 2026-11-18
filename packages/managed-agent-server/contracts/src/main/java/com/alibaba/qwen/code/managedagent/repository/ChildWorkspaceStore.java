package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public interface ChildWorkspaceStore {
    public static final String PREPARING = "preparing";

    public static final String READY = "ready";

    public static final String MERGING = "merging";

    public static final String APPLYING = "applying";

    public static final String APPLIED = "applied";

    public static final String MERGED = "merged";

    public static final String CONFLICTED = "conflicted";

    public static final String DISCARDING = "discarding";

    public static final String DISCARDED = "discarded";

    public static final String FAILED = "failed";

    public static final String BLOCKED = "blocked";

    public static final String MERGE = "merge";

    public static final String DISCARD = "discard";

    public static final String DISCARD_PINNED = "discard_pinned";

    public static final String WORKTREE = "worktree";

    public static final String SNAPSHOT = "snapshot";

    public record Row(String tenantId, String parentSessionId, String childRunId,
            String childWorkspaceId, String workspaceId, long workspaceGeneration, String storageId,
            String parentCwdRelative, String repositoryRelative, String childCwdRelative,
            String baseCommit, String resultCommit, String parentTree, String mergedTree,
            String state, String finishRequest, String outcomeCode, List<String> conflictPaths,
            String lastError, String claimedBy, Long claimedUntil, long claimGeneration,
            int attempts, long nextRetryAt, long createdAt, long updatedAt, String workspaceMode) {
        /** Whether the row is a read-only snapshot, whose every finish is a discard. */
        public boolean snapshot() {
            return SNAPSHOT.equals(workspaceMode);
        }
    }

    public Row admit(String tenantId, String parentSessionId, String childRunId,
            ContextBinding parent, long now);

    public Row admit(String tenantId, String parentSessionId, String childRunId,
            ContextBinding parent, String workspaceMode, long now);

    public Row find(String tenantId, String parentSessionId, String childRunId);

    public List<Row> findDue(long now, int limit);

    public Row claim(Row row, String owner, long now, long leaseMillis);

    public boolean transition(Row claimed, String owner, String toState, Map<String, Object> columns, long now);

    public boolean startFinish(Row claimed, String owner, String toState, String finish, long now);

    public boolean childSessionsClosed(Row row);

    public boolean retry(Row claimed, String owner, boolean countAttempt, long nextRetryAt, String error, long now);

    public boolean renew(Row claimed, String owner, long until, long now);

    public void release(Row claimed, String owner, long now);

    public Row requestFinish(String tenantId, String parentSessionId, String childRunId,
            String finish, long now);

    public static String childWorkspaceId(String tenantId, String parentSessionId, String childRunId) {
        try {
            return DigestUtils.sha256Hex(
                    (tenantId + "\u0000" + parentSessionId + "\u0000" + childRunId)
                            .getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static Map<String, Object> columns(Object... pairs) {
        Map<String, Object> columns = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            columns.put((String) pairs[index], pairs[index + 1]);
        }
        return columns;
    }
}
