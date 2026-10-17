package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
    /**
     * A discard that replaced a merge before the child's result was pinned:
     * the discard pins it first. Recorded by {@link #requestFinish}, never
     * asked for.
     */
    public static final String DISCARD_PINNED = "discard_pinned";
    /** A child Workspace that merges back when its child completes (I2). */
    public static final String WORKTREE = "worktree";
    /**
     * A read-only child Workspace (#13753 I3): its child reads a frozen copy
     * and every finish is a discard.
     */
    public static final String SNAPSHOT = "snapshot";

    private static final Set<String> SETTLED_SESSION_STATES = Set.of("CLOSED", "ARCHIVED", "DELETED");
    /** The columns a transition may set besides the state; anything else is refused. */
    private static final Set<String> COLUMNS = Set.of("repository_relative", "child_cwd_relative",
            "base_commit", "result_commit", "parent_tree", "merged_tree", "finish_request", "outcome_code",
            "conflict_paths", "last_error");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SELECT = "SELECT w.tenant_id, w.parent_session_id, w.child_run_id, w.child_workspace_id, w.parent_workspace_id AS workspace_id, w.workspace_generation, w.storage_id, w.parent_cwd_relative, w.repository_relative, w.child_cwd_relative, w.base_commit, w.result_commit, w.parent_tree, w.merged_tree, w.child_state AS state, w.finish_request, w.outcome_code, w.conflict_paths, w.last_error, o.claim_owner AS claimed_by, FLOOR(o.claim_until) AS claimed_until, o.claim_generation, o.attempt_count AS attempts, o.available_at AS next_retry_at, w.gmt_create, w.gmt_modified, o.request_json FROM ma_workspace w JOIN ma_operation o ON o.tenant_id = w.tenant_id AND o.operation_id = w.child_workspace_id AND o.operation_kind = 'CHILD_WORKSPACE'";
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.CHILD_WORKSPACE;

    /** One child Workspace row. */
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
            return DigestUtils.sha256Hex(
                    (tenantId + "\u0000" + parentSessionId + "\u0000" + childRunId)
                            .getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    /** Admits a worktree, the mode I1 and I2 prepare. */
    public Row admit(String tenantId, String parentSessionId, String childRunId,
            ContextBinding parent, long now) {
        return admit(tenantId, parentSessionId, childRunId, parent, WORKTREE, now);
    }

    /**
     * Admits the preparation of one child run's Workspace from the
     * parent's binding, or answers the row an earlier admission wrote. A
     * run's mode is fixed on its record and kept in the operation's
     * request, which nothing rewrites; a row admitted for the other mode
     * is a conflict, never a second Workspace (#13753 I3).
     */
    public Row admit(String tenantId, String parentSessionId, String childRunId,
            ContextBinding parent, String workspaceMode, long now) {
        if (!WORKTREE.equals(workspaceMode) && !SNAPSHOT.equals(workspaceMode)) {
            throw new IllegalArgumentException("Unknown child Workspace mode " + workspaceMode);
        }
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, tenantId);
            var storages = jdbc.queryForList("SELECT storage_id FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ? FOR UPDATE",
                    String.class, tenantId, parent.getWorkspaceId());
            if (storages.size() != 1 || !parent.getStorageId().equals(storages.getFirst())) {
                throw WorkspaceExecutionStore.unavailable();
            }
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, tenantId, storages.getFirst());
            String childId = childWorkspaceId(tenantId, parentSessionId, childRunId);
            jdbc.update("INSERT IGNORE INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state, workspace_kind, parent_workspace_id, parent_session_id,"
                    + " child_run_id, child_workspace_id, parent_cwd_relative, child_state, gmt_create, gmt_modified)"
                    + " SELECT tenant_id, ?, ?, ?, display_name, config_ref, policy_ref, 'ACTIVE', 'CHILD_GIT', workspace_id,"
                    + " ?, ?, ?, ?, ?, ?, ? FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                    childId, parent.getWorkspaceGeneration(), parent.getStorageId(), parentSessionId, childRunId,
                    childId, parent.getCwdRelative(), PREPARING, now, now, tenantId, parent.getWorkspaceId());
            WorkspaceOperations operations = new WorkspaceOperations(jdbc, tenantId);
            if (operations.find(KIND, childId, true) == null) {
                // A worktree's request stays exactly as before; only a
                // snapshot names its mode, so a row without one is a worktree.
                Map<String, Object> request = new LinkedHashMap<>(Map.of("tenantId", tenantId,
                        "parentSessionId", parentSessionId, "childRunId", childRunId, "childWorkspaceId", childId));
                if (SNAPSHOT.equals(workspaceMode)) {
                    request.put("workspaceMode", SNAPSHOT);
                }
                operations.create(KIND, childId, WorkspaceOperations.values("session_id", parentSessionId,
                        "storage_id", parent.getStorageId(), "state", PREPARING, "phase", PREPARING, "delivery_state", "PENDING", "available_at", now,
                        "request_json", JSON.valueToTree(request).toString()));
            }
            Row row = find(tenantId, parentSessionId, childRunId);
            if (row == null) {
                throw new ApiException(HttpStatus.CONFLICT, "child_workspace_conflict",
                        "The child Workspace is unavailable.");
            }
            if (!workspaceMode.equals(row.workspaceMode())) {
                throw new ApiException(HttpStatus.CONFLICT, "child_workspace_conflict",
                        "The child Workspace was admitted for another mode.");
            }
            return row;
        });
    }

    public Row find(String tenantId, String parentSessionId, String childRunId) {
        List<Row> rows = jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.parent_session_id = ?"
                + " AND w.child_run_id = ?", this::row, tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The rows owing a step: an active state, a merge or discard asked of
     * a ready row, or a discard asked of an ended one. Never a row parked
     * ahead or claimed: every step releases its claim when it ends, so a
     * live claim is a step running right now.
     */
    public List<Row> findDue(long now, int limit) {
        return jdbc.query(SELECT + " WHERE o.delivery_state = 'PENDING' AND o.available_at <= ? AND (o.claim_until IS NULL OR o.claim_until <= ?) ORDER BY o.available_at, o.operation_key LIMIT ?",
                this::row, now, now, limit);
    }

    /**
     * Claims the row for one step, advancing its claim generation, when it
     * is unclaimed or its claim expired. A live claim is a step running
     * right now, in this process or another, so even its own worker cannot
     * claim it twice. Answers the claimed row, or null.
     */
    public Row claim(Row row, String owner, long now, long leaseMillis) {
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, row.tenantId());
            String storage = WorkspaceExecutionStore.storageKey(jdbc, new ContextBinding(row.tenantId(), row.workspaceId(),
                    row.workspaceGeneration(), row.storageId(), ".", com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1));
            List<String> physical = jdbc.queryForList("SELECT holder_key FROM ma_storage_owner WHERE storage_key = ?"
                    + " AND maintenance_id = ? AND holder_key IS NOT NULL FOR UPDATE", String.class, storage, row.childWorkspaceId());
            if (!physical.isEmpty()) {
                return null;
            }
            int claimed = jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_until = ?, claim_generation = claim_generation + 1, gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'CHILD_WORKSPACE' AND (claim_until IS NULL OR claim_until <= ?)",
                    owner, Math.addExact(now, leaseMillis), now, operationKey(row), now);
            if (claimed != 1) {
                return null;
            }
            Row current = find(row.tenantId(), row.parentSessionId(), row.childRunId());
            return current != null && owner.equals(current.claimedBy()) ? current : null;
        });
    }

    /**
     * Moves a claimed row from its state to {@code toState}, setting the
     * given columns and clearing the retry bookkeeping. False when the
     * state or the claim moved on: the step must not be reported done.
     */
    public boolean transition(Row claimed, String owner, String toState, Map<String, Object> columns, long now) {
        WorkspaceOperations.requireState(KIND, toState);
        return transaction.execute(status -> {
            if (!lockClaim(claimed, owner, now)) {
                return false;
            }
            StringBuilder sql = new StringBuilder("UPDATE ma_workspace SET child_state = ?, gmt_modified = ?");
            List<Object> args = new ArrayList<>(List.of(toState, now));
            for (Map.Entry<String, Object> column : columns.entrySet()) {
                if (!COLUMNS.contains(column.getKey())) {
                    throw new IllegalArgumentException("Unknown child Workspace column " + column.getKey());
                }
                sql.append(", ").append(column.getKey()).append(" = ?");
                Object value = column.getValue();
                args.add(value instanceof List<?> list ? json(list) : value);
            }
            sql.append(" WHERE tenant_id = ? AND workspace_id = ? AND child_state = ?");
            args.addAll(List.of(claimed.tenantId(), claimed.childWorkspaceId(), claimed.state()));
            if (jdbc.update(sql.toString(), args.toArray()) != 1) {
                return false;
            }
            Row current = find(claimed.tenantId(), claimed.parentSessionId(), claimed.childRunId());
            jdbc.update("UPDATE ma_operation SET state = ?, phase = ?, delivery_state = ?, attempt_count = 0, available_at = 0,"
                    + " gmt_modified = ? WHERE operation_key = ?", toState, toState,
                    owesWork(toState, current.finishRequest()) ? "PENDING" : "IDLE", now, operationKey(claimed));
            return true;
        });
    }

    /**
     * Starts the finish a claimed ready row owes: moves it to {@code
     * toState} only while its finish request is still {@code finish}, so a
     * discard that replaced an unstarted merge is never overrun by the
     * merge it replaced.
     */
    public boolean startFinish(Row claimed, String owner, String toState, String finish, long now) {
        return transaction.execute(status -> {
            if (!lockClaim(claimed, owner, now)) {
                return false;
            }
            Row current = find(claimed.tenantId(), claimed.parentSessionId(), claimed.childRunId());
            return current != null && finish.equals(current.finishRequest())
                    && transition(claimed, owner, toState, columns("last_error", null), now);
        });
    }

    /** Whether every child Session bound to the row's run is closed (or there is none). */
    public boolean childSessionsClosed(Row row) {
        return jdbc.queryForList("SELECT status FROM ma_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ? AND parent_child_run_id = ?", String.class,
                row.tenantId(), row.parentSessionId(), row.childRunId()).stream()
                .allMatch(SETTLED_SESSION_STATES::contains);
    }

    /** Parks a claimed row until {@code nextRetryAt}, counting the attempt when asked. */
    public boolean retry(Row claimed, String owner, boolean countAttempt, long nextRetryAt, String error, long now) {
        return transaction.execute(status -> {
            if (!lockClaim(claimed, owner, now)) {
                return false;
            }
            jdbc.update("UPDATE ma_workspace SET last_error = ?, gmt_modified = ? WHERE tenant_id = ? AND workspace_id = ?",
                    StringUtils.truncate(error, 1024), now, claimed.tenantId(), claimed.childWorkspaceId());
            return jdbc.update("UPDATE ma_operation SET attempt_count = attempt_count + ?, available_at = ?,"
                    + " claim_owner = NULL, claim_until = NULL, gmt_modified = ? WHERE operation_key = ?"
                    + " AND claim_generation = ? AND claim_owner = ?", countAttempt ? 1 : 0, nextRetryAt, now,
                    operationKey(claimed), claimed.claimGeneration(), owner) == 1;
        });
    }

    /** Extends a live claim; false once the claim moved on. */
    public boolean renew(Row claimed, String owner, long until, long now) {
        return jdbc.update("UPDATE ma_operation SET claim_until = ?, gmt_modified = ? WHERE operation_key = ? AND claim_generation = ? AND claim_owner = ? AND claim_until > ?", until, now,
                operationKey(claimed), claimed.claimGeneration(), owner, now) == 1;
    }

    /** Gives a claimed row back without touching anything else. */
    public void release(Row claimed, String owner, long now) {
        jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL, gmt_modified = ?"
                + " WHERE operation_key = ? AND claim_generation = ? AND claim_owner = ?",
                now, operationKey(claimed), claimed.claimGeneration(), owner);
    }

    /**
     * Records the finish request of decision 8. The same request answers
     * the row; a different one is refused, except a discard that replaces
     * a merge not yet started (the row is still ready) or one that ended
     * conflicted or blocked. A merge needs a ready row. The request may be
     * recorded while a child Session bound to this run is open: the row
     * runs it only once every such Session is closed (#13753 I2), and the
     * row lock it takes is the one a creation takes, so a creation never
     * binds to a row whose finish was requested. A discard that replaces a
     * merge whose result is not pinned yet (one not started, or one that
     * ended blocked before its pin) is recorded as {@link #DISCARD_PINNED}:
     * the merge was asked because the child completed, so its work stays
     * at the result ref although it does not land. A snapshot's every
     * finish is a discard (#13753 I3), so a merge asked of one is recorded
     * as the discard it is: nothing ever waits for a merge that cannot run.
     */
    public Row requestFinish(String tenantId, String parentSessionId, String childRunId,
            String finish, long now) {
        if (!MERGE.equals(finish) && !DISCARD.equals(finish)) {
            throw new IllegalArgumentException("Unknown child Workspace finish " + finish);
        }
        return transaction.execute(status -> {
            List<Row> rows = jdbc.query(SELECT + " WHERE w.tenant_id = ? AND w.parent_session_id = ?"
                    + " AND w.child_run_id = ? FOR UPDATE", this::row, tenantId, parentSessionId, childRunId);
            if (rows.isEmpty()) {
                throw new ApiException(HttpStatus.NOT_FOUND, "child_workspace_not_found",
                        "The child run has no child Workspace.");
            }
            Row row = rows.getFirst();
            String asked = MERGE.equals(finish) && row.snapshot() ? DISCARD : finish;
            if (asked.equals(row.finishRequest())
                    || DISCARD.equals(asked) && DISCARD_PINNED.equals(row.finishRequest())) {
                return row;
            }
            String recorded = asked;
            if (MERGE.equals(asked)) {
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
                if (MERGE.equals(row.finishRequest()) && row.resultCommit() == null) {
                    recorded = DISCARD_PINNED;
                }
            }
            jdbc.update("UPDATE ma_workspace SET finish_request = ?, gmt_modified = ?"
                    + " WHERE tenant_id = ? AND workspace_id = ?", recorded, now, tenantId, row.childWorkspaceId());
            jdbc.update("UPDATE ma_operation SET available_at = 0, delivery_state = 'PENDING', gmt_modified = ? WHERE operation_key = ?",
                    now, operationKey(row));
            return find(tenantId, parentSessionId, childRunId);
        });
    }

    private static boolean owesWork(String state, String finish) {
        return Set.of(PREPARING, MERGING, APPLYING, APPLIED, DISCARDING).contains(state)
                || READY.equals(state) && finish != null
                || Set.of(CONFLICTED, BLOCKED, FAILED).contains(state) && finish != null && Set.of(DISCARD, DISCARD_PINNED).contains(finish);
    }

    private boolean lockClaim(Row row, String owner, long now) {
        List<Boolean> claims = jdbc.query("SELECT claim_owner, claim_generation, FLOOR(claim_until) AS lease_epoch, state FROM ma_operation WHERE operation_key = ? FOR UPDATE", (result, index) -> owner.equals(result.getString("claim_owner"))
                        && row.claimGeneration() == result.getLong("claim_generation")
                        && row.state().equals(result.getString("state"))
                        && result.getObject("lease_epoch") != null
                        && result.getLong("lease_epoch") > now, operationKey(row));
        return claims.size() == 1 && claims.getFirst();
    }

    private static String operationKey(Row row) {
        return WorkspaceOperations.key(KIND, row.tenantId(), row.childWorkspaceId());
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
                result.getLong("gmt_create"), result.getLong("gmt_modified"),
                workspaceMode(result.getString("request_json")));
    }

    /** The mode a row's request names; a request naming none is a worktree's. */
    static String workspaceMode(String request) {
        try {
            var mode = JSON.readTree(request).path("workspaceMode");
            return mode.isTextual() ? mode.asText() : WORKTREE;
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("A child Workspace's request is unreadable", error);
        }
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

    /** The columns a transition sets, in order. */
    public static Map<String, Object> columns(Object... pairs) {
        Map<String, Object> columns = new LinkedHashMap<>();
        for (int index = 0; index + 1 < pairs.length; index += 2) {
            columns.put((String) pairs[index], pairs[index + 1]);
        }
        return columns;
    }
}
