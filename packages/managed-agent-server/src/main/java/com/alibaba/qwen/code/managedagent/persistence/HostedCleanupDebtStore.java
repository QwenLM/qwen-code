package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Lists the cleanup debts no live Turn can discharge.
 *
 * <p>A {@code HOSTED_CLEANUP} row in {@code ma_resource_ref} is the durable
 * owed projection; its descriptor names the Turn whose original Runtime still
 * needs a confirmed release. A Session with an active Turn is skipped: that
 * Turn's driver still owns the debt, and a cleanup-only load there would race
 * the live Turn for the Session's writer lease.
 *
 * <p>The scan is keyset-paginated over the raw rows. The cursor advances past
 * every row it reads, including ones whose descriptor is unreadable, so a
 * stuck prefix cannot wedge the page and starve later debts; the caller wraps
 * the cursor back to the start once a page comes up short.
 */
@Component
public class HostedCleanupDebtStore {
    private static final Logger LOG = LoggerFactory.getLogger(HostedCleanupDebtStore.class);

    public record CleanupDebt(String tenantId, String workspaceId, String sessionId,
            String ownerKey, String promptId) {
    }

    /**
     * One advancing page. {@code nextCreate}/{@code nextOwnerKey} name the last
     * raw row read (valid or not) so the next call resumes after it;
     * {@code exhausted} is true when the query returned fewer rows than the
     * limit, meaning the cursor has reached the end and should wrap.
     */
    public record ScanPage(List<CleanupDebt> debts, long nextCreate, String nextOwnerKey,
            boolean exhausted) {
    }

    private static final String OWED =
            "SELECT r.tenant_id, r.workspace_id, r.session_id, r.owner_key, r.gmt_create,"
                    + " m.inline_bytes FROM ma_resource_ref r JOIN ma_resource m"
                    + " ON m.resource_key = r.resource_key"
                    + " WHERE r.owner_kind = 'HOSTED_CLEANUP' AND m.state = 'REFERENCED'"
                    + " AND m.storage_kind = 'MYSQL_INLINE' AND r.workspace_id IS NOT NULL"
                    + " AND (r.gmt_create > ? OR (r.gmt_create = ? AND r.owner_key > ?))"
                    + " AND NOT EXISTS (SELECT 1 FROM ma_turn t WHERE t.tenant_id = r.tenant_id"
                    + " AND t.session_id = r.session_id"
                    + " AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING'))"
                    + " ORDER BY r.gmt_create, r.owner_key LIMIT ?";

    private final JdbcTemplate jdbc;
    private final Set<String> warned = ConcurrentHashMap.newKeySet();

    public HostedCleanupDebtStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public ScanPage findOwed(int limit, long afterCreate, String afterOwnerKey) {
        List<Map<String, Object>> rows =
                jdbc.queryForList(OWED, afterCreate, afterCreate, afterOwnerKey, limit);
        List<CleanupDebt> debts = new ArrayList<>();
        long nextCreate = afterCreate;
        String nextOwnerKey = afterOwnerKey;
        for (var row : rows) {
            nextCreate = ((Number) row.get("gmt_create")).longValue();
            nextOwnerKey = text(row.get("owner_key"));
            String tenant = text(row.get("tenant_id"));
            String workspace = text(row.get("workspace_id"));
            String session = text(row.get("session_id"));
            Object inline = row.get("inline_bytes");
            String promptId = promptId(tenant, workspace, session, nextOwnerKey,
                    inline instanceof byte[] bytes ? bytes : null);
            if (promptId != null) {
                debts.add(new CleanupDebt(tenant, workspace, session, nextOwnerKey, promptId));
            }
        }
        return new ScanPage(debts, nextCreate, nextOwnerKey, rows.size() < limit);
    }

    /**
     * The descriptor is the only durable place naming the owed Turn. A readable
     * but foreign descriptor is not this Session's debt, and an unreadable one
     * must not erase it: both keep the projection untouched and leave the debt
     * for an operator.
     */
    private String promptId(String tenant, String workspace, String session,
            String owner, byte[] bytes) {
        JsonNode body = bytes == null ? null
                : ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
        JsonNode key = body == null ? null : body.path("sessionKey");
        String promptId = body == null ? null : body.path("promptId").asText(null);
        if (body == null || body.path("v").asInt() != 1 || promptId == null || key == null
                || !tenant.equals(key.path("tenantId").asText())
                || !workspace.equals(key.path("workspaceId").asText())
                || !session.equals(key.path("sessionId").asText())) {
            // The debt is unreadable, not gone: the scan will see it again on
            // every cycle, so name it once per process instead of per scan.
            String warnedKey = tenant + "\n" + owner;
            if (warned.size() < 1024 && warned.add(warnedKey)) {
                LOG.warn("Hosted cleanup debt has an unreadable descriptor tenant={}"
                        + " session={} owner={}", tenant, session, owner);
            }
            return null;
        }
        return promptId;
    }

    private static String text(Object value) {
        return value == null ? null : value instanceof byte[] bytes
                ? new String(bytes, StandardCharsets.UTF_8)
                : value.toString();
    }
}
