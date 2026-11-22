package com.alibaba.qwen.code.managedagent.persistence;

/** The child result relay's discovery SQL, split from the store's execution logic. */
final class ChildResultRelayQueries {
    private ChildResultRelayQueries() { }

    /**
     * The child Session kinds — the {@code task_kind} values the relay
     * discovery page and the close cascade both act on (#13803): one SQL
     * list, so a third kind joins both queries or neither.
     */
    static final String CHILD_SESSION_KINDS_SQL =
            "('child_agent', 'workflow')";

    // delivery_state is null on the shell kind, and the relay drives the
    // two child Session kinds (`child_agent` and `workflow`, the latter
    // since the workflow runtime slice of #13803); the ledger join drops
    // every row whose classification is terminal (delivered, orphaned or
    // given up), because the bounded discovery set is for work still
    // owed — accumulated terminal rows would otherwise starve the
    // fleet-wide scan behind an ORDER BY gmt_create LIMIT. The
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
    // H2 otherwise retains the first branch limit across repeated executions.
    // The ledger's operation_id and the record_id it mirrors are both VARCHAR
    // under utf8mb4_bin, so plain equality is byte-exact (admission bans the
    // trailing spaces a PAD SPACE collation would fold).
    static String pendingSql() {
        return "SELECT pending.tenant_id, pending.session_id, pending.record_id, pending.revision, pending.delivery_state, pending.record_resource_id FROM ("
                    + " SELECT tenant_id, session_id, record_id, revision, delivery_state, record_resource_id, priority, gmt_create"
                    + " FROM (SELECT r.tenant_id, r.session_id, r.record_id, r.revision, r.delivery_state, r.record_resource_id,"
                    + " 0 AS priority, r.gmt_create FROM ma_session_record r LEFT JOIN ma_operation l"
                    + " ON l.tenant_id = r.tenant_id AND l.session_id = r.session_id AND "
                    + "l.operation_id = r.record_id"
                    + " AND l.operation_kind = 'CHILD_SESSION_START' WHERE r.domain = 'child_run'"
                    + " AND r.task_kind IN " + CHILD_SESSION_KINDS_SQL
                    + " AND NOT EXISTS (SELECT 1 FROM ma_operation c WHERE c.tenant_id = r.tenant_id AND c.session_id = r.session_id"
                    + " AND c.operation_id = r.record_id AND c.operation_kind = 'CHILD_SESSION_CLOSE')"
                    + " AND ((r.delivery_state IN ('planned', 'accepting', 'unknown')"
                    + " AND (l.state IS NULL OR l.state NOT IN ('done', 'orphaned', 'unknown')))"
                    + " OR (r.delivery_state IN ('accepted', 'consumed', 'cancelled')"
                    + " AND l.state NOT IN ('done', 'orphaned', 'unknown')))"
                    + " AND (l.available_at IS NULL OR l.available_at <= ?)"
                    + " AND (l.claim_until IS NULL OR l.claim_until <= ? OR l.claim_owner = ?)"
                    + " ORDER BY r.gmt_create, r.session_id, r.record_id LIMIT ?) due_work"
                    + " UNION ALL SELECT tenant_id, session_id, record_id, revision, delivery_state, record_resource_id, priority, gmt_create"
                    + " FROM (SELECT o.tenant_id, o.session_id, o.operation_id AS record_id,"
                    + " COALESCE(r.revision, 0) AS revision, COALESCE(r.delivery_state, 'accepted') AS delivery_state,"
                    + " r.record_resource_id, 1 AS priority, o.gmt_create FROM ma_operation o"
                    + " LEFT JOIN ma_session_record r ON r.tenant_id = o.tenant_id AND r.session_id = o.session_id"
                    + " AND r.domain = 'child_run' AND r.record_id = o.operation_id"
                    + " WHERE o.operation_kind = 'CHILD_SESSION_CLOSE' AND o.state = 'close_debt'"
                    + " AND o.available_at <= ?"
                    + " AND (o.claim_until IS NULL OR o.claim_until <= ? OR o.claim_owner = ?)"
                    + " ORDER BY o.gmt_create, o.session_id, o.operation_id LIMIT ?) close_work"
                    + " ) pending ORDER BY pending.priority, pending.gmt_create, pending.session_id, pending.record_id LIMIT ?";
    }
}
