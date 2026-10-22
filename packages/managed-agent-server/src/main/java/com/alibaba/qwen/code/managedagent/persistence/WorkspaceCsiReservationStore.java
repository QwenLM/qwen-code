package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationProgress;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Private persistence only; a reservation does not authorize a mount. */
public final class WorkspaceCsiReservationStore {
    public static final String PROVISIONER_KIND = "kubernetes-workspace";
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ObjectMapper json;

    public record Reservation(String phase, long revision, String reservationId,
            String registrationKey, Long registrationRevision, String bindingId,
            Long runtimeGeneration, String provisionRequestId) {
    }

    public record Retirement(String operationId, String physicalKey, String phase,
            Reservation reservation, long sealedBindingVersion, String resourceHandleKind,
            Integer resourceHandleVersion, String resourceHandleJson, String runtimeInstanceId,
            String leaseId, Long epoch, String leaseDigest, long attestationGeneration, String startedAt) {
    }

    public WorkspaceCsiReservationStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ObjectMapper json) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
        this.json = json.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    public void register(WorkspaceCsiRegistration registration) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw unavailable();
        }
        String encoded;
        try {
            encoded = json.writeValueAsString(registration);
        } catch (JsonProcessingException error) {
            throw unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, registration.tenantId());
            if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind = 'LOCAL'",
                    Long.class, registration.aliasKey()) != 0) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO ma_storage"
                    + " (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key,"
                    + " storage_kind, registration_state, registration_revision, registration_json, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, ?, ?, 'CSI', 'REGISTERED', ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")"
                    + " ON DUPLICATE KEY UPDATE gmt_modified = CASE WHEN physical_key IS NULL OR registration_revision IS NULL OR registration_json IS NULL OR registration_state = 'FENCE_ONLY' THEN VALUES(gmt_modified) ELSE gmt_modified END, physical_key = COALESCE(physical_key, VALUES(physical_key)),"
                    + " registration_revision = COALESCE(registration_revision, VALUES(registration_revision)),"
                    + " registration_json = COALESCE(registration_json, VALUES(registration_json)),"
                    + " storage_kind = CASE WHEN registration_state = 'FENCE_ONLY' THEN 'CSI' ELSE storage_kind END,"
                    + " registration_state = CASE WHEN registration_state = 'FENCE_ONLY' THEN 'REGISTERED' ELSE registration_state END",
                    registration.aliasKey(), JdbcRuntimeBindingRepository.storageFenceKey(registration.tenantId()),
                    JdbcRuntimeBindingRepository.storageFenceKey(registration.storageId()), registration.tenantId(), registration.storageId(),
                    registration.physicalKey(), registration.revision(), encoded);
            verifyRegistration(registration);
            jdbc.update("INSERT INTO ma_storage_owner (storage_key, storage_kind)"
                    + " VALUES (?, 'CSI') ON DUPLICATE KEY UPDATE storage_key = storage_key",
                    registration.physicalKey());
            readReservation(registration.physicalKey());
        });
    }

    public Reservation inspect(WorkspaceCsiRegistration registration) {
        return transaction.execute(status -> {
            verifyRegistration(registration);
            return readReservation(registration.physicalKey());
        });
    }

    public Reservation reserve(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original, String reservationId) {
        if (bindings == null || original == null || original.getState() != RuntimeBindingRecord.State.PROVISIONING
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || original.getOperationOwner() == null || original.isDrainRequested()
                || !uuid(reservationId)) {
            throw unavailable();
        }
        return transaction.execute(status -> {
            RuntimeBindingRecord authoritative;
            try {
                authoritative = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.findByIdForUpdate(connection, original.getBindingId()));
            } catch (IllegalArgumentException | IllegalStateException error) {
                throw unavailable();
            }
            Instant operationUntil = verifyBinding(registration, original, authoritative);
            verifyRegistration(registration);
            Reservation current = readReservation(registration.physicalKey());
            Instant now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))", (row, index) ->
                            Instant.ofEpochSecond(row.getLong(1), row.getLong(2) * 1000));
            if (now == null || !operationUntil.isAfter(now)) {
                throw unavailable();
            }
            String requestId = original.getProvisionSeed().getProvisionRequestId();
            if ("RESERVED".equals(current.phase())) {
                if (!reservationId.equals(current.reservationId())
                        || !registration.aliasKey().equals(current.registrationKey())
                        || !Objects.equals(registration.revision(), current.registrationRevision())
                        || !original.getBindingId().equals(current.bindingId())
                        || !Objects.equals(original.getGeneration(), current.runtimeGeneration())
                        || !requestId.equals(current.provisionRequestId())) {
                    throw busy();
                }
                return current;
            }
            if (!"RELEASED".equals(current.phase())) {
                throw busy();
            }
            long revision = nextRevision(current.revision());
            int changed = jdbc.update("UPDATE ma_storage_owner"
                    + " SET csi_phase = 'RESERVED', csi_revision = ?,"
                    + " csi_reservation_id = ?, csi_registration_key = ?, csi_registration_revision = ?,"
                    + " binding_id = ?, runtime_generation = ?, csi_provision_request_id = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RELEASED'"
                    + " AND csi_revision = ? AND holder_key IS NULL AND runtime_session_id IS NULL",
                    revision, reservationId, registration.aliasKey(), registration.revision(), original.getBindingId(),
                    original.getGeneration(), requestId, registration.physicalKey(), current.revision());
            if (changed != 1) {
                throw unavailable();
            }
            return readReservation(registration.physicalKey());
        });
    }

    public Retirement beginRetirement(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original,
            Reservation expected, String operationId) {
        requireRetirementInput(bindings, original);
        if (expected == null || !"RESERVED".equals(expected.phase()) || !CsiOwnershipRevision.reserved(expected.revision())
                || !uuid(operationId)) {
            throw unavailable();
        }
        return transaction.execute(status -> {
            RuntimeBindingRecord current = lockRetirementBinding(bindings, original);
            verifyRegistration(registration);
            Reservation holder = readReservation(registration.physicalKey());
            Retirement prior = readRetirement(current);
            if (prior != null) {
                verifyRetirement(prior, registration, current, holder);
                if (!operationId.equals(prior.operationId()) || !expected.equals(prior.reservation())) {
                    throw unavailable();
                }
                return prior;
            }
            if (!expected.equals(holder) || !matchesHolder(registration, current, holder)
                    || current.getVersion() != original.getVersion()
                    || current.getState() != original.getState()
                    || current.isDrainRequested()
                    || !current.hasSameLease(original.getLease())
                    || !Objects.equals(current.getResourceHandle(), original.getResourceHandle())
                    || !Objects.equals(current.getOperationOwner(), original.getOperationOwner())
                    || !Objects.equals(current.getOperationLeaseUntil(), original.getOperationLeaseUntil())
                    || current.getOperationGeneration() != original.getOperationGeneration()) {
                throw unavailable();
            }
            RuntimeBindingRecord sealed;
            try {
                sealed = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.sealForRetirement(connection, current));
            } catch (IllegalArgumentException | IllegalStateException error) {
                throw unavailable();
            }
            Retirement intent = snapshot(operationId, registration, sealed, expected);
            long settlementDeadline;
            try {
                settlementDeadline = Math.addExact(Instant.parse(intent.startedAt()).toEpochMilli(), 300_000L);
            } catch (ArithmeticException error) {
                throw unavailable();
            }
            String encoded;
            try {
                encoded = json.writeValueAsString(intent);
            } catch (JsonProcessingException error) {
                throw unavailable();
            }
            requireRetirementLease(current);
            new WorkspaceOperations(jdbc, registration.tenantId()).create(WorkspaceOperations.Kind.CSI_RETIREMENT,
                    operationId, WorkspaceOperations.values("binding_id", current.getBindingId(),
                            "runtime_generation", current.getGeneration(), "storage_id", registration.storageId(),
                            "physical_key", registration.physicalKey(), "phase", "DRAINING", "state", "DRAINING",
                            "identity_json", encoded, "request_json", encoded));
            if (jdbc.update("UPDATE ma_operation SET progress_format = 'qwen-csi-application-retirement/1',"
                    + " progress_version = 1, progress_stage = 'SETTLING', settlement_deadline_ms = ?"
                    + " WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND progress_format IS NULL"
                    + " AND progress_version IS NULL AND progress_stage IS NULL AND settlement_deadline_ms IS NULL",
                    settlementDeadline, WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT,
                            registration.tenantId(), operationId)) != 1) {
                throw unavailable();
            }
            requireRetirementLease(current);
            long drainingRevision = nextRevision(expected.revision());
            if (jdbc.update("UPDATE ma_storage_owner"
                    + " SET csi_phase = 'DRAINING', csi_revision = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RESERVED'"
                    + " AND csi_revision = ? AND csi_reservation_id = ?",
                    drainingRevision, registration.physicalKey(), expected.revision(), expected.reservationId()) != 1) {
                throw unavailable();
            }
            return intent;
        });
    }

    public Retirement inspectRetirement(WorkspaceCsiRegistration registration,
            JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original) {
        requireRetirementInput(bindings, original);
        return transaction.execute(status -> {
            RuntimeBindingRecord current = lockRetirementBinding(bindings, original);
            verifyRegistration(registration);
            Reservation holder = readReservation(registration.physicalKey());
            Retirement intent = readRetirement(current);
            if (intent != null) {
                verifyRetirement(intent, registration, current, holder);
            } else if (!matchesHolder(registration, current, holder)
                    || !"RESERVED".equals(holder.phase()) || current.isDrainRequested()) {
                throw unavailable();
            }
            return intent;
        });
    }

    record PublicationRuntime(RuntimeBindingRecord binding, Retirement retirement) {
    }

    PublicationRuntime lockPublication(JdbcRuntimeBindingRepository bindings,
            RuntimeBindingRecord original) {
        if (!TransactionSynchronizationManager.isActualTransactionActive() || bindings == null
                || !bindings.usesDataSource(jdbc.getDataSource()) || original == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null) {
            throw unavailable();
        }
        RuntimeBindingRecord current = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection -> {
            var target = DataSourceUtils.getTargetConnection(connection);
            if (!DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource())) {
                throw unavailable();
            }
            var guard = JdbcCsiFilesRetirementGuard.lockBindingControl(target, original.getBindingId());
            if (guard != null) {
                JdbcCsiApplicationProgress.lock(target, guard);
            }
            return bindings.lockActiveForRetirement(target, original);
        });
        WorkspaceCsiRegistration registration = readRegistration(WorkspaceCsiRegistration.aliasKey(
                current.getRequest().getScope().getTenantId(), current.getRequest().getStorageId()));
        Reservation holder = readReservation(registration.physicalKey());
        Retirement intent = readRetirement(current);
        if (current.getState() == RuntimeBindingRecord.State.READY && !current.isDrainRequested()) {
            if (intent != null || !"RESERVED".equals(holder.phase())
                    || !matchesHolder(registration, current, holder)) {
                throw unavailable();
            }
        } else {
            if (intent == null) {
                throw unavailable();
            }
            verifyRetirement(intent, registration, current, holder);
        }
        return new PublicationRuntime(current, intent);
    }

    private void requireRetirementInput(JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord original) {
        if (TransactionSynchronizationManager.isActualTransactionActive() || bindings == null
                || !bindings.usesDataSource(jdbc.getDataSource()) || original == null
                || !PROVISIONER_KIND.equals(original.getRequest().getProvisionerKind())
                || !original.getRequest().isManagedContext() || original.getProvisionSeed() == null) {
            throw unavailable();
        }
    }

    private RuntimeBindingRecord lockRetirementBinding(JdbcRuntimeBindingRepository bindings,
            RuntimeBindingRecord original) {
        try {
            return jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection -> {
                var target = DataSourceUtils.getTargetConnection(connection);
                if (!DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource())) {
                    throw unavailable();
                }
                JdbcCsiFilesRetirementGuard.lockBindingControl(target, original.getBindingId());
                return bindings.lockActiveForRetirement(target, original);
            });
        } catch (IllegalArgumentException | IllegalStateException error) {
            throw unavailable();
        }
    }

    private void requireRetirementLease(RuntimeBindingRecord binding) {
        Instant now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> Instant.ofEpochSecond(row.getLong(1), row.getLong(2) * 1000));
        if (now == null || binding.getOperationOwner() == null || binding.getOperationLeaseUntil() == null
                || !binding.getOperationLeaseUntil().isAfter(now)) {
            throw unavailable();
        }
    }

    private Retirement readRetirement(RuntimeBindingRecord binding) {
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'"
                + " AND tenant_id = ? AND target_key = ? AND target_revision = ? FOR UPDATE",
                (row, index) -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(row), binding.getRequest().getScope().getTenantId(),
                WorkspaceOperations.hash(binding.getBindingId()), binding.getGeneration());
        if (rows.size() > 1) {
            throw unavailable();
        }
        if (rows.isEmpty()) {
            return null;
        }
        Retirement value = decodeRetirement(rows.getFirst(), json);
        if (!binding.getRequest().getScope().getTenantId().equals(rows.getFirst().get("tenant_id"))
                || !binding.getBindingId().equals(value.reservation().bindingId())
                || binding.getGeneration() != value.reservation().runtimeGeneration()) {
            throw unavailable();
        }
        return value;
    }

    static Retirement decodeRetirement(Map<String, Object> row, ObjectMapper json) {
        try {
            String tenant = (String) row.get("tenant_id");
            String id = (String) row.get("operation_id");
            String request = (String) row.get("request_json");
            if (request == null || request.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 256 * 1024) {
                throw unavailable();
            }
            Retirement value = json.readValue(request, Retirement.class);
            var envelope = json.readTree((String) row.get("result_json"));
            var data = envelope.path("data");
            Reservation owner = value.reservation();
            if (tenant == null || !uuid(id) || !id.equals(value.operationId()) || owner == null
                    || !"CSI_RETIREMENT".equals(row.get("operation_kind"))
                    || !WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, id).equals(row.get("operation_key"))
                    || !WorkspaceOperations.hash(tenant).equals(row.get("scope_key"))
                    || !"RUNTIME_BINDING".equals(row.get("target_kind"))
                    || !owner.bindingId().equals(row.get("target_id"))
                    || !WorkspaceOperations.hash(owner.bindingId()).equals(row.get("target_key"))
                    || !Objects.equals(owner.runtimeGeneration(), ((Number) row.get("target_revision")).longValue())
                    || !Objects.equals(owner.registrationKey(), row.get("storage_key"))
                    || !value.physicalKey().equals(row.get("physical_key"))
                    || !"DRAINING".equals(value.phase()) || !value.phase().equals(row.get("phase"))
                    || !value.phase().equals(row.get("state"))
                    || !WorkspaceOperations.hash(request).equals(row.get("request_digest"))
                    || ((Number) row.get("payload_version")).intValue() != 1
                    || !envelope.isObject() || envelope.size() != 2 || !envelope.path("schemaVersion").isIntegralNumber()
                    || envelope.path("schemaVersion").intValue() != 1 || !data.isObject() || data.size() != 5
                    || !request.equals(data.path("identity_json").textValue())
                    || !owner.bindingId().equals(data.path("binding_id").textValue())
                    || !data.path("runtime_generation").isIntegralNumber()
                    || data.path("runtime_generation").longValue() != owner.runtimeGeneration()
                    || !value.physicalKey().equals(data.path("physical_key").textValue())
                    || !data.path("storage_id").isTextual()
                    || !JdbcRuntimeBindingRepository.storageAliasKey(tenant, data.path("storage_id").textValue()).equals(owner.registrationKey())) {
                throw unavailable();
            }
            return value;
        } catch (java.io.IOException | ClassCastException | NullPointerException error) {
            throw unavailable();
        }
    }

    private void verifyRetirement(Retirement intent, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation holder) {
        requireRetainedIdentity(json, intent, registration, binding);
        Reservation original = intent.reservation();
        if (!"DRAINING".equals(holder.phase()) || holder.revision() != nextRevision(original.revision())
                || !holder.equals(new Reservation("DRAINING", nextRevision(original.revision()),
                        original.reservationId(), original.registrationKey(), original.registrationRevision(),
                        original.bindingId(), original.runtimeGeneration(), original.provisionRequestId()))
                || binding.getState() != RuntimeBindingRecord.State.DRAINING || !binding.isDrainRequested()) {
            throw unavailable();
        }
    }

    static void requireRetainedIdentity(ObjectMapper json, Retirement intent, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding) {
        if (json == null || intent == null || registration == null || binding == null || intent.reservation() == null
                || !"RESERVED".equals(intent.reservation().phase()) || !CsiOwnershipRevision.reserved(intent.reservation().revision())
                || !matchesHolder(registration, binding, intent.reservation()) || intent.sealedBindingVersion() <= 0
                || binding.getVersion() < intent.sealedBindingVersion() || !intent.physicalKey().equals(registration.physicalKey())) {
            throw unavailable();
        }
        var expected = snapshot(json, intent.operationId(), registration, binding, intent.reservation(),
                intent.sealedBindingVersion(), intent.startedAt());
        if (intent.equals(expected)) {
            return;
        }
        try {
            if (intent.resourceHandleJson() == null || expected.resourceHandleJson() == null
                    || !WorkspaceCsiApplicationJson.object(intent.resourceHandleJson().getBytes(StandardCharsets.UTF_8), 256 * 1024)
                            .equals(WorkspaceCsiApplicationJson.object(expected.resourceHandleJson().getBytes(StandardCharsets.UTF_8), 256 * 1024))
                    || !intent.equals(new Retirement(expected.operationId(), expected.physicalKey(), expected.phase(),
                            expected.reservation(), expected.sealedBindingVersion(), expected.resourceHandleKind(),
                            expected.resourceHandleVersion(), intent.resourceHandleJson(), expected.runtimeInstanceId(),
                            expected.leaseId(), expected.epoch(), expected.leaseDigest(), expected.attestationGeneration(), expected.startedAt()))) {
                throw unavailable();
            }
        } catch (IllegalArgumentException malformed) {
            throw unavailable();
        }
    }

    private Retirement snapshot(String operationId, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation reservation) {
        return snapshot(operationId, registration, binding, reservation, binding.getVersion(),
                Instant.ofEpochMilli(ToolPublicationRetentionStore.now(jdbc)).toString());
    }

    private Retirement snapshot(String operationId, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation reservation, long version, String startedAt) {
        return snapshot(json, operationId, registration, binding, reservation, version, startedAt);
    }

    private static Retirement snapshot(ObjectMapper json, String operationId, WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation reservation, long version, String startedAt) {
        var handle = binding.getResourceHandle();
        var lease = binding.getLease();
        try {
            if (startedAt == null) {
                throw unavailable();
            }
            Instant.parse(startedAt);
            return new Retirement(operationId, registration.physicalKey(), "DRAINING", reservation, version,
                    handle == null ? null : handle.getKind(), handle == null ? null : handle.getVersion(),
                    handle == null ? null : json.writeValueAsString(handle.getValue()),
                    lease == null ? null : lease.getRuntimeInstanceId(), lease == null ? null : lease.getLeaseId(),
                    lease == null ? null : lease.getEpoch(), leaseDigest(json, lease), binding.getAttestationGeneration(), startedAt);
        } catch (JsonProcessingException | java.time.format.DateTimeParseException error) {
            throw unavailable();
        }
    }

    private static String leaseDigest(ObjectMapper json, com.alibaba.qwen.code.runtimebroker.RuntimeLease lease) {
        if (lease == null) {
            return null;
        }
        try {
            byte[] identity = json.writeValueAsBytes(List.of("qwen-csi-retirement-lease/1",
                    lease.getRuntimeInstanceId(), lease.getEndpoint().toString(), lease.getToken(),
                    lease.getLeaseId(), Long.toString(lease.getEpoch())));
            return DigestUtils.sha256Hex(identity);
        } catch (JsonProcessingException | IllegalArgumentException error) {
            throw unavailable();
        }
    }

    private static boolean matchesHolder(WorkspaceCsiRegistration registration,
            RuntimeBindingRecord binding, Reservation holder) {
        return registration.tenantId().equals(binding.getRequest().getScope().getTenantId())
                && registration.storageId().equals(binding.getRequest().getStorageId())
                && registration.mountRoot().equals(binding.getRequest().getScope().getCanonicalCwd())
                && registration.aliasKey().equals(holder.registrationKey())
                && Objects.equals(registration.revision(), holder.registrationRevision())
                && binding.getBindingId().equals(holder.bindingId())
                && Objects.equals(binding.getGeneration(), holder.runtimeGeneration())
                && binding.getProvisionSeed().getProvisionRequestId().equals(holder.provisionRequestId());
    }

    void verifyRegistration(WorkspaceCsiRegistration expected) {
        if (!expected.equals(readRegistration(expected.aliasKey()))) {
            throw unavailable();
        }
    }

    private WorkspaceCsiRegistration readRegistration(String aliasKey) {
        List<WorkspaceCsiRegistration> exact = jdbc.query("SELECT " + ManagedSchemaProjection.STORAGE.columns() + " FROM ma_storage"
                + " WHERE alias_key = ? AND storage_kind = 'CSI' AND registration_state = 'REGISTERED' FOR UPDATE", (row, index) -> {
                    String encoded = row.getString("registration_json");
                    if (encoded == null || encoded.length() > 16 * 1024) {
                        throw unavailable();
                    }
                    try {
                        WorkspaceCsiRegistration actual = json.readValue(encoded, WorkspaceCsiRegistration.class);
                        if (!actual.aliasKey().equals(row.getString("alias_key"))
                                || !actual.tenantId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"))
                                || !actual.storageId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "storage_id"))
                                || !actual.physicalKey().equals(row.getString("physical_key"))
                                || actual.revision() != row.getLong("registration_revision")) {
                            throw unavailable();
                        }
                        return actual;
                    } catch (JsonProcessingException | IllegalArgumentException error) {
                        throw unavailable();
                    }
                }, aliasKey);
        if (exact.size() != 1) {
            throw unavailable();
        }
        return exact.getFirst();
    }

    private Reservation readReservation(String physicalKey) {
        List<Reservation> rows = jdbc.query("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner"
                + " WHERE storage_key = ? FOR UPDATE", (row, index) -> {
                    Reservation value = new Reservation(row.getString("csi_phase"), row.getLong("csi_revision"),
                            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_reservation_id"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_registration_key"),
                            row.getObject("csi_registration_revision", Long.class), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "binding_id"),
                            row.getObject("runtime_generation", Long.class), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_provision_request_id"));
                    boolean released = "RELEASED".equals(value.phase()) && CsiOwnershipRevision.released(value.revision())
                            && value.reservationId() == null && value.registrationKey() == null
                            && value.registrationRevision() == null && value.bindingId() == null
                            && value.runtimeGeneration() == null && value.provisionRequestId() == null;
                    boolean reserved = ("RESERVED".equals(value.phase()) && CsiOwnershipRevision.reserved(value.revision())
                            || "DRAINING".equals(value.phase()) && CsiOwnershipRevision.draining(value.revision()))
                            && uuid(value.reservationId()) && value.registrationKey() != null
                            && value.registrationRevision() != null && value.registrationRevision() > 0
                            && value.bindingId() != null && value.runtimeGeneration() != null
                            && value.runtimeGeneration() > 0 && value.provisionRequestId() != null;
                    if (!"CSI".equals(row.getString("storage_kind")) || row.getString("holder_key") != null
                            || com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "runtime_session_id") != null || (!released && !reserved)) {
                        throw unavailable();
                    }
                    return value;
                }, physicalKey);
        if (rows.size() != 1) {
            throw unavailable();
        }
        return rows.getFirst();
    }

    private static long nextRevision(long revision) {
        try {
            return CsiOwnershipRevision.next(revision);
        } catch (IllegalArgumentException error) {
            throw unavailable();
        }
    }

    private static Instant verifyBinding(WorkspaceCsiRegistration registration, RuntimeBindingRecord original,
            RuntimeBindingRecord authoritative) {
        var request = original.getRequest();
        var scope = request.getScope();
        if (!registration.tenantId().equals(scope.getTenantId())
                || !registration.storageId().equals(request.getStorageId())
                || !registration.mountRoot().equals(scope.getCanonicalCwd())
                || authoritative == null || !request.equals(authoritative.getRequest())
                || !original.getProvisionSeed().equals(authoritative.getProvisionSeed())
                || original.getGeneration() != authoritative.getGeneration()
                || authoritative.getState() != RuntimeBindingRecord.State.PROVISIONING
                || authoritative.isDrainRequested()
                || !authoritative.hasSameLease(original.getLease())
                || !Objects.equals(original.getResourceHandle(), authoritative.getResourceHandle())
                || !original.getOperationOwner().equals(authoritative.getOperationOwner())
                || original.getOperationGeneration() != authoritative.getOperationGeneration()
                || authoritative.getOperationLeaseUntil() == null) {
            throw unavailable();
        }
        return authoritative.getOperationLeaseUntil();
    }

    private static boolean uuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_csi_unavailable", "Workspace CSI admission is unavailable.", false);
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_csi_busy", "Workspace storage is reserved.", true);
    }
}
