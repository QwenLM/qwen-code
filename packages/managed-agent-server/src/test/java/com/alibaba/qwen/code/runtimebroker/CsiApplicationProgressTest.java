package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.JdbcRuntimeBrokerSchema;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class CsiApplicationProgressTest {
    private static final String ALIAS = "ec77f5fe1b4225e8f8203d59b5858eb235f9155261c440efaa02efd5513bd2df";
    private static final String PHYSICAL = "a".repeat(64);
    private static final String BINDING = "original-binding";
    private static final String RESERVATION = "cfd417c7-f9dc-450d-b880-5667c7a5b029";

    @Test
    void readyOriginalNeedsMatchingRegistrationAndHolderButNoRetirement() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(false)));
            connection.setAutoCommit(false);
            var progress = JdbcCsiApplicationProgress.lock(connection, original(false));
            assertNull(progress.sealedBindingVersion());
            progress.requireCurrentTime(connection);
            sql(connection, "UPDATE ma_storage_owner SET binding_id = 'foreign'");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(false)));
            connection.rollback();
        }
    }

    @Test
    void aLaterHolderCannotGainOriginalApplicationAuthority() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            sql(connection, "UPDATE ma_storage_owner SET csi_revision = 4");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(false)));
            sql(connection, "UPDATE ma_storage_owner SET csi_revision = 1");
            retire(connection, Instant.now());
            sql(connection, "UPDATE ma_storage_owner SET csi_revision = 5");
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
            connection.rollback();
        }
    }

    @Test
    void settlingUsesImmutableCeilingAndTheOriginalConnection() throws Exception {
        var source = source();
        try (var connection = source.getConnection(); var other = source.getConnection()) {
            connection.setAutoCommit(false);
            long deadline = retire(connection, Instant.now());
            var progress = JdbcCsiApplicationProgress.lock(connection, original(true));
            assertEquals(7L, progress.sealedBindingVersion());
            progress.requireLease(connection, deadline - 1000, deadline);
            other.setAutoCommit(false);
            assertThrows(RuntimeBrokerException.class, () -> progress.requireCurrentTime(other));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, deadline + 1, deadline));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, deadline - 1000, deadline + 1));
            assertThrows(RuntimeBrokerException.class, () -> progress.requireLease(connection, 1, deadline));
            connection.rollback();
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
        }
    }

    @Test
    void expiredDeadlineAndMissingPartialOrFrozenProgressRefuseWithoutRepair() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            retire(connection, Instant.now().minusSeconds(301));
            assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)));
            connection.rollback();
            retire(connection, Instant.now());
            for (String change : new String[] {"progress_format = NULL", "progress_version = NULL", "progress_version = 2",
                    "progress_stage = 'FROZEN'", "progress_stage = 'CUT'", "progress_stage = 'DRAINED'",
                    "settlement_deadline_ms = settlement_deadline_ms + 1", "frozen_request_bytes = X'01'",
                    "cut_sha256 = 'unexpected'", "finalize_receipt_bytes = X'01'"}) {
                var savepoint = connection.setSavepoint();
                sql(connection, "UPDATE ma_operation SET " + change);
                assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)), change);
                connection.rollback(savepoint);
            }
            assertEquals(7L, JdbcCsiApplicationProgress.lock(connection, original(true)).sealedBindingVersion());
            connection.rollback();
        }
    }

    @Test
    void registrationAndImmutableRetirementIdentityCannotBeSubstituted() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            retire(connection, Instant.now());
            for (String change : new String[] {
                    "UPDATE ma_storage SET storage_id = 'foreign'",
                    "UPDATE ma_storage_owner SET csi_registration_revision = 2",
                    "UPDATE ma_storage_owner SET csi_reservation_id = 'foreign'",
                    "UPDATE ma_operation SET operation_id = 'foreign'",
                    "UPDATE ma_operation SET phase = 'RELEASED'"}) {
                var savepoint = connection.setSavepoint();
                sql(connection, change);
                assertThrows(RuntimeBrokerException.class, () -> JdbcCsiApplicationProgress.lock(connection, original(true)), change);
                connection.rollback(savepoint);
            }
            connection.rollback();
        }
    }

    private static JdbcCsiFilesRetirementGuard.Original original(boolean draining) {
        var context = new ContextBinding("tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1);
        var request = CsiFilesRetirementProfile.request(context, "/workspace", "2815c6b8-468c-449a-869a-8794b0d52fca");
        return new JdbcCsiFilesRetirementGuard.Original(request, BINDING, 1,
                draining ? RuntimeBindingRecord.State.DRAINING : RuntimeBindingRecord.State.READY, draining, 9, 2L);
    }

    private static long retire(Connection connection, Instant started) throws Exception {
        return retire(connection, started, 1);
    }

    private static long retire(Connection connection, Instant started, long revision) throws Exception {
        var reservation = Map.of("phase", "RESERVED", "revision", revision, "reservationId", RESERVATION,
                "registrationKey", ALIAS, "registrationRevision", 1, "bindingId", BINDING,
                "runtimeGeneration", 1, "provisionRequestId", "provision");
        var identity = new LinkedHashMap<String, Object>();
        identity.put("operationId", "e6db6013-6be7-4c7d-91d2-890f4ec09d25");
        identity.put("physicalKey", PHYSICAL);
        identity.put("phase", "DRAINING");
        identity.put("reservation", reservation);
        identity.put("sealedBindingVersion", 7);
        identity.put("resourceHandleKind", "kubernetes-workspace");
        identity.put("resourceHandleVersion", 3);
        identity.put("resourceHandleJson", "{\"pod\":\"original\"}");
        identity.put("runtimeInstanceId", "runtime");
        identity.put("leaseId", "lease");
        identity.put("epoch", 1);
        identity.put("leaseDigest", "b".repeat(64));
        identity.put("attestationGeneration", 1);
        identity.put("startedAt", started.toString());
        long deadline = Math.addExact(started.toEpochMilli(), 300_000);
        sql(connection, "UPDATE ma_storage_owner SET csi_phase = 'DRAINING', csi_revision = "
                + CsiOwnershipRevision.next(revision));
        String operation = (String) identity.get("operationId");
        String encoded = new ObjectMapper().writeValueAsString(identity);
        String result = new ObjectMapper().writeValueAsString(Map.of("schemaVersion", 1, "data", Map.of(
                "identity_json", encoded, "binding_id", BINDING, "runtime_generation", 1,
                "storage_id", "storage", "physical_key", PHYSICAL)));
        try (var statement = connection.prepareStatement("INSERT INTO ma_operation"
                + " (operation_key,scope_key,operation_id,operation_kind,tenant_id,target_kind,target_id,target_key,target_revision,"
                + "storage_key,physical_key,payload_version,request_json,request_digest,result_json,state,phase,"
                + "progress_format,progress_version,progress_stage,settlement_deadline_ms,gmt_create,gmt_modified)"
                + " VALUES (?,?,?,'CSI_RETIREMENT',?,'RUNTIME_BINDING',?,?,1,?,?,1,?,?,?,'DRAINING','DRAINING',"
                + "'qwen-csi-application-retirement/1',1,'SETTLING',?,?,?)")) {
            statement.setString(1, ManagedSchemaKeys.key("CSI_RETIREMENT", "tenant", operation));
            statement.setString(2, ManagedSchemaKeys.key("tenant"));
            JdbcRepositorySupport.setIdentity(statement, 3, operation);
            JdbcRepositorySupport.setIdentity(statement, 4, "tenant");
            JdbcRepositorySupport.setIdentity(statement, 5, BINDING);
            statement.setString(6, ManagedSchemaKeys.key(BINDING));
            statement.setString(7, ALIAS);
            statement.setString(8, PHYSICAL);
            statement.setString(9, encoded);
            statement.setString(10, ManagedSchemaKeys.key(encoded));
            statement.setString(11, result);
            statement.setLong(12, deadline);
            statement.setLong(13, started.toEpochMilli());
            statement.setLong(14, started.toEpochMilli());
            statement.executeUpdate();
        }
        return deadline;
    }

    private static JdbcDataSource source() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:application-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        try (var connection = source.getConnection()) {
            sql(connection, "INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id,"
                    + " storage_kind, registration_state, physical_key, registration_revision, registration_json) VALUES ('"
                    + ALIAS + "', '" + ManagedSchemaKeys.key("tenant") + "', '" + ManagedSchemaKeys.key("storage")
                    + "', 'tenant', 'storage', 'CSI', 'REGISTERED', '" + PHYSICAL + "', 1, '{}')");
            sql(connection, "INSERT INTO ma_storage_owner (storage_key, storage_kind, csi_phase, csi_revision,"
                    + " csi_reservation_id, csi_registration_key, csi_registration_revision, binding_id, runtime_generation,"
                    + " csi_provision_request_id) VALUES ('" + PHYSICAL + "', 'CSI', 'RESERVED',"
                    + " 1, '" + RESERVATION + "', '" + ALIAS + "', 1, '" + BINDING + "', 1, 'provision')");
            sql(connection, "INSERT INTO ma_runtime_binding (binding_id, request_key, scope_key, tenant_id, workspace_id,"
                    + " workspace_generation, canonical_cwd, capability_digest, isolation_class, isolation_key, storage_id,"
                    + " runtime_generation, binding_state, drain_requested, operation_generation, record_version, last_active_at,"
                    + " provisioner_kind, provision_request_id, resource_handle_version, resource_handle_json, runtime_instance_id,"
                    + " runtime_lease_id, runtime_epoch, attestation_generation) VALUES ('" + BINDING + "', '"
                    + original(false).request().requestKey() + "', '" + JdbcRepositorySupport.scopeKey(original(false).request().getScope())
                    + "', 'tenant', 'workspace', '1', '/workspace', '" + original(false).request().getScope().getCapabilityDigest()
                    + "', 'session', '2815c6b8-468c-449a-869a-8794b0d52fca', 'storage', 1, 'READY', FALSE, 0, 9, 0, 'kubernetes-workspace',"
                    + " 'provision', 3, '{\"pod\":\"original\"}', 'runtime', 'lease', 1, 1)");
        }
        return source;
    }

    private static void sql(Connection connection, String sql) throws Exception {
        try (var statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }
}
