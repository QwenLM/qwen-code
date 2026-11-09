package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;

/**
 * The authoritative ownership record of a non-Workspace Session. The row is
 * written in the same transaction as the Session, receipt and creation
 * event, and is immutable for the lifetime of that Session.
 */
public final class ManagedSessionPrincipal {
    /** The only row layout this build writes or trusts. */
    public static final int VERSION = 1;

    private ManagedSessionPrincipal() {
    }

    /** The durable ownership row of one Session. */
    public record Row(int version, String userId, boolean actorPresent,
            String actorSubjectId) {
    }

    /** Writes the version-1 ownership row; rolls back with the creating tx. */
    public static void insert(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal, long now) {
        Objects.requireNonNull(principal, "principal");
        jdbc.update("INSERT INTO ma_session_principal (tenant_id, session_id,"
                        + " version, user_id, is_actor_present, actor_subject_id,"
                        + " gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?)",
                tenantId, sessionId, VERSION, principal.userId(),
                principal.actorPresent(), principal.actorSubjectId(), now);
    }

    /** The ownership row of the Session, or null when none was written. */
    public static Row find(JdbcTemplate jdbc, String tenantId,
            String sessionId) {
        List<Row> rows = jdbc.query(
                "SELECT version, user_id, is_actor_present, actor_subject_id"
                        + " FROM ma_session_principal WHERE tenant_id = ?"
                        + " AND session_id = ?",
                (result, index) -> new Row(result.getInt(1),
                        result.getString(2), result.getBoolean(3),
                        result.getString(4)),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * Whether the row names exactly this principal. Present vs absent actor
     * state is compared separately from the subject value, and a legacy
     * Session without a row never matches.
     */
    public static boolean matches(Row row, SessionPrincipal principal) {
        return row != null && principal != null && row.version() == VERSION
                && row.userId().equals(principal.userId())
                && row.actorPresent() == principal.actorPresent()
                && Objects.equals(row.actorSubjectId(),
                        principal.actorSubjectId());
    }

    /**
     * The unified authority over an unbound Session. A present ownership row
     * is the sole authority: deleting it revokes access even for the creator,
     * and an anonymous caller never matches a row. A legacy Session that never
     * wrote a row stays tenant-wide — anonymous callers included — so its
     * action gate, where one exists, refuses a foreign actor; a principal-
     * created Session whose row was deleted is invisible, its structured
     * creation receipt marking it past deletion.
     */
    public static void requireAuthority(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        if (principal != null && !principal.tenantId().equals(tenantId)) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
        Row row = find(jdbc, tenantId, sessionId);
        if (row != null) {
            if (!matches(row, principal)) {
                throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(
                        404, "session_not_found", "The Session was not found.");
            }
            return;
        }
        if (!legacyCreation(jdbc, tenantId, sessionId)) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
    }

    /**
     * Whether the Session was created without a principal (legacy). The
     * CREATE_SESSION receipt is an exclusion mark, not a required one: a
     * principal-created Session stamps the structured principal key, which is
     * non-empty and never equals the Session's raw creator_actor_key, a durable
     * mark that survives deletion of the ownership row. A legacy create (raw
     * creator key or empty UNATTRIBUTED key) and the oldest rows that predate
     * the receipt altogether carry no such mark and stay tenant-wide.
     */
    public static boolean legacyCreation(JdbcTemplate jdbc, String tenantId,
            String sessionId) {
        Integer principalCreated = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_request_receipt r JOIN ma_session s"
                        + " ON s.tenant_id = r.tenant_id AND"
                        + " s.session_id = r.session_id WHERE r.tenant_id = ?"
                        + " AND r.session_id = ? AND r.namespace ="
                        + " 'SESSION_COMMAND' AND r.operation = 'CREATE_SESSION'"
                        + " AND r.actor_id IS NOT NULL AND LENGTH(r.actor_id) > 0"
                        + " AND (s.creator_actor_key IS NULL OR"
                        + " r.actor_id <> s.creator_actor_key)",
                Integer.class, tenantId, sessionId);
        return principalCreated == null || principalCreated == 0;
    }

    /**
     * The receipt stamp for an unbound Session. It carries the full
     * principal rather than the two-member Workspace actor key, which
     * cannot represent the business actor distinction.
     */
    public static byte[] actorKey(SessionPrincipal principal) {
        if (principal == null) {
            // An anonymous caller admitted to a legacy no-row Session stamps
            // the unattributed marker — the same empty key an actorless create
            // writes — rather than a structured principal key.
            return new byte[0];
        }
        String joined = principal.userId()
                + "\0" + (principal.actorPresent() ? "1" : "0")
                + "\0" + (principal.actorSubjectId() == null ? ""
                        : principal.actorSubjectId());
        return joined.getBytes(StandardCharsets.UTF_8);
    }
}
