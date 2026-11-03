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
     * The receipt stamp for an unbound Session. It carries the full
     * principal rather than the two-member Workspace actor key, which
     * cannot represent the business actor distinction.
     */
    public static byte[] actorKey(SessionPrincipal principal) {
        String joined = principal.userId()
                + "\0" + (principal.actorPresent() ? "1" : "0")
                + "\0" + (principal.actorSubjectId() == null ? ""
                        : principal.actorSubjectId());
        return joined.getBytes(StandardCharsets.UTF_8);
    }

    static boolean ownsSession(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        return principal != null && principal.tenantId().equals(tenantId)
                && matches(find(jdbc, tenantId, sessionId), principal);
    }

    static void requireSessionOwnership(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        if (!ownsSession(jdbc, tenantId, sessionId, principal)) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
    }

    static void requirePrincipalTenant(String tenantId, SessionPrincipal principal) {
        if (principal == null || !principal.tenantId().equals(tenantId)) {
            throw new com.alibaba.qwen.code.managedagent.exception.ManagedAgentException(
                    404, "session_not_found", "The Session was not found.");
        }
    }
}
