package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * H4b: the JDBC side of the child result relay — its V54 ledger plus the
 * small reads the worker needs (pending child-agent rows over the
 * delivery-pending index, launch bodies and envelopes from the Session
 * resource store, the child turn line, and the terminal result content).
 * The ledger's classifications (`orphaned`, `unknown`) are terminal: they
 * never represent consumption and never authorize re-execution, surviving
 * worker restarts by construction.
 */
@Repository
public class ChildResultRelayStore {
    /** One child run the delivery-pending index surfaced. */
    public record PendingChild(String tenantId, String parentSessionId,
            String childRunId, long revision, String deliveryState,
            String recordResourceId) {
    }

    /** One relay ledger row. */
    public record RelayRow(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String childSessionId,
            String state, String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long createdAt,
            long updatedAt) {
    }

    /** The child Session's latest Turn line, as the relay reads it —
     * with the G3 dispatch pair on board: a Turn whose admission never
     * landed (no submission mark, no harness epoch) is a pre-admission
     * failure, never proof that a Runtime binding ever existed. */
    public record TurnLine(String turnId, String status, Long completedAt,
            String errorCode, boolean submissionAttempted,
            String harnessEventEpoch) {
        /** Whether this Turn proves a dispatch went out — the same pair
         * the G3 submission machinery guards with. */
        public boolean dispatched() {
            return submissionAttempted || harnessEventEpoch != null;
        }

        /** Whether this Turn is the terminal pre-admission failure: an
         * undispatched, terminally failed (or cancelled) admission. A
         * live enqueued ACCEPTED Turn shares `!dispatched()` with it —
         * only the terminal half may ever settle a never-started
         * verdict (R24's runnable-Turn guard). */
        public boolean preAdmissionTerminal() {
            return ("FAILED".equals(status) || "CANCELLED".equals(status))
                    && !dispatched();
        }
    }

    // delivery_state is null on the shell kind, and the relay drives only
    // the child_agent kind: a workflow child's execution belongs to the
    // workflow runtime, which does not exist yet (H4c registers the kind
    // disabled), so its rows never reach this page; the ledger join
    // drops every row whose classification is terminal (delivered,
    // orphaned or given up), because the bounded discovery set is for
    // work still owed — accumulated terminal rows would otherwise starve
    // the fleet-wide scan behind an ORDER BY created_at LIMIT. The
    // eligibility halves apply to both delivery arms: an unfiltered
    // accepted/consumed arm lets backed-off or foreign-leased rows squat
    // every slot of the bounded page, so a newer due launch is never
    // reached. A lease hides a row from other workers, never from its
    // claimant (claim() lets that owner continue immediately, and the
    // five-second heartbeat would otherwise wait out the thirty-second
    // lease). A record whose delivery already advanced (the consumer
    // raced ahead) owes its ledger the owed-work walk no matter which
    // intermediate state an interruption left it in — a watching or
    // delivering row owes mark_accepted/close/classify; a binding row
    // whose settle committed (and whose close_debt write then failed) is
    // owed exactly the same retention, so the arm admits every
    // non-terminal state. The cancelled arm is the same debt: the
    // FAILED/CANCELLED arm's fail commit moves delivery to `cancelled`
    // while the close admission may still be owed, and this page is the
    // only thing that can ever drive that admission again. `close_debt`
    // rides the same arm: the parent's settlement commits first so
    // quota never waits on a host's close capability, and the ledger
    // row keeps the retained close admission discoverable until a
    // capable scan discharges it.
    // Debts sort after every other due row: they accumulate one per
    // finished child where close is unavailable, and ahead of the page
    // they would keep a newer launch from ever being reached.
    private static final String PENDING_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.revision,"
                    + " r.delivery_state, r.record_resource_id"
                    + " FROM qwen_managed_session_extension_record r"
                    + " LEFT JOIN qwen_managed_child_result_relay l"
                    + " ON l.parent_session_id = r.session_id"
                    + " AND l.child_run_id = r.record_id"
                    + " WHERE r.domain = 'child_run'"
                    + " AND r.task_kind = 'child_agent'"
                    + " AND ((r.delivery_state IN ('planned', 'accepting',"
                    + " 'unknown') AND (l.state IS NULL OR l.state NOT IN"
                    + " ('done', 'orphaned', 'unknown')))"
                    + " OR (r.delivery_state IN ('accepted', 'consumed',"
                    + " 'cancelled') AND l.state NOT IN ('done',"
                    + " 'orphaned', 'unknown')))"
                    + " AND (l.next_retry_at IS NULL OR l.next_retry_at <= ?)"
                    + " AND (l.claimed_until IS NULL OR l.claimed_until <="
                    + " ? OR l.claimed_by = ?)"
                    + " ORDER BY CASE WHEN l.state = 'close_debt' THEN 1"
                    + " ELSE 0 END, r.created_at, r.session_id, r.record_id"
                    + " LIMIT ?";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public ChildResultRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<PendingChild> findPendingChildren(String workerId, int limit) {
        return findPendingChildren(workerId, System.currentTimeMillis(),
                limit);
    }

    /** The owed-work page for one worker: either arm, not terminal, not
     * parked ahead, never leased to another worker — the scanning worker's
     * own claim stays visible, so the heartbeat can fire on time. */
    public List<PendingChild> findPendingChildren(String workerId, long now,
            int limit) {
        return jdbc.query(PENDING_SQL, (result, row) -> new PendingChild(
                result.getString("tenant_id"), result.getString("session_id"),
                result.getString("record_id"), result.getLong("revision"),
                result.getString("delivery_state"),
                result.getString("record_resource_id")), now, now, workerId,
                limit);
    }

    /** The record's delivery state as committed NOW, for the worker that
     * claimed its ledger row: the discovery page's own captured value can
     * be wholesale older than a settlement committed between the page
     * and the claim — retirement authorization always reads it here. */
    public String deliveryState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The record's execution line as committed — the give-up's proof
     * of start. The `runtime_state` column is the Runtime projection
     * (`unbound`, `provisioning`, `ready`), never the execution enum, so
     * the proof reads the record's own body: the wire's transition
     * legality already says whether a dispatch ever attached (`intent →
     * dispatch_started → running_attached` only). A null answer means no
     * committed record row at all; a row whose body cannot prove its
     * line owes the caller a bounded retry, never a guessed verdict. */
    public String executionState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, rows.getFirst());
        JsonNode execution;
        try {
            execution = text == null ? null
                    : MAPPER.readTree(text).path("run").path("execution");
        } catch (Exception error) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record is unreadable", error);
        }
        if (execution == null || !execution.isTextual()) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record holds no execution line");
        }
        return execution.textValue();
    }

    /** The run's stop request and whether its run line has ended, as
     * the latest committed body states them (H4f). */
    public record StopState(boolean stopRequested, boolean ended) {
    }

    /** The committed stop state of one child run, or null when no record
     * row exists; an unreadable body owes the caller a bounded retry. */
    public StopState stopState(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query(
                "SELECT record_resource_id FROM"
                        + " qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND record_id = ?",
                (result, row) -> result.getString("record_resource_id"),
                tenantId, parentSessionId, childRunId);
        if (rows.isEmpty()) {
            return null;
        }
        String text = readResource(tenantId, rows.getFirst());
        JsonNode body;
        try {
            body = text == null ? null : MAPPER.readTree(text);
        } catch (Exception error) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record is unreadable", error);
        }
        if (body == null || !body.path("stopRequested").isBoolean()
                || !body.path("run").path("state").isTextual()) {
            throw new IllegalStateException("Child run " + childRunId
                    + "'s committed record holds no stop line");
        }
        return new StopState(body.path("stopRequested").booleanValue(),
                ManagedExtensionRecords.TERMINAL.contains(
                        body.path("run").path("state").textValue()));
    }

    /** One inline resource's bytes, or null when it is not inline-held. */
    public String readResource(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query(
                "SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (result, row) -> result.getBytes("inline_bytes"), tenantId,
                resourceId);
        return rows.isEmpty() ? null
                : new String(rows.getFirst(),
                        java.nio.charset.StandardCharsets.UTF_8);
    }

    /** One non-terminal child run a closing Session still owns. */
    public record LiveScope(String childRunId, String recordResourceId) {
    }

    /**
     * The non-terminal child-agent runs of one Session, for the close
     * cascade: task projections say what is still alive; the bodies name
     * the child Sessions (null when creation never attached). Like the
     * relay's discovery page, the cascade acts on the child_agent kind
     * only until the workflow runtime exists.
     */
    public List<LiveScope> findLiveScopes(String tenantId,
            String parentSessionId) {
        return jdbc.query(
                "SELECT record_id, record_resource_id"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND delivery_state IS NOT NULL"
                        + " AND task_kind = 'child_agent'"
                        + " AND task_state NOT IN ('completed', 'failed',"
                        + " 'cancelled')"
                        + " ORDER BY created_at, record_id",
                (result, row) -> new LiveScope(
                        result.getString("record_id"),
                        result.getString("record_resource_id")),
                tenantId, parentSessionId);
    }

    /** Whether a Session currently holds the acceptance of one child run. */
    public boolean hasAcceptance(String tenantId, String sessionId,
            String childRunId) {
        return !jdbc.query(
                "SELECT record_key FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_acceptance'"
                        + " AND record_id = ?",
                (result, row) -> result.getString("record_key"), tenantId,
                sessionId, childRunId).isEmpty();
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The child Session's newest Turn, or null while none exists. */
    public TurnLine latestTurn(String tenantId, String sessionId) {
        List<TurnLine> rows = jdbc.query(
                "SELECT turn_id, status, completed_at, error_code,"
                        + " submission_attempted, harness_event_epoch"
                        + " FROM managed_agent_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY created_at DESC, turn_id DESC LIMIT 1",
                (result, row) -> new TurnLine(result.getString("turn_id"),
                        result.getString("status"),
                        (Long) result.getObject("completed_at"),
                        result.getString("error_code"),
                        result.getBoolean("submission_attempted"),
                        result.getString("harness_event_epoch")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The terminal result content: the completed Turn's newest assistant
     * message's joined text, or null while none exists. */
    public String terminalResultText(String tenantId, String sessionId,
            String turnId) {
        List<String> items = jdbc.query(
                "SELECT i.item_id FROM managed_agent_item i"
                        + " WHERE i.tenant_id = ? AND i.session_id = ?"
                        + " AND i.turn_id = ? AND i.item_type = 'message'"
                        + " AND i.item_role = 'assistant'"
                        + " ORDER BY i.last_sequence DESC, i.item_id DESC"
                        + " LIMIT 1",
                (result, row) -> result.getString("item_id"), tenantId,
                sessionId, turnId);
        if (items.isEmpty()) {
            return null;
        }
        List<String> parts = jdbc.query(
                "SELECT part_text FROM managed_agent_item_part"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND item_id = ? AND part_type = 'output_text'"
                        + " ORDER BY last_sequence, part_id",
                (result, row) -> result.getString("part_text"), tenantId,
                sessionId, items.getFirst());
        return parts.isEmpty() ? null : String.join("\n", parts);
    }

    /** Insert-or-claim: returns the row this worker now owns, or null when
     * another live claim holds it. The creation key dedupes racing scans. */
    public RelayRow claim(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String owner,
            long leaseUntil, long now) {
        RelayRow existing = find(tenantId, parentSessionId, childRunId);
        if (existing == null) {
            jdbc.update("INSERT IGNORE INTO qwen_managed_child_result_relay"
                            + " (tenant_id, parent_session_id, child_run_id,"
                            + " creation_key, child_session_id, state,"
                            + " claimed_by, claimed_until, attempts,"
                            + " next_retry_at, created_at, updated_at)"
                            + " VALUES (?, ?, ?, ?, NULL, 'creating', ?, ?,"
                            + " 0, ?, ?, ?)",
                    tenantId, parentSessionId, childRunId, creationKey, owner,
                    leaseUntil, now, now, now);
            existing = find(tenantId, parentSessionId, childRunId);
        }
        if (existing == null) {
            return null;
        }
        if (owner.equals(existing.claimedBy())
                || existing.claimedUntil() < now) {
            int claimed = jdbc.update(
                    "UPDATE qwen_managed_child_result_relay SET claimed_by = ?,"
                            + " claimed_until = ?, updated_at = ?"
                            + " WHERE tenant_id = ? AND parent_session_id = ?"
                            + " AND child_run_id = ? AND (claimed_by = ? OR"
                            + " claimed_until < ?)",
                    owner, leaseUntil, now, tenantId, parentSessionId,
                    childRunId, existing.claimedBy(), now);
            if (claimed == 1) {
                return find(tenantId, parentSessionId, childRunId);
            }
        }
        return null;
    }

    public RelayRow find(String tenantId, String parentSessionId,
            String childRunId) {
        List<RelayRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_child_result_relay"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ?",
                (result, row) -> new RelayRow(result.getString("tenant_id"),
                        result.getString("parent_session_id"),
                        result.getString("child_run_id"),
                        result.getString("creation_key"),
                        result.getString("child_session_id"),
                        result.getString("state"),
                        result.getString("claimed_by"),
                        result.getLong("claimed_until"),
                        result.getInt("attempts"),
                        result.getLong("next_retry_at"),
                        result.getString("last_error"),
                        result.getLong("created_at"),
                        result.getLong("updated_at")),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The child Session the committed lineage names for one run, whatever
     * any ledger row remembers: createChildSession stamps the child's own
     * row before the relay records its answer, so a window where both the
     * parent body and the ledger lack the id still identifies the child
     * here — the disproving evidence for `not_started_proven`.
     */
    public String findLineageChild(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query("SELECT session_id FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?"
                        + " AND parent_child_run_id = ?",
                (result, row) -> result.getString("session_id"), tenantId,
                parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One held claim advances: state, optional child Session, and the
     * retry/backoff line, all flagged to the claiming worker. */
    public void advance(RelayRow row, String owner, String state,
            String childSessionId, long nextRetryAt, String lastError,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " child_session_id = ?, attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state, childSessionId, Math.max(row.attempts(), 0),
                nextRetryAt, lastError, owner, leaseUntil, now,
                row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }

    /** A still-running child is not a failed step: no attempt, just the
     * next look. */
    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET"
                        + " next_retry_at = ?, claimed_until = ?,"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND parent_session_id = ? AND child_run_id = ?"
                        + " AND claimed_by = ?",
                nextRetryAt, leaseUntil, now, row.tenantId(),
                row.parentSessionId(), row.childRunId(), owner);
    }

    /** A failed step counts an attempt and reschedules with backoff. */
    public void defer(RelayRow row, String owner, long nextRetryAt,
            String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                row.attempts() + 1, nextRetryAt,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                owner, leaseUntil, now, row.tenantId(), row.parentSessionId(),
                row.childRunId(), owner);
    }

    /** A Classification is terminal: no claim, no retry, no redelivery —
     * and only the claimant may write it. */
    public void classify(RelayRow row, String owner, String state,
            String lastError, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " claimed_by = NULL, claimed_until = NULL,"
                        + " last_error = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                now, row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }
}
