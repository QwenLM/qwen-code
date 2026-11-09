package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
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

    /**
     * The authority columns fetched alongside the Session read (R6-6): the
     * ownership row (null when none) plus the legacy-creation exclusion
     * count. Scoped to the reading thread and consumed once by the grant,
     * so the hot unbound read costs no extra statement.
     */
    public record ReadAuthority(String tenantId, String sessionId, Row row,
            int principalCreated) {
    }

    private static final ThreadLocal<ReadAuthority> READ_AUTHORITY =
            new ThreadLocal<>();

    public static void stashReadAuthority(ReadAuthority authority) {
        READ_AUTHORITY.set(authority);
    }

    public static ReadAuthority takeReadAuthority(String tenantId,
            String sessionId) {
        ReadAuthority authority = READ_AUTHORITY.get();
        READ_AUTHORITY.remove();
        return authority != null && authority.tenantId().equals(tenantId)
                && authority.sessionId().equals(sessionId) ? authority : null;
    }

    /** Writes the version-1 ownership row; rolls back with the creating tx. */
    public static void insert(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal, long now) {
        Objects.requireNonNull(principal, "principal");
        jdbc.update("INSERT INTO ma_session_principal (tenant_id, session_id,"
                        + " version, user_id, actor_present, actor_subject_id,"
                        + " gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?)",
                tenantId, sessionId, VERSION, principal.userId(),
                principal.actorPresent(), principal.actorSubjectId(), now);
    }

    /** The ownership row of the Session, or null when none was written. */
    public static Row find(JdbcTemplate jdbc, String tenantId,
            String sessionId) {
        List<Row> rows = jdbc.query(
                "SELECT version, user_id, actor_present, actor_subject_id"
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

    /**
     * Whether the principal owns the unbound Session exactly: tenant, user
     * and actor presence plus subject. A legacy Session without an
     * ownership row never matches.
     */
    public static boolean owns(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        return principal != null && principal.tenantId().equals(tenantId)
                && matches(find(jdbc, tenantId, sessionId), principal);
    }

    /** The enforcing twin of {@link #owns}: a miss answers 404. */
    public static void requireOwnership(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        if (!owns(jdbc, tenantId, sessionId, principal)) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
    }

    /**
     * The unified write authority over an unbound Session; identical to the
     * read authority. A legacy Session has no per-actor mutation gate, so the
     * row — when present — is the only authority that distinguishes callers.
     */
    public static void requireAuthority(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        requireReadAuthority(jdbc, tenantId, sessionId, principal);
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
    public static void requireReadAuthority(JdbcTemplate jdbc, String tenantId,
            String sessionId, SessionPrincipal principal) {
        if (principal != null && !principal.tenantId().equals(tenantId)) {
            READ_AUTHORITY.remove();
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
        ReadAuthority stashed = takeReadAuthority(tenantId, sessionId);
        if (stashed != null) {
            requireFetched(tenantId, stashed.row(), stashed.principalCreated(),
                    principal);
            return;
        }
        AuthorityRow authority = fetchAuthority(jdbc, tenantId, sessionId);
        if (authority == null) {
            return;
        }
        requireFetched(tenantId, authority.row(), authority.principalCreated(),
                principal);
    }

    /**
     * The raw-actor twin of {@link #requireReadAuthority} (R7-1): the caller is
     * the filter-admitted actor string, bounded in code points rather than by
     * the principal's byte budget. Construction of a principal is deferred
     * until a row actually has to be matched, and only a row recorded without
     * an actor present can name a raw actor.
     */
    public static void requireReadAuthority(JdbcTemplate jdbc, String tenantId,
            String sessionId, String actorId) {
        ReadAuthority stashed = takeReadAuthority(tenantId, sessionId);
        if (stashed != null) {
            requireFetchedRawActor(stashed.row(), stashed.principalCreated(),
                    actorId);
            return;
        }
        AuthorityRow authority = fetchAuthority(jdbc, tenantId, sessionId);
        if (authority == null) {
            return;
        }
        requireFetchedRawActor(authority.row(), authority.principalCreated(),
                actorId);
    }

    private static AuthorityRow fetchAuthority(JdbcTemplate jdbc,
            String tenantId, String sessionId) {
        // One statement for the whole authority question (R6-6): the row
        // left-joined with the legacy-creation mark. A present row is the
        // sole authority; only a row-less Session consults the mark, so the
        // hot unbound read no longer pays a second round trip.
        List<AuthorityRow> rows = jdbc.query(
                "SELECT p.version, p.user_id, p.actor_present,"
                        + " p.actor_subject_id, (SELECT COUNT(*) FROM"
                        + " ma_request_receipt r JOIN ma_session s ON"
                        + " s.tenant_id = r.tenant_id AND s.session_id ="
                        + " r.session_id WHERE r.tenant_id = ? AND"
                        + " r.session_id = ? AND r.namespace ="
                        + " 'SESSION_COMMAND' AND r.operation ="
                        + " 'CREATE_SESSION' AND s.workspace_id IS NULL"
                        + " AND r.actor_id IS NOT NULL AND"
                        + " LENGTH(r.actor_id) > 0 AND"
                        + " (s.creator_actor_key IS NULL OR"
                        + " r.actor_id <> s.creator_actor_key))"
                        + " FROM ma_session ms LEFT JOIN ma_session_principal p"
                        + " ON p.tenant_id = ms.tenant_id AND"
                        + " p.session_id = ms.session_id"
                        + " WHERE ms.tenant_id = ? AND ms.session_id = ?",
                (result, index) -> new AuthorityRow(
                        result.getObject(1) == null ? null
                                : new Row(result.getInt(1),
                                        result.getString(2),
                                        result.getBoolean(3),
                                        result.getString(4)),
                        result.getInt(5)),
                tenantId, sessionId, tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static void requireFetchedRawActor(Row row, int principalCreated,
            String actorId) {
        if (row != null) {
            // A raw actor carries no encoded subject, so it can only name a row
            // written without an actor present.
            if (row.version() != VERSION || row.actorPresent()
                    || !Objects.equals(row.userId(), actorId)) {
                throw new ManagedAgentException(404,
                        "session_not_found", "The Session was not found.");
            }
            return;
        }
        if (principalCreated != 0) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
    }

    private static void requireFetched(String tenantId, Row row,
            int principalCreated, SessionPrincipal principal) {
        if (row != null) {
            if (!matches(row, principal)) {
                throw new ManagedAgentException(404,
                        "session_not_found", "The Session was not found.");
            }
            return;
        }
        if (principalCreated != 0) {
            throw new ManagedAgentException(404,
                    "session_not_found", "The Session was not found.");
        }
    }

    private record AuthorityRow(Row row, int principalCreated) {
    }

    /**
     * A principal may only act inside its own tenant; a cross-tenant or
     * missing principal answers the same 404 as a missing Session.
     */
    public static void requireTenant(String tenantId,
            SessionPrincipal principal) {
        if (principal == null || !principal.tenantId().equals(tenantId)) {
            throw new ManagedAgentException(404, "session_not_found",
                    "The Session was not found.");
        }
    }
}
