package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Durable ownership; an endpoint disappearing never authorizes another writer. */
@Repository
@Qualifier("managedAgentTransactionManager")
public class HarnessPlacementStore {
    public static final String RELEASE_DOMAIN = "hosted_harness_release";
    private static final String COLUMNS = "tenant_id, session_id, workspace_id, harness_instance_id, "
            + "harness_owner_boot_id, harness_placement_epoch, harness_placement_state";
    private final JdbcTemplate jdbc;

    public HarnessPlacementStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Placement(String tenantId, String sessionId, String workspaceId,
            String instanceId, String bootId, long epoch, String state) {
    }

    public Placement get(String tenant, String session) {
        var rows = placements(" WHERE tenant_id = ? AND session_id = ?", tenant, session);
        return rows.isEmpty() || rows.getFirst().instanceId() == null ? null : rows.getFirst();
    }

    public boolean hasUnreleasedOwnership(String instance, String boot) {
        return !jdbc.query("SELECT m.session_id FROM ma_session m WHERE m.harness_instance_id = ?"
                + " AND m.harness_owner_boot_id = ? AND m.resource_gc_completed = FALSE"
                + " AND m.harness_placement_state <> 'RELEASED'"
                + " AND (m.status NOT IN ('CLOSED', 'ARCHIVED', 'DELETED') OR EXISTS ("
                + " SELECT 1 FROM ma_session_head h WHERE h.tenant_id = m.tenant_id AND h.session_id = m.session_id"
                + " AND h.head_kind = 'MANAGED_SESSION' AND h.state = 'ACTIVE' AND h.writer_lease_until > "
                + ManagedSchemaTime.SQL_NOW + ")) LIMIT 1",
                (row, index) -> row.getString(1), instance, boot).isEmpty();
    }

    public Map<String, Object> releaseReceipt(String tenant, String session, long epoch, String operationId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String key = ManagedExtensionProjection.recordKey(session, RELEASE_DOMAIN, releaseId(epoch));
        var saved = jdbc.query("SELECT b.inline_bytes, b.sha256 FROM ma_session_record r JOIN ma_resource b"
                + " ON b.session_scope_key = r.session_scope_key AND b.resource_id = r.record_resource_id"
                + " AND b.tenant_id = r.tenant_id AND b.workspace_id = r.workspace_id AND b.session_id = r.session_id"
                + " WHERE r.session_scope_key = ? AND r.record_key = ? AND r.tenant_id = ? AND r.session_id = ?"
                + " AND r.domain = 'hosted_harness_release' AND r.record_kind = 'DOMAIN'"
                + " AND b.kind = ? AND b.schema_version = 1 AND b.state = 'REFERENCED'"
                + " AND b.storage_kind = 'MYSQL_INLINE' AND b.byte_length BETWEEN 1 AND 16384 AND LENGTH(b.inline_bytes) = b.byte_length",
                (row, index) -> {
                    byte[] bytes = row.getBytes(1);
                    if (!DigestUtils.sha256Hex(bytes).equals(row.getString(2))) {
                        throw blocked("harness_release_receipt_corrupt");
                    }
                    return ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
                }, scope, key, tenant, session, "managed-hosted_harness_release");
        if (saved.isEmpty()) {
            return null;
        }
        var receipt = saved.getFirst();
        ManagedHarnessReleaseRecords.require(receipt);
        if (!tenant.equals(receipt.path("tenantId").asText()) || !session.equals(receipt.path("sessionId").asText())
                || receipt.path("placementEpoch").asLong() != epoch || !operationId.equals(receipt.path("operationId").asText())) {
            throw blocked("harness_release_operation_conflict");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        receipt.fields().forEachRemaining(field -> {
            var value = field.getValue();
            result.put(field.getKey(), value.isTextual() ? value.textValue() : value.isNumber() ? value.longValue()
                    : Map.of("lastCommitSequence", value.path("lastCommitSequence").asLong(),
                            "committedPrefixHash", value.path("committedPrefixHash").asText()));
        });
        return Map.copyOf(result);
    }

    @Transactional
    public Placement assign(String tenant, String session, String instance, String boot) {
        return assign(tenant, session, instance, boot, null);
    }

    @Transactional
    public Placement assignForLifecycle(OperationRecord operation, String instance, String boot) {
        return assign(operation.tenantId(), operation.sessionId(), instance, boot, operation);
    }

    private Placement assign(String tenant, String session, String instance, String boot, OperationRecord operation) {
        identity(instance);
        identity(boot);
        Placement current = lockEligible(tenant, session, operation);
        if (current.instanceId() != null) {
            return current;
        }
        // The private daemon indexes Sessions by id, independent of tenant.
        // Reject an ambiguous CONTROL id before any handle is exposed.
        Integer collisions = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE session_id = ?",
                Integer.class, session);
        if (collisions == null || collisions != 1) {
            throw blocked("harness_session_scope_ambiguous");
        }
        jdbc.update("UPDATE ma_session SET harness_instance_id = ?, harness_owner_boot_id = ?,"
                + " harness_placement_epoch = 1, harness_placement_state = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", instance, boot, tenant, session);
        return new Placement(tenant, session, current.workspaceId(), instance, boot, 1, "ACTIVE");
    }

    @Transactional
    public boolean quiesce(String tenant, String session, Placement expected) {
        var current = lock(tenant, session);
        if (!sameOwner(current, expected) || "RELEASED".equals(current.state())) {
            return false;
        }
        jdbc.update("UPDATE ma_session SET harness_placement_state = 'QUIESCING'"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        return true;
    }

    @Transactional
    public Placement takeover(String tenant, String session, Placement expected, String instance, String boot) {
        return takeover(tenant, session, expected, instance, boot, null);
    }

    @Transactional
    public Placement takeoverForLifecycle(OperationRecord operation, Placement expected, String instance, String boot) {
        return takeover(operation.tenantId(), operation.sessionId(), expected, instance, boot, operation);
    }

    private Placement takeover(String tenant, String session, Placement expected, String instance, String boot, OperationRecord operation) {
        identity(instance);
        identity(boot);
        Placement current = lockEligible(tenant, session, operation);
        if (!sameOwner(current, expected)) {
            throw blocked("harness_placement_changed");
        }
        var heads = jdbc.query("SELECT state, writer_lease_until, activation_phase, activation_expires_at,"
                + " activation_head_revision, journal_revision, activation_epoch"
                + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ?"
                + " AND session_id = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                (row, index) -> new Object[] {row.getString(1), row.getObject(2, Long.class),
                        row.getString(3), row.getObject(4, Long.class), row.getObject(5, Long.class),
                        row.getLong(6), row.getLong(7)},
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                JdbcRuntimeBindingRepository.harnessDrainKey(session), tenant, session);
        if (!heads.isEmpty()) {
            Object[] head = heads.getFirst();
            long now = now(jdbc);
            boolean released = "RELEASED".equals(current.state()) && "SEALED".equals(head[0])
                    && released(jdbc, tenant, session, current.epoch());
            boolean activationKnown = Objects.equals(head[4], head[5]) || Objects.equals(head[6], 0L);
            boolean expired = head[1] != null && (Long) head[1] <= now && activationKnown
                    && (Objects.equals(head[6], 0L) || "released".equals(head[2]) || "revoked".equals(head[2])
                            || "active".equals(head[2]) && head[3] != null && (Long) head[3] <= now);
            if (!released && !expired) {
                throw blocked("harness_owner_still_live");
            }
        }
        if (current.epoch() >= ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw blocked("harness_placement_epoch_exhausted");
        }
        long epoch = current.epoch() + 1;
        jdbc.update("UPDATE ma_session SET harness_instance_id = ?, harness_owner_boot_id = ?,"
                + " harness_placement_epoch = ?, harness_placement_state = 'ACTIVE'"
                + " WHERE tenant_id = ? AND session_id = ?", instance, boot, epoch, tenant, session);
        return new Placement(tenant, session, current.workspaceId(), instance, boot, epoch, "ACTIVE");
    }

    static Placement requireCurrent(JdbcTemplate jdbc, WriterCredentialPolicy credentials,
            String tenant, String workspace, String session, String token, String writer, boolean newWork) {
        var rows = jdbc.query("SELECT " + COLUMNS + " FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                (row, index) -> new Placement(row.getString(1), row.getString(2), row.getString(3),
                        row.getString(4), row.getString(5), row.getLong(6), row.getString(7)), tenant, session);
        Placement current = rows.isEmpty() ? null : rows.getFirst();
        if (current == null || current.instanceId() == null) {
            if (WriterCredentialPolicy.isPlacementToken(token)) {
                throw blocked("harness_placement_changed");
            }
            return null;
        }
        credentials.requirePlacement(tenant, workspace, session, current.instanceId(), current.bootId(), current.epoch(), token);
        if (writer != null && !current.bootId().equals(writer)) {
            throw blocked("harness_placement_changed");
        }
        if ("RELEASED".equals(current.state())) {
            throw blocked("harness_placement_released");
        }
        if (newWork && !"ACTIVE".equals(current.state())) {
            throw blocked("harness_placement_quiescing");
        }
        return current;
    }

    static String releaseId(long epoch) {
        return "placement:" + epoch;
    }

    static boolean released(JdbcTemplate jdbc, String tenant, String session, long epoch) {
        return !jdbc.query("SELECT record_id FROM ma_session_record WHERE session_scope_key = ?"
                + " AND record_key = ? AND tenant_id = ? AND session_id = ? AND domain = ? AND record_kind = 'DOMAIN'",
                (row, index) -> row.getString(1), ManagedSessionStore.sessionScopeKey(tenant, session),
                ManagedExtensionProjection.recordKey(session, RELEASE_DOMAIN, releaseId(epoch)),
                tenant, session, RELEASE_DOMAIN).isEmpty();
    }

    private Placement lockEligible(String tenant, String session, OperationRecord operation) {
        if (operation != null) {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
            ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        }
        var current = lock(tenant, session);
        if (operation != null) {
            requireLifecycleClaim(operation);
        }
        String pendingStatus = operation == null ? "ACTIVE" : switch (operation.kind()) {
            case DELETE -> "DELETING";
            case ARCHIVE -> "ARCHIVING";
            default -> "CLOSING";
        };
        var admission = jdbc.query("SELECT status, session_kind, workspace_id, csi_guard FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", (row, index) ->
                pendingStatus.equals(row.getString(1))
                        && ("PUBLIC".equals(row.getString(2)) || row.getString(3) != null)
                        && !row.getBoolean(4), tenant, session);
        if (admission.isEmpty() || !admission.getFirst()) {
            throw blocked("harness_placement_not_admitted");
        }
        return current;
    }

    private void requireLifecycleClaim(OperationRecord operation) {
        if (!List.of("CLOSE", "ARCHIVE", "DELETE").contains(operation.kind().name())
                || operation.lifecycleProtocolVersion() < 0 || operation.lifecycleProtocolVersion() > 2
                || operation.leaseOwner() == null) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_claim_fenced");
        }
        var rows = jdbc.query("SELECT o.claim_generation, o.claim_until, o.claim_owner, o.delivery_state,"
                + " o.lifecycle_protocol_version, f.phase, f.operation_id FROM ma_operation o JOIN ma_session_head f"
                + " ON f.tenant_id = o.tenant_id AND f.harness_session_id = o.session_id"
                + " WHERE o.tenant_id = ? AND o.session_id = ? AND o.operation_id = ? AND o.operation_kind = ?"
                + " AND f.tenant_key = ? AND f.harness_key = ? FOR UPDATE",
                (row, index) -> new Object[] {row.getLong(1), row.getLong(2), row.getString(3), row.getString(4),
                        row.getInt(5), row.getString(6), row.getString(7)},
                operation.tenantId(), operation.sessionId(), operation.operationId(), operation.kind().name(),
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.tenantId()),
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.sessionId()));
        if (rows.size() != 1) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_claim_fenced");
        }
        Object[] row = rows.getFirst();
        if (!Objects.equals(row[0], operation.claimGeneration()) || (Long) row[1] <= now(jdbc)
                || !operation.leaseOwner().equals(row[2]) || !"LEASED".equals(row[3])
                || !Objects.equals(row[4], operation.lifecycleProtocolVersion())
                || !(operation.lifecycleProtocolVersion() == 0
                        ? "DRAINING".equals(row[5]) && row[6] == null
                        : List.of("DRAINING", "LIFECYCLE_ONLY").contains(row[5]) && operation.operationId().equals(row[6]))) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_claim_fenced");
        }
    }

    private Placement lock(String tenant, String session) {
        var rows = placements(" WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenant, session);
        if (rows.isEmpty()) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "session_not_found", "The Session does not exist.");
        }
        return rows.getFirst();
    }

    private List<Placement> placements(String suffix, Object... args) {
        return jdbc.query("SELECT " + COLUMNS + " FROM ma_session" + suffix,
                (row, index) -> new Placement(row.getString(1), row.getString(2), row.getString(3),
                        row.getString(4), row.getString(5), row.getLong(6), row.getString(7)), args);
    }

    private static boolean sameOwner(Placement left, Placement right) {
        return left != null && right != null && left.epoch() == right.epoch()
                && Objects.equals(left.tenantId(), right.tenantId()) && Objects.equals(left.sessionId(), right.sessionId())
                && Objects.equals(left.instanceId(), right.instanceId()) && Objects.equals(left.bootId(), right.bootId());
    }

    static long now(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, Long.class);
    }

    private static void identity(String id) {
        if (StringUtils.isBlank(id) || id.indexOf('\0') >= 0 || id.getBytes(StandardCharsets.UTF_8).length > 144) {
            throw new IllegalArgumentException("Harness instance and boot identities must contain 1 to 144 UTF-8 bytes.");
        }
    }

    static ManagedAgentException blocked(String code) {
        return new ManagedAgentException(HttpStatus.CONFLICT, code, "The Harness ownership boundary refused this operation.");
    }
}
