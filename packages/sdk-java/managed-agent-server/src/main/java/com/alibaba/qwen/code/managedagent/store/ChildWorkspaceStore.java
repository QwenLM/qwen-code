package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The durable command of a child Workspace (#13753 I1): one row per child
 * run in {@code qwen_managed_child_workspace} (V60). The row holds the
 * recorded base, the merge evidence and the outcome. Claims fence its
 * writers: every transition compares the state and the claim generation,
 * so a worker whose claim expired cannot commit a step. See
 * docs/design/2026-10-09-managed-child-workspace.md.
 */
@Repository
public class ChildWorkspaceStore {
    public static final String PREPARING = "preparing";
    public static final String READY = "ready";
    public static final String MERGING = "merging";
    public static final String APPLYING = "applying";
    /** The merge is in the parent's working tree; only the worktree and the pins remain. */
    public static final String APPLIED = "applied";
    public static final String MERGED = "merged";
    public static final String CONFLICTED = "conflicted";
    public static final String DISCARDING = "discarding";
    public static final String DISCARDED = "discarded";
    public static final String FAILED = "failed";
    public static final String BLOCKED = "blocked";
    public static final String MERGE = "merge";
    public static final String DISCARD = "discard";

    private static final Set<String> SETTLED_SESSION_STATES = Set.of("CLOSED", "ARCHIVED", "DELETED");
    /** The columns a transition may set besides the state; anything else is refused. */
    private static final Set<String> COLUMNS = Set.of("repository_relative", "child_cwd_relative",
            "base_commit", "result_commit", "parent_tree", "merged_tree", "finish_request", "outcome_code",
            "conflict_paths", "last_error");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SELECT = "SELECT tenant_id, parent_session_id, child_run_id,"
            + " child_workspace_id, workspace_id, workspace_generation, storage_id,"
            + " parent_cwd_relative, repository_relative, child_cwd_relative, base_commit,"
            + " result_commit, parent_tree, merged_tree, state, finish_request, outcome_code,"
            + " conflict_paths, last_error, claimed_by, claimed_until, claim_generation, attempts,"
            + " next_retry_at, created_at, updated_at FROM qwen_managed_child_workspace";

    /** One child Workspace row. */
    public record Row(String tenantId, String parentSessionId, String childRunId,
            String childWorkspaceId, String workspaceId, long workspaceGeneration, String storageId,
            String parentCwdRelative, String repositoryRelative, String childCwdRelative,
            String baseCommit, String resultCommit, String parentTree, String mergedTree,
            String state, String finishRequest, String outcomeCode, List<String> conflictPaths,
            String lastError, String claimedBy, Long claimedUntil, long claimGeneration,
            int attempts, long nextRetryAt, long createdAt, long updatedAt) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public ChildWorkspaceStore(JdbcTemplate jdbc, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /**
     * The id that names a child Workspace's directory and pins: the first
     * 32 hex digits of sha256(tenant NUL parent NUL childRunId).
     */
    public static String childWorkspaceId(String tenantId, String parentSessionId, String childRunId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    (tenantId + "\u0000" + parentSessionId + "\u0000" + childRunId)
                            .getBytes(StandardCharsets.UTF_8))).substring(0, 32);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    /**
     * Admits the preparation of one child run's Workspace from the
     * parent's binding, or answers the row an earlier admission wrote.
     */
    public Row admit(String tenantId, String parentSessionId, String childRunId,
            ContextBinding parent, long now) {
        jdbc.update("INSERT IGNORE INTO qwen_managed_child_workspace (tenant_id, parent_session_id,"
                        + " child_run_id, child_workspace_id, workspace_id, workspace_generation,"
                        + " storage_id, parent_cwd_relative, state, created_at, updated_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenantId, parentSessionId, childRunId,
                childWorkspaceId(tenantId, parentSessionId, childRunId), parent.getWorkspaceId(),
                parent.getWorkspaceGeneration(), parent.getStorageId(), parent.getCwdRelative(),
                PREPARING, now, now);
        Row row = find(tenantId, parentSessionId, childRunId);
        if (row == null) {
            throw new ApiException(HttpStatus.CONFLICT, "child_workspace_conflict",
                    "The child Workspace belongs to another tenant.");
        }
        return row;
    }

    public Row find(String tenantId, String parentSessionId, String childRunId) {
        List<Row> rows = jdbc.query(SELECT + " WHERE tenant_id = ? AND parent_session_id = ?"
                + " AND child_run_id = ?", this::row, tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The rows owing a step: an active state, a merge or discard asked of
     * a ready row, or a discard asked of an ended one. Never a row parked
     * ahead or claimed: every step releases its claim when it ends, so a
     * live claim is a step running right now.
     */
    public List<Row> findDue(long now, int limit) {
        return jdbc.query(SELECT + " WHERE (state IN (?, ?, ?, ?, ?)"
                        + " OR (state = ? AND finish_request IS NOT NULL)"
                        + " OR (state IN (?, ?, ?) AND finish_request = ?))"
                        + " AND next_retry_at <= ?"
                        + " AND (claimed_until IS NULL OR claimed_until <= ?)"
                        + " ORDER BY next_retry_at, created_at, parent_session_id, child_run_id LIMIT ?",
                this::row, PREPARING, MERGING, APPLYING, APPLIED, DISCARDING, READY, CONFLICTED, BLOCKED,
                FAILED, DISCARD, now, now, limit);
    }

    /**
     * Claims the row for one step, advancing its claim generation, when it
     * is unclaimed or its claim expired. A live claim is a step running
     * right now, in this process or another, so even its own worker cannot
     * claim it twice. Answers the claimed row, or null.
     */
    public Row claim(Row row, String owner, long now, long leaseMillis) {
        int claimed = jdbc.update("UPDATE qwen_managed_child_workspace SET claimed_by = ?,"
                        + " claimed_until = ?, claim_generation = claim_generation + 1, updated_at = ?"
                        + " WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?"
                        + " AND (claimed_until IS NULL OR claimed_until <= ?)",
                owner, now + leaseMillis, now, row.parentSessionId(), row.childRunId(), row.tenantId(),
                now);
        if (claimed != 1) {
            return null;
        }
        Row current = find(row.tenantId(), row.parentSessionId(), row.childRunId());
        return current != null && owner.equals(current.claimedBy()) ? current : null;
    }

    /**
     * Moves a claimed row from its state to {@code toState}, setting the
     * given columns and clearing the retry bookkeeping. False when the
     * state or the claim moved on: the step must not be reported done.
     */
    public boolean transition(Row claimed, String owner, String toState, Map<String, Object> columns,
            long now) {
        StringBuilder sql = new StringBuilder("UPDATE qwen_managed_child_workspace SET state = ?,"
                + " attempts = 0, next_retry_at = 0, updated_at = ?");
        List<Object> args = new ArrayList<>(List.of(toState, now));
        for (Map.Entry<String, Object> column : columns.entrySet()) {
            if (!COLUMNS.contains(column.getKey())) {
                throw new IllegalArgumentException("Unknown child Workspace column " + column.getKey());
            }
            sql.append(", ").append(column.getKey()).append(" = ?");
            Object value = column.getValue();
            args.add(value instanceof List<?> list ? json(list) : value);
        }
        sql.append(" WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?"
                + " AND state = ? AND claim_generation = ? AND claimed_by = ?");
        args.addAll(List.of(claimed.parentSessionId(), claimed.childRunId(), claimed.tenantId(),
                claimed.state(), claimed.claimGeneration(), owner));
        return jdbc.update(sql.toString(), args.toArray()) == 1;
    }

    /**
     * Starts the finish a claimed ready row owes: moves it to {@code
     * toState} only while its finish request is still {@code finish}, so a
     * discard that replaced an unstarted merge is never overrun by the
     * merge it replaced.
     */
    public boolean startFinish(Row claimed, String owner, String toState, String finish, long now) {
        return jdbc.update("UPDATE qwen_managed_child_workspace SET state = ?, attempts = 0,"
                        + " next_retry_at = 0, last_error = NULL, updated_at = ? WHERE parent_session_id = ?"
                        + " AND child_run_id = ?"
                        + " AND tenant_id = ? AND state = ? AND claim_generation = ? AND claimed_by = ?"
                        + " AND finish_request = ?",
                toState, now, claimed.parentSessionId(), claimed.childRunId(), claimed.tenantId(),
                claimed.state(), claimed.claimGeneration(), owner, finish) == 1;
    }

    /** Whether every child Session bound to the row's run is closed (or there is none). */
    public boolean childSessionsClosed(Row row) {
        return jdbc.queryForList("SELECT status FROM managed_agent_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ? AND parent_child_run_id = ?", String.class,
                row.tenantId(), row.parentSessionId(), row.childRunId()).stream()
                .allMatch(SETTLED_SESSION_STATES::contains);
    }

    /** Parks a claimed row until {@code nextRetryAt}, counting the attempt when asked. */
    public boolean retry(Row claimed, String owner, boolean countAttempt, long nextRetryAt,
            String error, long now) {
        return jdbc.update("UPDATE qwen_managed_child_workspace SET attempts = attempts + ?,"
                        + " next_retry_at = ?, last_error = ?, claimed_by = NULL, claimed_until = NULL,"
                        + " updated_at = ? WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?"
                        + " AND state = ? AND claim_generation = ? AND claimed_by = ?",
                countAttempt ? 1 : 0, nextRetryAt, truncate(error), now, claimed.parentSessionId(),
                claimed.childRunId(), claimed.tenantId(), claimed.state(), claimed.claimGeneration(),
                owner) == 1;
    }

    /** Extends a live claim; false once the claim moved on. */
    public boolean renew(Row claimed, String owner, long until, long now) {
        return jdbc.update("UPDATE qwen_managed_child_workspace SET claimed_until = ?, updated_at = ?"
                        + " WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?"
                        + " AND claim_generation = ? AND claimed_by = ?",
                until, now, claimed.parentSessionId(), claimed.childRunId(), claimed.tenantId(),
                claimed.claimGeneration(), owner) == 1;
    }

    /** Gives a claimed row back without touching anything else. */
    public void release(Row claimed, String owner, long now) {
        jdbc.update("UPDATE qwen_managed_child_workspace SET claimed_by = NULL, claimed_until = NULL,"
                        + " updated_at = ? WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?"
                        + " AND claim_generation = ? AND claimed_by = ?",
                now, claimed.parentSessionId(), claimed.childRunId(), claimed.tenantId(),
                claimed.claimGeneration(), owner);
    }

    /**
     * Records the finish request of decision 8. The same request answers
     * the row; a different one is refused, except a discard that replaces
     * a merge not yet started (the row is still ready) or one that ended
     * conflicted or blocked. A merge needs a ready row. The request may be
     * recorded while a child Session bound to this run is open: the row
     * runs it only once every such Session is closed (#13753 I2), and the
     * row lock it takes is the one a creation takes, so a creation never
     * binds to a row whose finish was requested.
     */
    public Row requestFinish(String tenantId, String parentSessionId, String childRunId,
            String finish, long now) {
        if (!MERGE.equals(finish) && !DISCARD.equals(finish)) {
            throw new IllegalArgumentException("Unknown child Workspace finish " + finish);
        }
        return transaction.execute(status -> {
            List<Row> rows = jdbc.query(SELECT + " WHERE tenant_id = ? AND parent_session_id = ?"
                    + " AND child_run_id = ? FOR UPDATE", this::row, tenantId, parentSessionId, childRunId);
            if (rows.isEmpty()) {
                throw new ApiException(HttpStatus.NOT_FOUND, "child_workspace_not_found",
                        "The child run has no child Workspace.");
            }
            Row row = rows.getFirst();
            if (finish.equals(row.finishRequest())) {
                return row;
            }
            if (MERGE.equals(finish)) {
                if (row.finishRequest() != null) {
                    throw new ApiException(HttpStatus.CONFLICT, "child_workspace_conflict",
                            "The child Workspace is already being discarded.");
                }
                if (!READY.equals(row.state())) {
                    throw new ApiException(HttpStatus.CONFLICT, "child_workspace_not_ready",
                            "Only a ready child Workspace can be merged.");
                }
            } else {
                if (MERGED.equals(row.state())) {
                    throw new ApiException(HttpStatus.CONFLICT, "child_workspace_conflict",
                            "The child Workspace was already merged.");
                }
                if (DISCARDED.equals(row.state())) {
                    return row;
                }
                // A merge not yet started (the row is still ready) yields to
                // the discard; one that started runs to its end.
                if (MERGING.equals(row.state()) || APPLYING.equals(row.state()) || APPLIED.equals(row.state())) {
                    throw new ApiException(HttpStatus.CONFLICT, "child_workspace_finishing",
                            "The child Workspace is being merged.");
                }
            }
            jdbc.update("UPDATE qwen_managed_child_workspace SET finish_request = ?, next_retry_at = 0,"
                            + " updated_at = ? WHERE parent_session_id = ? AND child_run_id = ? AND tenant_id = ?",
                    finish, now, parentSessionId, childRunId, tenantId);
            return find(tenantId, parentSessionId, childRunId);
        });
    }

    private Row row(ResultSet result, int index) throws SQLException {
        String conflicts = result.getString("conflict_paths");
        return new Row(result.getString("tenant_id"), result.getString("parent_session_id"),
                result.getString("child_run_id"), result.getString("child_workspace_id"),
                result.getString("workspace_id"), result.getLong("workspace_generation"),
                result.getString("storage_id"), result.getString("parent_cwd_relative"),
                result.getString("repository_relative"), result.getString("child_cwd_relative"),
                result.getString("base_commit"), result.getString("result_commit"),
                result.getString("parent_tree"), result.getString("merged_tree"),
                result.getString("state"), result.getString("finish_request"),
                result.getString("outcome_code"), conflicts == null ? List.of() : paths(conflicts),
                result.getString("last_error"), result.getString("claimed_by"),
                result.getObject("claimed_until", Long.class), result.getLong("claim_generation"),
                result.getInt("attempts"), result.getLong("next_retry_at"),
                result.getLong("created_at"), result.getLong("updated_at"));
    }

    private static List<String> paths(String json) {
        try {
            return List.copyOf(JSON.readValue(json, new TypeReference<List<String>>() {
            }));
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("A child Workspace's conflict paths are unreadable", error);
        }
    }

    private static String json(List<?> values) {
        try {
            return JSON.writeValueAsString(values);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Conflict paths are not serializable", error);
        }
    }

    private static String truncate(String text) {
        return text == null || text.length() <= 1024 ? text : text.substring(0, 1024);
    }

    /** The columns a transition sets, in order. */
    public static Map<String, Object> columns(Object... pairs) {
        Map<String, Object> columns = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            columns.put((String) pairs[index], pairs[index + 1]);
        }
        return columns;
    }
}
