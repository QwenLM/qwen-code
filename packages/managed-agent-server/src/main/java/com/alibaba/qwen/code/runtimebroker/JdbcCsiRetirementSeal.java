package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** Reads the existing immutable authorization ceiling, not physical retirement evidence. */
final class JdbcCsiRetirementSeal {
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).build()).build())
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .enable(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_NULL_CREATOR_PROPERTIES);

    private JdbcCsiRetirementSeal() {
    }

    static void requireOpen(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        original.requireAdmission();
        try (var statement = connection.prepareStatement(
                        "SELECT operation_id FROM ma_operation WHERE operation_kind ="
                                + " 'CSI_RETIREMENT' AND target_key = ? AND target_revision = ? AND"
                                + " tenant_id = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            JdbcRepositorySupport.setStringParameter(
                    statement,
                    1,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.bindingId()));
            statement.setLong(2, original.generation());
            JdbcRepositorySupport.setIdentity(
                    statement, 3, original.request().getScope().getTenantId());
            try (var rows = statement.executeQuery()) {
                if (rows.next()) {
                    throw new RuntimeBrokerException(409, "csi_retirement_identity_unavailable",
                            "The original CSI Runtime is sealed for retirement.", false);
                }
            }
        }
    }

    static Long lock(Connection connection, JdbcCsiFilesRetirementGuard.Original original) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'"
                        + " AND target_key = ? AND target_revision = ? AND tenant_id = ? FOR UPDATE")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.bindingId()));
            statement.setLong(2, original.generation());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            try (var row = statement.executeQuery()) {
                if (!row.next()) {
                    require(original.state() == RuntimeBindingRecord.State.READY && !original.draining());
                    return null;
                }
                String encoded = operationIdentity(row, original);
                require(encoded != null && encoded.length() <= 256 * 1024
                        && encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 256 * 1024);
                require(original.state() == RuntimeBindingRecord.State.DRAINING && original.draining());
                Identity identity = identity(encoded, original, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "operation_id"),
                        row.getString("physical_key"), row.getString("phase"));
                require(!row.next());
                verifyAssociation(connection, original, identity);
                return identity.sealedBindingVersion();
            }
        } catch (IOException | IllegalArgumentException | NullPointerException | java.time.format.DateTimeParseException error) {
            throw unavailable();
        }
    }

    static long readHistorical(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            byte[] frozenBytes, JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        read.requireHistorical(connection);
        require(frozenBytes != null && frozenBytes.length > 0 && frozenBytes.length <= 32 * 1024 * 1024);
        try (var statement = read.statement(connection,
                "SELECT * FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'"
                        + " AND target_key = ? AND target_revision = ? AND tenant_id = ?")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.bindingId()));
            statement.setLong(2, original.generation());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            try (var row = statement.executeQuery()) {
                require(row.next() && "qwen-csi-application-retirement/1".equals(row.getString("progress_format"))
                        && row.getLong("progress_version") == 4 && "DRAINED".equals(row.getString("progress_stage")));
                String encoded = operationIdentity(row, original);
                require(encoded != null && encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 256 * 1024);
                Identity identity = identity(encoded, original, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "operation_id"),
                        row.getString("physical_key"), row.getString("phase"));
                require(original.draining() && original.state() == RuntimeBindingRecord.State.DRAINING
                        && row.getLong("settlement_deadline_ms") == Math.addExact(Instant.parse(identity.startedAt()).toEpochMilli(), 300000L));
                byte[] saved;
                try (var input = row.getBinaryStream("frozen_request_bytes")) {
                    require(input != null);
                    saved = input.readNBytes(32 * 1024 * 1024 + 1);
                }
                require(java.util.Arrays.equals(frozenBytes, saved)
                        && CsiNativeActivationProof.sha256(saved).equals(row.getString("frozen_request_sha256")));
                var frozen = JSON.valueToTree(ManagedCsiFilesProtocol.parse(saved, 32 * 1024 * 1024));
                require("qwen-csi-application-frozen/1".equals(frozen.path("format").textValue())
                        && identity.operationId().equals(frozen.path("retirementId").textValue())
                        && original.bindingId().equals(frozen.path("bindingId").textValue())
                        && original.request().requestKey().equals(frozen.path("requestKey").textValue())
                        && CsiNativeActivationProof.number(frozen.get("sealedBindingVersion")) == identity.sealedBindingVersion()
                        && !row.next());
                verifyImmutableAssociation(connection, original, identity, read);
                return identity.sealedBindingVersion();
            }
        } catch (IOException | IllegalArgumentException | NullPointerException | java.time.format.DateTimeParseException
                | ArithmeticException error) {
            throw unavailable();
        }
    }

    static String operationIdentity(java.sql.ResultSet row, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        String encoded = row.getString("request_json");
        String result = row.getString("result_json");
        String tenant = original.request().getScope().getTenantId();
        String operation = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "operation_id");
        require(encoded != null && encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 256 * 1024
                && result != null && result.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 1024 * 1024);
        var envelope = CsiNativeActivationProof.readObject(result.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var data = envelope.path("data");
        require(envelope.size() == 2 && CsiNativeActivationProof.number(envelope.get("schemaVersion")) == 1
                && data.isObject() && data.size() == 5 && encoded.equals(data.path("identity_json").textValue())
                && original.bindingId().equals(data.path("binding_id").textValue())
                && CsiNativeActivationProof.number(data.get("runtime_generation")) == original.generation()
                && original.request().getStorageId().equals(data.path("storage_id").textValue())
                && row.getString("physical_key").equals(data.path("physical_key").textValue())
                && "CSI_RETIREMENT".equals(row.getString("operation_kind"))
                && "RUNTIME_BINDING".equals(row.getString("target_kind"))
                && "DRAINING".equals(row.getString("phase")) && "DRAINING".equals(row.getString("state"))
                && row.getInt("payload_version") == 1
                && java.util.Arrays.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(tenant), row.getBytes("tenant_id"))
                && java.util.Arrays.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(original.bindingId()), row.getBytes("target_id"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.bindingId()).equals(row.getString("target_key"))
                && row.getLong("target_revision") == original.generation() && !row.wasNull()
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(tenant).equals(row.getString("scope_key"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("CSI_RETIREMENT", tenant, operation).equals(row.getString("operation_key"))
                && JdbcRuntimeBindingRepository.storageAliasKey(tenant, original.request().getStorageId()).equals(row.getString("storage_key"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(encoded).equals(row.getString("request_digest")));
        return encoded;
    }

    private static Identity identity(String encoded, JdbcCsiFilesRetirementGuard.Original original,
            String retirement, String physical, String phase) throws IOException {
        Identity identity = JSON.readValue(encoded, Identity.class);
        require(identity.operationId().equals(UUID.fromString(identity.operationId()).toString())
                && identity.operationId().equals(retirement) && "DRAINING".equals(identity.phase()) && identity.phase().equals(phase)
                && identity.physicalKey().matches("[0-9a-f]{64}") && identity.physicalKey().equals(physical)
                && identity.sealedBindingVersion() > 0 && identity.sealedBindingVersion() <= original.version());
        return identity;
    }

    private static void verifyAssociation(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            Identity identity) throws SQLException, IOException {
        verifyImmutableAssociation(connection, original, identity, JdbcCsiActivationAdmission.JournalRead.LIVE);
        Reservation reservation = identity.reservation();
        try (PreparedStatement statement = statement(connection,
                "SELECT storage_kind, csi_phase, csi_revision, csi_reservation_id, csi_registration_key,"
                        + " csi_registration_revision, binding_id, runtime_generation, csi_provision_request_id"
                        + " FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
            statement.setString(1, identity.physicalKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && "CSI".equals(row.getString("storage_kind"))
                        && "DRAINING".equals(row.getString("csi_phase"))
                        && row.getLong("csi_revision") == CsiOwnershipRevision.next(reservation.revision())
                        && reservation.reservationId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_reservation_id"))
                        && reservation.registrationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_registration_key"))
                        && reservation.registrationRevision() == row.getLong("csi_registration_revision")
                        && original.bindingId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "binding_id"))
                        && original.generation() == row.getLong("runtime_generation")
                        && Objects.equals(reservation.provisionRequestId(), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_provision_request_id")));
                require(!row.next());
            }
        }
    }

    private static void verifyImmutableAssociation(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            Identity identity, JdbcCsiActivationAdmission.JournalRead read) throws SQLException, IOException {
        Reservation reservation = identity.reservation();
        require("RESERVED".equals(reservation.phase()) && CsiOwnershipRevision.reserved(reservation.revision())
                && reservation.reservationId().equals(UUID.fromString(reservation.reservationId()).toString())
                && original.bindingId().equals(reservation.bindingId())
                && original.generation() == reservation.runtimeGeneration()
                && identity.leaseDigest().matches("[0-9a-f]{64}"));
        Instant.parse(identity.startedAt());
        try (PreparedStatement statement = read.statement(connection,
                "SELECT provisioner_kind, provision_request_id, resource_handle_version, resource_handle_json,"
                        + " runtime_instance_id, runtime_lease_id, runtime_epoch, attestation_generation"
                        + " FROM ma_runtime_binding WHERE binding_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
            try (var row = statement.executeQuery()) {
                require(row.next() && identity.resourceHandleKind().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "provisioner_kind"))
                        && identity.resourceHandleVersion() > 0
                        && identity.resourceHandleVersion() == row.getInt("resource_handle_version")
                        && JSON.readTree(identity.resourceHandleJson()).equals(JSON.readTree(row.getString("resource_handle_json")))
                        && identity.runtimeInstanceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "runtime_instance_id"))
                        && identity.leaseId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "runtime_lease_id"))
                        && identity.epoch() > 0 && identity.epoch() == row.getLong("runtime_epoch")
                        && identity.attestationGeneration() > 0
                        && identity.attestationGeneration() == row.getLong("attestation_generation")
                        && reservation.provisionRequestId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "provision_request_id")));
                require(!row.next());
            }
        }
        try (PreparedStatement statement = read.statement(connection,
                "SELECT tenant_id, storage_id, physical_key, registration_revision"
                        + " FROM ma_storage WHERE alias_key = ? AND storage_kind = 'CSI' AND registration_state = 'REGISTERED'")) {
            statement.setString(1, reservation.registrationKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getTenantId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"))
                        && original.request().getStorageId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "storage_id"))
                        && identity.physicalKey().equals(row.getString("physical_key"))
                        && reservation.registrationRevision() > 0
                        && reservation.registrationRevision() == row.getLong("registration_revision"));
                require(!row.next());
            }
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_retirement_identity_unavailable",
                "The original CSI retirement authorization ceiling is unavailable.", false);
    }

    private record Reservation(String phase, long revision, String reservationId, String registrationKey,
            long registrationRevision, String bindingId, long runtimeGeneration, String provisionRequestId) {
    }

    private record Identity(String operationId, String physicalKey, String phase, Reservation reservation,
            long sealedBindingVersion, String resourceHandleKind, int resourceHandleVersion, String resourceHandleJson,
            String runtimeInstanceId, String leaseId, long epoch, String leaseDigest, long attestationGeneration,
            String startedAt) {
    }
}
