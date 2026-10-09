package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.CsiFileHistoryProtocol;
import com.alibaba.qwen.code.runtimebroker.CsiNativeReadbackProtocol;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.core.JsonProcessingException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Original private Session readback and context installation; no native execution grant. */
public final class WorkspaceCsiRuntimeAccess implements HarnessSessionResolver, RuntimeTransport {
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ManagedAgentStore managed;
    private final WorkspaceCsiReservationStore storage;
    private final WorkspaceCsiRegistration registration;
    private final String sessionId;
    private final String requestKey;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcRuntimeSessionRepository sessions;
    private final RuntimeTransport delegate;

    public WorkspaceCsiRuntimeAccess(JdbcTemplate jdbc, DataSourceTransactionManager manager,
            ObjectMapper json, ManagedAgentProperties properties, WorkspaceCsiRegistration registration,
            String sessionId, String requestKey, JdbcRuntimeBindingRepository bindings,
            JdbcRuntimeSessionRepository sessions, RuntimeTransport delegate) {
        if (jdbc == null || jdbc.getDataSource() == null || manager == null
                || manager.getDataSource() != jdbc.getDataSource() || bindings == null || sessions == null
                || !bindings.usesDataSource(jdbc.getDataSource()) || !sessions.usesDataSource(jdbc.getDataSource())
                || sessionId == null || !UUID.fromString(sessionId).toString().equals(sessionId)
                || requestKey == null || !requestKey.matches("[0-9a-f]{64}")) {
            throw unavailable();
        }
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
        this.managed = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        this.storage = new WorkspaceCsiReservationStore(jdbc, manager, json);
        this.registration = Objects.requireNonNull(registration);
        this.sessionId = sessionId;
        this.requestKey = requestKey;
        this.bindings = bindings;
        this.sessions = sessions;
        this.delegate = Objects.requireNonNull(delegate);
    }

    @Override
    public CompletionStage<RuntimeScope> resolve(String harnessSessionId) {
        try {
            requireSelected(harnessSessionId);
            fresh();
            return CompletableFuture.completedFuture(transaction.execute(status -> jdbc.execute(
                    (ConnectionCallback<RuntimeScope>) connection -> {
                        var original = DataSourceUtils.getTargetConnection(connection);
                        requireBound(original);
                        JdbcRuntimeBindingRepository.lockPlacementDomain(original, registration.tenantId(), 10);
                        ToolPublicationRetentionStore.lockTenant(jdbc, registration.tenantId());
                        storage.verifyRegistration(registration);
                        return request().getScope();
                    })));
        } catch (RuntimeException failure) {
            return CompletableFuture.failedFuture(failure);
        }
    }

    @Override
    public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return delegate.attest(lease, request, seed);
    }

    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
        Admission before = admission(lease, session, false);
        String operationId = UUID.nameUUIDFromBytes(sessionId.getBytes(StandardCharsets.UTF_8)).toString();
        return delegate.installContext(before.binding(), before.session(), operationId, before.context())
                .thenAccept(ignored -> {
                    Admission after = admission(lease, session, false);
                    if (before.binding().getVersion() != after.binding().getVersion()
                            || before.session().getVersion() != after.session().getVersion()
                            || before.session().getState() != after.session().getState()
                            || !before.context().equals(after.context())
                            || !before.binding().getProvisionSeed().equals(after.binding().getProvisionSeed())
                            || !before.binding().getResourceHandle().equals(after.binding().getResourceHandle())
                            || before.binding().getAttestationGeneration() != after.binding().getAttestationGeneration()) {
                        throw unavailable();
                    }
                });
    }

    private Admission admission(RuntimeLease lease, RuntimeSession session, boolean continuation) {
        fresh();
        if (session == null || lease == null || !sessionId.equals(session.getHarnessSessionId())
                || !sessionId.equals(session.getRuntimeSessionId()) || !"bootstrap".equals(session.getTurnKind())
                || session.getScope().getLifecycleAuthority() != null) {
            throw unavailable();
        }
        return transaction.execute(status -> jdbc.execute((ConnectionCallback<Admission>) connection -> {
            var original = DataSourceUtils.getTargetConnection(connection);
            requireBound(original);
            JdbcRuntimeBindingRepository.lockPlacementDomain(original, registration.tenantId(), 10);
            ToolPublicationRetentionStore.lockTenant(jdbc, registration.tenantId());
            var guard = JdbcCsiFilesRetirementGuard.lockManagedSession(original, registration.tenantId(), sessionId);
            if (guard == null) {
                throw unavailable();
            }
            if (continuation) {
                guard.requireContinuation();
            } else {
                guard.requireAdmission();
            }
            JdbcCsiFilesRetirementGuard.requireSingleSession(original, guard);
            var request = request(continuation);
            if (!guard.request().equals(request) || !request.getScope().equals(session.getScope())) {
                throw unavailable();
            }
            if (!continuation) {
                JdbcRuntimeBindingRepository.requireHarnessAdmission(original, request.getScope(), sessionId, null);
            }
            var binding = bindings.findByIdForUpdate(original, guard.bindingId());
            if (binding == null || binding.getGeneration() != guard.generation() || binding.getVersion() != guard.version()
                    || !binding.getRequest().equals(request) || !binding.hasSameLease(lease)
                    || !continuation && (binding.getState() != RuntimeBindingRecord.State.READY || binding.isDrainRequested())) {
                throw unavailable();
            }
            WorkspaceCsiRuntimeIdentity.verify(binding);
            storage.verifyRegistration(registration);
            var reserved = storage.lockPublication(bindings, binding);
            if (!continuation && reserved.retirement() != null || reserved.binding().getVersion() != binding.getVersion()) {
                throw unavailable();
            }
            var saved = sessions.findByIdForUpdate(original, request.getScope(), sessionId);
            guard.requireSession(saved);
            if (!continuation && !saved.isAcquirable()
                    || continuation && saved.getState() != RuntimeSessionRecord.State.READY
                            && saved.getState() != RuntimeSessionRecord.State.RELEASING) {
                throw unavailable();
            }
            var context = managed.findSession(registration.tenantId(), sessionId).orElseThrow(
                    WorkspaceCsiRuntimeAccess::unavailable).workspace();
            if (context.getContextRevision() != 1) {
                throw unavailable();
            }
            return new Admission(binding, saved, context);
        }));
    }

    private RuntimeProvisionRequest request() {
        return request(false);
    }

    private RuntimeProvisionRequest request(boolean continuation) {
        var request = managed.requireCsiRequest(registration, sessionId);
        var allowed = continuation ? java.util.Set.of("ACTIVE", "CLOSING", "DELETING") : java.util.Set.of("ACTIVE");
        if (!requestKey.equals(request.requestKey()) || !allowed.contains(managed.findSession(
                registration.tenantId(), sessionId).orElseThrow(WorkspaceCsiRuntimeAccess::unavailable).status())) {
            throw unavailable();
        }
        return request;
    }

    public Map<String, Object> readNative(String token, Map<String, Object> body) {
        var requestBody = CsiNativeReadbackProtocol.request(body);
        fresh();
        return transaction.execute(status -> jdbc.execute((ConnectionCallback<Map<String, Object>>) connection -> {
            var original = DataSourceUtils.getTargetConnection(connection);
            requireBound(original);
            JdbcRuntimeBindingRepository.lockPlacementDomain(original, registration.tenantId(), 10);
            ToolPublicationRetentionStore.lockTenant(jdbc, registration.tenantId());
            var guard = JdbcCsiFilesRetirementGuard.lockManagedSession(original, registration.tenantId(), sessionId);
            if (guard == null) {
                throw unavailable();
            }
            guard.requireAdmission();
            var request = request();
            var binding = bindings.findByIdForUpdate(original, guard.bindingId());
            if (binding == null || !guard.request().equals(request) || !binding.getRequest().equals(request)
                    || binding.getGeneration() != guard.generation() || binding.getVersion() != guard.version()
                    || binding.getState() != RuntimeBindingRecord.State.READY || binding.isDrainRequested()
                    || binding.getLease() == null || binding.getProvisionSeed() == null) {
                throw unavailable();
            }
            byte[] credential = token == null ? new byte[0] : token.getBytes(StandardCharsets.UTF_8);
            boolean seedMatches = MessageDigest.isEqual(binding.getProvisionSeed().getToken().getBytes(StandardCharsets.UTF_8), credential);
            boolean leaseMatches = MessageDigest.isEqual(binding.getLease().getToken().getBytes(StandardCharsets.UTF_8), credential);
            if (!seedMatches || !leaseMatches) {
                throw new RuntimeBrokerException(401, "csi_native_readback_unauthorized", "Original Runtime authentication failed.", false);
            }
            var boot = WorkspaceCsiRuntimeIdentity.boot(binding);
            var head = JdbcCsiActivationAdmission.lockNativeHead(original, guard);
            Runnable retirementFence = () -> {
                storage.verifyRegistration(registration);
                var reserved = storage.lockPublication(bindings, binding);
                if (reserved.retirement() != null || reserved.binding().getVersion() != binding.getVersion()) throw unavailable();
            };
            Map<String, Object> evidence;
            String action = (String) requestBody.get("action");
            if ("prepare".equals(action)) evidence = JdbcCsiActivationAdmission.readPreparation(original, guard, head,
                    JSON.valueToTree(requestBody.get("subject")), retirementFence);
            else {
                retirementFence.run();
                evidence = Map.of("kind", "ready");
            }
            JdbcCsiFilesRetirementGuard.requireSingleSession(original, guard);
            var saved = sessions.findByIdForUpdate(original, request.getScope(), sessionId);
            guard.requireSession(saved);
            if (saved.getState() != RuntimeSessionRecord.State.READY) {
                throw unavailable();
            }
            var context = managed.findSession(registration.tenantId(), sessionId).orElseThrow(
                    WorkspaceCsiRuntimeAccess::unavailable).workspace();
            var expected = CsiNativeReadbackProtocol.bindRequest(boot, request, context, (String) requestBody.get("requestId"));
            for (String field : java.util.List.of("identity", "context", "installedContext")) {
                if (!jsonSame(expected.get(field), requestBody.get(field))) {
                    throw unavailable();
                }
            }
            head.requireCurrentTime(original);
            if (!"bind".equals(action) && !"prepare".equals(action)) {
                throw new RuntimeBrokerException(501, "csi_native_execution_unavailable",
                        "Original native execution grants are not connected.", false);
            }
            var response = new LinkedHashMap<>(expected);
            response.remove("subject");
            response.put("action", action);
            response.put("head", Map.of("revision", head.revision(), "sequence", head.sequence(), "digest", head.digest()));
            response.put("evidence", evidence);
            return CsiNativeReadbackProtocol.response(response, requestBody);
        }));
    }

    private static boolean jsonSame(Object left, Object right) {
        try {
            return JSON.writeValueAsString(left).equals(JSON.writeValueAsString(right));
        } catch (JsonProcessingException invalid) {
            throw unavailable();
        }
    }

    private void requireSelected(String candidate) {
        if (!sessionId.equals(candidate)) {
            throw unavailable();
        }
    }

    private static void fresh() {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw unavailable();
        }
    }

    private void requireBound(java.sql.Connection connection) throws java.sql.SQLException {
        if (connection.getAutoCommit() || !DataSourceUtils.isConnectionTransactional(connection, jdbc.getDataSource())) {
            throw unavailable();
        }
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
        try {
            if (!CsiFileHistoryProtocol.isOperation(operation)) {
                throw unavailable();
            }
            CsiFileHistoryProtocol.operation(operation);
            boolean continuation = "snapshot".equals(operation.get("action"));
            Admission before = admission(lease, session, continuation);
            if (!continuation && before.session().getState() != RuntimeSessionRecord.State.READY) {
                throw unavailable();
            }
            var binding = before.binding();
            var originalBoot = WorkspaceCsiRuntimeIdentity.boot(binding);
            return delegate.csiFileHistory(lease, binding.getRequest(), binding.getProvisionSeed(), originalBoot,
                    before.context(), operation).thenApply(response -> {
                        Admission after = admission(lease, session, continuation);
                        if (!before.context().equals(after.context())
                                || !binding.getProvisionSeed().equals(after.binding().getProvisionSeed())
                                || !binding.getResourceHandle().equals(after.binding().getResourceHandle())
                                || binding.getAttestationGeneration() != after.binding().getAttestationGeneration()
                                || !continuation && (binding.getVersion() != after.binding().getVersion()
                                        || before.session().getVersion() != after.session().getVersion())) {
                            throw unavailable();
                        }
                        return (Object) response;
                    });
        } catch (RuntimeException failure) {
            return CompletableFuture.failedFuture(failure);
        }
    }

    @Override
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        return CompletableFuture.failedFuture(unavailable());
    }

    @Override
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> reference) {
        return CompletableFuture.failedFuture(unavailable());
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(409, "csi_finalize_required",
                "The original CSI Session requires retirement finalization.", false));
    }

    private record Admission(RuntimeBindingRecord binding, RuntimeSessionRecord session, ContextBinding context) {
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_original_runtime_unavailable",
                "Original CSI Runtime context admission is unavailable.", false);
    }
}
