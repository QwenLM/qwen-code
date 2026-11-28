package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedHarnessReleaseRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.repository.HarnessPlacementStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Durable ownership; an endpoint disappearing never authorizes another writer. */
@Repository
@Qualifier("managedAgentTransactionManager")
public class JdbcHarnessPlacementStore
        implements HarnessPlacementStore {
    private static final String COLUMNS = "tenant_id, session_id, workspace_id, harness_instance_id, "
            + "harness_owner_boot_id, harness_placement_epoch, harness_placement_state";
    private static final String JOIN_COLUMNS = "m.tenant_id, m.session_id, m.workspace_id, m.harness_instance_id, "
            + "m.harness_owner_boot_id, m.harness_placement_epoch, m.harness_placement_state";
    private static final long CLAIM_RESERVATION_MILLIS = 30_000;
    private final JdbcTemplate jdbc;

    public JdbcHarnessPlacementStore(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Placement get(String tenant, String session) {
        var rows = placements(" WHERE tenant_id = ? AND session_id = ?", tenant, session);
        return rows.isEmpty() || rows.getFirst().instanceId() == null ? null : rows.getFirst();
    }

    public boolean hasUnreleasedOwnership(String instance, String boot) {
        return !jdbc.query("SELECT m.session_id FROM ma_session m WHERE m.harness_instance_id = ?"
                + " AND m.harness_owner_boot_id = ? AND m.is_resource_gc_completed = FALSE"
                + " AND m.harness_placement_state <> 'RELEASED'"
                + " AND (m.status NOT IN ('CLOSED', 'ARCHIVED', 'DELETED') OR EXISTS ("
                + " SELECT 1 FROM ma_session_head h WHERE h.tenant_id = m.tenant_id AND h.session_id = m.session_id"
                + " AND h.head_kind = 'MANAGED_SESSION' AND h.state = 'ACTIVE' AND h.writer_lease_until > "
                + ManagedSchemaTime.SQL_NOW + ")) LIMIT 1",
                (row, index) -> row.getString(1), instance, boot).isEmpty();
    }

    public List<Placement> findExpiredSuspensions(Set<String> excludedInstanceIds, int limit) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Reaper limit must be between 1 and 100");
        }
        Set<String> excluded = Set.copyOf(excludedInstanceIds);
        List<String> owners = jdbc.query("SELECT DISTINCT harness_instance_id FROM ma_session"
                + " WHERE harness_instance_id IS NOT NULL AND harness_placement_state IN ('ACTIVE', 'QUIESCING')"
                + " AND status = 'ACTIVE' AND deleted_at IS NULL AND retired_at IS NULL"
                + " AND is_resource_gc_completed = FALSE ORDER BY harness_instance_id",
                (row, index) -> row.getString(1));
        List<Placement> found = new ArrayList<>();
        for (String owner : owners) {
            if (excluded.contains(owner)) {
                continue;
            }
            int remaining = limit - found.size();
            found.addAll(jdbc.query("SELECT " + JOIN_COLUMNS + " FROM ma_session m JOIN ma_session_head h"
                    + " ON h.tenant_id = m.tenant_id AND h.session_id = m.session_id"
                    + " AND h.head_kind = 'MANAGED_SESSION'"
                    + " WHERE m.harness_instance_id = ? AND m.harness_placement_state IN ('ACTIVE', 'QUIESCING')"
                    + " AND m.harness_placement_epoch < ? AND m.status = 'ACTIVE'"
                    + " AND m.deleted_at IS NULL AND m.retired_at IS NULL AND m.is_resource_gc_completed = FALSE"
                    + " AND (m.session_kind = 'PUBLIC' OR m.workspace_id IS NOT NULL)"
                    + " AND h.state = 'SEALED' AND h.recovery_status = 'READY'"
                    + " AND h.writer_lease_until IS NOT NULL AND h.writer_lease_until <= " + ManagedSchemaTime.SQL_NOW
                    + " AND h.activation_phase = 'released' AND h.activation_head_revision = h.journal_revision"
                    + " AND h.wake_seal_revision = h.journal_revision"
                    + " ORDER BY m.tenant_id, m.session_id LIMIT ?",
                    (row, index) -> new Placement(row.getString(1), row.getString(2), row.getString(3),
                            row.getString(4), row.getString(5), row.getLong(6), row.getString(7)),
                    owner, ManagedSessionStoreModels.MAX_SAFE_COUNTER, remaining));
            if (found.size() >= limit) {
                break;
            }
        }
        return List.copyOf(found);
    }

    public Map<String, Object> releaseReceipt(String tenant, String session, long epoch, String operationId) {
        var saved = jdbc.query("SELECT b.inline_bytes, b.sha256 FROM ma_session_record r JOIN ma_resource b"
                + " ON b.resource_id = r.record_resource_id"
                + " AND b.tenant_id = r.tenant_id AND b.workspace_id = r.workspace_id AND b.session_id = r.session_id"
                + " WHERE r.tenant_id = ? AND r.session_id = ? AND r.record_id = ?"
                + " AND r.domain = 'hosted_harness_release' AND r.record_kind = 'DOMAIN'"
                + " AND b.kind = ? AND b.schema_version = 1 AND b.state = 'REFERENCED'"
                + " AND b.storage_kind = 'MYSQL_INLINE' AND b.byte_length BETWEEN 1 AND 16384 AND LENGTH(b.inline_bytes) = b.byte_length",
                (row, index) -> {
                    byte[] bytes = row.getBytes(1);
                    if (!DigestUtils.sha256Hex(bytes).equals(row.getString(2))) {
                        throw blocked("harness_release_receipt_corrupt");
                    }
                    return ManagedExtensionRecordStore.parse(new String(bytes, StandardCharsets.UTF_8));
                }, tenant, session, releaseId(epoch), "managed-hosted_harness_release");
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
        BrokerValues.requireShortId(boot, "harnessOwnerBootId");
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
        return takeover(tenant, session, expected, instance, boot, null, false).placement();
    }

    @Transactional
    public Placement takeoverForLifecycle(OperationRecord operation, Placement expected, String instance, String boot) {
        return takeover(operation.tenantId(), operation.sessionId(), expected, instance, boot, operation, false).placement();
    }

    @Transactional
    public long recordDemand(String tenant, String session) {
        lock(tenant, session);
        Long requestedAt = jdbc.queryForObject("SELECT harness_claim_requested_at FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", Long.class, tenant, session);
        long now = now(jdbc);
        if (requestedAt == null) {
            jdbc.update("UPDATE ma_session SET harness_claim_requested_at = ? WHERE tenant_id = ? AND session_id = ?",
                    now, tenant, session);
            return 0;
        }
        return Math.max(0, now - requestedAt);
    }

    @Transactional
    public Claim claim(String tenant, String session, Placement expected, String instance, String boot) {
        return takeover(tenant, session, expected, instance, boot, null, true);
    }

    public List<Placement> findClaimCandidates(int limit) {
        requireLimit(limit);
        // Only Sessions takeover would admit, so demand no claim can satisfy never holds a place in the
        // batch: no head, a sealed release, or a lapsed writer whose activation is known and settled.
        return jdbc.query("SELECT " + JOIN_COLUMNS + " FROM ma_session m LEFT JOIN ma_session_head h"
                + " ON h.tenant_id = m.tenant_id AND h.session_id = m.session_id AND h.head_kind = 'MANAGED_SESSION'"
                + " WHERE m.harness_claim_requested_at IS NOT NULL"
                + " AND (m.harness_claim_reserved_until IS NULL OR m.harness_claim_reserved_until <= " + ManagedSchemaTime.SQL_NOW + ")"
                + " AND m.harness_placement_state <> 'UNASSIGNED'"
                + " AND (h.session_id IS NULL OR (m.harness_placement_state = 'RELEASED' AND h.state = 'SEALED')"
                + " OR (h.writer_lease_until <= " + ManagedSchemaTime.SQL_NOW
                + " AND (h.activation_head_revision = COALESCE(h.journal_revision, 0) OR COALESCE(h.activation_epoch, 0) = 0)"
                + " AND (COALESCE(h.activation_epoch, 0) = 0 OR h.activation_phase IN ('released', 'revoked')"
                + " OR (h.activation_phase = 'active' AND h.activation_expires_at <= " + ManagedSchemaTime.SQL_NOW + "))))"
                + " AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND m.retired_at IS NULL"
                + " AND (m.session_kind = 'PUBLIC' OR m.workspace_id IS NOT NULL)"
                + " ORDER BY m.harness_claim_requested_at, m.tenant_id, m.session_id LIMIT ?",
                (row, index) -> new Placement(row.getString(1), row.getString(2), row.getString(3),
                        row.getString(4), row.getString(5), row.getLong(6), row.getString(7)), limit);
    }

    public List<Claim> findReservedClaims(String instance, String boot, int limit) {
        identity(instance);
        BrokerValues.requireShortId(boot, "harnessOwnerBootId");
        requireLimit(limit);
        return jdbc.query("SELECT " + COLUMNS + ", harness_claim_reserved_until FROM ma_session"
                + " WHERE harness_instance_id = ? AND harness_owner_boot_id = ? AND harness_placement_state = 'ACTIVE'"
                + " AND harness_claim_reserved_until > " + ManagedSchemaTime.SQL_NOW
                + " ORDER BY tenant_id, session_id LIMIT ?",
                (row, index) -> new Claim(new Placement(row.getString(1), row.getString(2), row.getString(3),
                        row.getString(4), row.getString(5), row.getLong(6), row.getString(7)), row.getLong(8)),
                instance, boot, limit);
    }

    /** Writer acquisition consumes the claim; the caller already holds the placement row lock. */
    static void consumeClaim(JdbcTemplate jdbc, String tenant, String session) {
        jdbc.update("UPDATE ma_session SET harness_claim_requested_at = NULL, harness_claim_reserved_until = NULL"
                + " WHERE tenant_id = ? AND session_id = ?"
                + " AND (harness_claim_requested_at IS NOT NULL OR harness_claim_reserved_until IS NOT NULL)",
                tenant, session);
    }

    private Claim takeover(String tenant, String session, Placement expected, String instance, String boot,
            OperationRecord operation, boolean reserve) {
        identity(instance);
        BrokerValues.requireShortId(boot, "harnessOwnerBootId");
        Placement current = lockEligible(tenant, session, operation);
        if (!sameOwner(current, expected)) {
            throw blocked("harness_placement_changed");
        }
        var heads = jdbc.query("SELECT state, writer_lease_until, activation_phase, activation_expires_at,"
                + " activation_head_revision, journal_revision, activation_epoch"
                + " FROM ma_session_head WHERE tenant_id = ? AND"
                + " harness_session_id = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                (row, index) -> new Object[] {row.getString(1), row.getObject(2, Long.class),
                        row.getString(3), row.getObject(4, Long.class), row.getObject(5, Long.class),
                        row.getLong(6), row.getLong(7)},
                tenant, session);
        long now = now(jdbc);
        Long reservedUntil = jdbc.queryForObject("SELECT harness_claim_reserved_until FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", Long.class, tenant, session);
        if ("ACTIVE".equals(current.state()) && reservedUntil != null && reservedUntil > now) {
            throw blocked("harness_owner_still_live");
        }
        if (!heads.isEmpty()) {
            Object[] head = heads.getFirst();
            boolean released = "RELEASED".equals(current.state()) && "SEALED".equals(head[0])
                    && released(jdbc, tenant, session, current.epoch());
            boolean activationKnown = Objects.equals(head[4], head[5]) || Objects.equals(head[6], 0L);
            boolean expired = head[1] != null && (Long) head[1] <= now && activationKnown
                    && (Objects.equals(head[6], 0L) || "released".equals(head[2]) || "revoked".equals(head[2])
                            || "active".equals(head[2]) && head[3] != null && (Long) head[3] <= now);
            if (!released && !expired) {
                throw blocked("harness_owner_still_live");
            }
            if (released) {
                // A successor that never acquires a writer must not inherit the released writer's lease.
                jdbc.update("UPDATE ma_session_head SET writer_lease_until = LEAST(writer_lease_until, ?)"
                        + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        now, tenant, session);
            }
        }
        if (current.epoch() >= ManagedSessionStoreModels.MAX_SAFE_COUNTER) {
            throw blocked("harness_placement_epoch_exhausted");
        }
        long epoch = current.epoch() + 1;
        long until = reserve ? now + CLAIM_RESERVATION_MILLIS : 0;
        // A claim keeps the demand until its writer acquires; a push takeover answers it.
        jdbc.update("UPDATE ma_session SET harness_instance_id = ?, harness_owner_boot_id = ?,"
                + " harness_placement_epoch = ?, harness_placement_state = 'ACTIVE', harness_claim_reserved_until = ?"
                + (reserve ? "" : ", harness_claim_requested_at = NULL")
                + " WHERE tenant_id = ? AND session_id = ?", instance, boot, epoch, reserve ? until : null, tenant, session);
        return new Claim(new Placement(tenant, session, current.workspaceId(), instance, boot, epoch, "ACTIVE"), until);
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
        return HarnessPlacementStore.releaseId(epoch);
    }

    static boolean released(JdbcTemplate jdbc, String tenant, String session, long epoch) {
        return !jdbc.query("SELECT record_id FROM ma_session_record WHERE tenant_id = ? AND session_id = ?"
                + " AND record_id = ? AND domain = ? AND record_kind = 'DOMAIN'",
                (row, index) -> row.getString(1), tenant, session,
                releaseId(epoch),
                RELEASE_DOMAIN).isEmpty();
    }

    private Placement lockEligible(String tenant, String session, OperationRecord operation) {
        if (operation != null) {
            JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
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
        var admission = jdbc.query("SELECT status, session_kind, workspace_id FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", (row, index) ->
                pendingStatus.equals(row.getString(1))
                        && ("PUBLIC".equals(row.getString(2)) || row.getString(3) != null), tenant, session);
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
                + " FOR UPDATE",
                (row, index) -> new Object[] {row.getLong(1), row.getLong(2), row.getString(3), row.getString(4),
                        row.getInt(5), row.getString(6), row.getString(7)},
                operation.tenantId(), operation.sessionId(), operation.operationId(), operation.kind().name());
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
            throw new ManagedAgentException(404, "session_not_found", "The Session does not exist.");
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

    private static void requireLimit(int limit) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Claim limit must be between 1 and 100");
        }
    }

    private static void identity(String id) {
        // The VARCHAR(128) column admits only the pool endpoint charset; a
        // PAD SPACE fold must never alias one instance's ownership to another.
        BrokerValues.requireInstanceId(id, "harnessInstanceId");
    }

    static ManagedAgentException blocked(String code) {
        return new ManagedAgentException(409, code, "The Harness ownership boundary refused this operation.");
    }
}
