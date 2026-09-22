package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import javax.sql.DataSource;

final class JdbcRepositoryContract {
    private static final Instant START = Instant.parse(
            "2026-09-20T00:00:00Z");

    private JdbcRepositoryContract() {
    }

    static void verify(DataSource dataSource, String prefix) throws Exception {
        verifySchema(dataSource);
        verifyBinding(dataSource, prefix);
        verifyLegacyLeaseCredential(dataSource, prefix);
        verifySession(dataSource, prefix);
        verifyExecution(dataSource, prefix);
    }

    private static void verifySchema(DataSource dataSource)
            throws SQLException {
        try (Connection connection = dataSource.getConnection()) {
            try (PreparedStatement create = connection.prepareStatement(
                    "CREATE TABLE IF NOT EXISTS broker_witness "
                            + "(witness_id INT PRIMARY KEY)")) {
                create.execute();
            }
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM broker_witness")) {
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO broker_witness (witness_id) VALUES (1)")) {
                insert.executeUpdate();
            }
        }
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        try (Connection connection = dataSource.getConnection();
                PreparedStatement query = connection.prepareStatement(
                        "SELECT COUNT(*) FROM broker_witness");
                ResultSet result = query.executeQuery()) {
            assertTrue(result.next());
            assertEquals(1, result.getLong(1));
        }
    }

    private static void verifyBinding(DataSource dataSource, String prefix)
            throws Exception {
        RuntimeScope scope = scope(prefix + "-tenant");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                prefix + "-isolation", "local-process",
                prefix + "-placement", prefix + "-template");
        SecretProtector protector = protector(prefix);
        AtomicInteger firstIds = new AtomicInteger();
        AtomicInteger secondIds = new AtomicInteger();
        JdbcRuntimeBindingRepository first =
                new JdbcRuntimeBindingRepository(dataSource,
                        protector,
                        () -> prefix + "-binding-a-"
                                + firstIds.incrementAndGet());
        JdbcRuntimeBindingRepository second =
                new JdbcRuntimeBindingRepository(dataSource,
                        protector,
                        () -> prefix + "-binding-b-"
                                + secondIds.incrementAndGet());

        List<RuntimeBindingRecord> created = invokeConcurrently(32,
                index -> (index % 2 == 0 ? first : second)
                        .findOrCreate(request));
        Set<String> bindingIds = created.stream()
                .map(RuntimeBindingRecord::getBindingId)
                .collect(Collectors.toSet());
        assertEquals(1, bindingIds.size());
        assertEquals(Set.of(1L), created.stream()
                .map(RuntimeBindingRecord::getGeneration)
                .collect(Collectors.toSet()));
        assertEquals(1, created.stream()
                .map(RuntimeBindingRecord::getProvisionSeed)
                .collect(Collectors.toSet()).size());
        String bindingId = bindingIds.iterator().next();
        assertThrows(IllegalArgumentException.class,
                () -> first.claimOperation(bindingId, prefix + "-owner-a",
                        Duration.ofNanos(1)));

        RuntimeBindingRecord ownerA = first.claimOperation(bindingId,
                prefix + "-owner-a", Duration.ofMinutes(30));
        assertNotNull(ownerA);
        assertEquals(1, ownerA.getOperationGeneration());
        RuntimeBindingRecord renewedA = first.renewOperation(bindingId,
                prefix + "-owner-a", ownerA.getOperationGeneration(),
                Duration.ofMinutes(30));
        assertEquals(ownerA.getOperationGeneration(),
                renewedA.getOperationGeneration());
        assertEquals(ownerA.getVersion() + 1, renewedA.getVersion());
        assertNull(second.claimOperation(bindingId, prefix + "-owner-b",
                Duration.ofMinutes(30)));
        expire(dataSource, "qwen_runtime_binding",
                "operation_lease_until", "binding_id", bindingId);

        RuntimeBindingRecord ownerB = second.claimOperation(bindingId,
                prefix + "-owner-b", Duration.ofMinutes(30));
        assertEquals(2, ownerB.getOperationGeneration());
        assertNull(first.renewOperation(bindingId, prefix + "-owner-a",
                ownerA.getOperationGeneration(), Duration.ofMinutes(30)));
        RuntimeBindingRecord renewedB = second.renewOperation(bindingId,
                prefix + "-owner-b", ownerB.getOperationGeneration(),
                Duration.ofMinutes(30));
        assertNull(first.compareAndSet(ownerA,
                ownerA.withDrainRequested(true, START)));

        RuntimeProvisionSeed seed = renewedB.getProvisionSeed();
        RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:4096"), seed.getToken(),
                seed.getLeaseId(), seed.getEpoch());
        RuntimeResourceHandle handle = new RuntimeResourceHandle(
                "local-process", 1, Map.of("pid", 42,
                        "generationDirectory", "/runtime/generation"));
        RuntimeBindingRecord ready = second.compareAndSet(renewedB,
                renewedB.withResourceHandle(handle, START)
                        .withAttestation(lease, handle, START, START));
        RuntimeBindingRecord healthy = second.compareAndSet(ready,
                ready.withLastHealthAt(START, START)
                        .withDrainRequested(true, START));
        RuntimeBindingRecord persistedReady = first.findById(bindingId);
        assertTrue(persistedReady.isDrainRequested());
        assertEquals(START, persistedReady.getLastHealthAt());
        assertEquals(seed.getToken(),
                persistedReady.getLease().getToken());
        assertEquals(handle, persistedReady.getResourceHandle());
        assertEquals(1, persistedReady.getAttestationGeneration());
        assertEquals(START, persistedReady.getLastReconciledAt());
        assertSeedEncrypted(dataSource, bindingId, seed.getToken());
        RuntimeBindingRecord released = second.compareAndSet(healthy,
                healthy.withState(RuntimeBindingRecord.State.RELEASED, lease,
                        START));
        assertFalse(released.isActive());
        assertNull(first.findActive(request));

        RuntimeBindingRecord next = first.findOrCreate(request);
        assertEquals(2, next.getGeneration());
        assertTrue(next.isActive());
        JdbcRuntimeBindingRepository reconstructed =
                new JdbcRuntimeBindingRepository(dataSource, protector);
        assertEquals(next.getBindingId(), reconstructed.findActive(request)
                .getBindingId());

        RuntimeScope otherScope = scope(prefix + "-other-tenant");
        RuntimeProvisionRequest conflictingRequest = new RuntimeProvisionRequest(
                otherScope, prefix + "-isolation", "local-process",
                prefix + "-placement", prefix + "-template");
        assertThrows(IllegalArgumentException.class,
                () -> second.findOrCreate(conflictingRequest));
        RuntimeProvisionRequest otherRequest = new RuntimeProvisionRequest(
                otherScope, prefix + "-other-isolation", "local-process",
                prefix + "-placement", prefix + "-template");
        RuntimeBindingRecord other = second.findOrCreate(otherRequest);
        assertFalse(next.getBindingId().equals(other.getBindingId()));
        assertEquals(List.of(next.getBindingId()), first
                .findActiveByIsolationKey(prefix + "-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId)
                .collect(Collectors.toList()));
        assertEquals(List.of(other.getBindingId()), first
                .findActiveByIsolationKey(prefix + "-other-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId)
                .collect(Collectors.toList()));

        RuntimeBindingRecord forged = released.withState(
                RuntimeBindingRecord.State.READY, lease, START);
        assertThrows(IllegalArgumentException.class,
                () -> second.compareAndSet(forged,
                        forged.withDrainRequested(true, START)));
    }

    private static void verifySession(DataSource dataSource, String prefix)
            throws Exception {
        JdbcRuntimeSessionRepository first =
                new JdbcRuntimeSessionRepository(dataSource);
        JdbcRuntimeSessionRepository second =
                new JdbcRuntimeSessionRepository(dataSource);
        RuntimeScope scope = scope(prefix + "-session-tenant");
        RuntimeSession session = new RuntimeSession(prefix + "-harness",
                prefix + "-session", "bootstrap", scope);
        RuntimeSessionRecord candidate = new RuntimeSessionRecord(session,
                prefix + "-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);

        List<RuntimeSessionRecord> created = invokeConcurrently(16,
                index -> (index % 2 == 0 ? first : second)
                        .findOrCreate(candidate));
        assertEquals(Set.of(prefix + "-session-binding"), created.stream()
                .map(RuntimeSessionRecord::getBindingId)
                .collect(Collectors.toSet()));
        assertEquals(1, first.countActiveByBinding(
                prefix + "-session-binding", 1));

        RuntimeSessionRecord conflicting = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-different-harness",
                        prefix + "-session", "bootstrap", scope),
                prefix + "-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertThrows(IllegalArgumentException.class,
                () -> first.findOrCreate(conflicting));

        RuntimeScope otherScope = scope(prefix + "-session-other-tenant");
        RuntimeSessionRecord scopeCollision = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-harness",
                        prefix + "-session", "bootstrap", otherScope),
                prefix + "-other-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertThrows(IllegalArgumentException.class,
                () -> second.findOrCreate(scopeCollision));
        RuntimeSessionRecord other = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-other-harness",
                        prefix + "-other-session", "bootstrap", otherScope),
                prefix + "-other-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertEquals(other.getBindingId(), second.findOrCreate(other)
                .getBindingId());
        assertEquals(candidate.getBindingId(), second.findById(
                prefix + "-session").getBindingId());
        assertEquals(other.getBindingId(), first.findById(
                prefix + "-other-session").getBindingId());

        RuntimeSessionRecord released = second.compareAndSet(candidate,
                candidate.withState(RuntimeSessionRecord.State.RELEASED,
                        START));
        assertEquals(0, first.countActiveByBinding(
                prefix + "-session-binding", 1));
        RuntimeSessionRecord forged = released.withState(
                RuntimeSessionRecord.State.READY, START);
        assertThrows(IllegalArgumentException.class,
                () -> first.compareAndSet(forged,
                        forged.withState(
                                RuntimeSessionRecord.State.RELEASING,
                                START)));
    }

    private static void verifyLegacyLeaseCredential(DataSource dataSource,
            String prefix) throws Exception {
        SecretProtector protector = protector(prefix + "-legacy");
        JdbcRuntimeBindingRepository repository =
                new JdbcRuntimeBindingRepository(dataSource, protector,
                        () -> prefix + "-legacy-binding");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                scope(prefix + "-legacy-tenant"),
                prefix + "-legacy-isolation");
        RuntimeBindingRecord created = repository.findOrCreate(request);
        RuntimeBindingRecord claimed = repository.claimOperation(
                created.getBindingId(), prefix + "-legacy-owner",
                Duration.ofMinutes(30));
        RuntimeLease lease = new RuntimeLease(prefix + "-legacy-runtime",
                URI.create("http://127.0.0.1:4097"),
                prefix + "-legacy-token", prefix + "-legacy-lease", 0);
        RuntimeBindingRecord ready = repository.compareAndSet(claimed,
                claimed.withState(RuntimeBindingRecord.State.READY, lease,
                        START).withOperation(null, null,
                                claimed.getOperationGeneration()));

        JdbcRuntimeBindingRepository reconstructed =
                new JdbcRuntimeBindingRepository(dataSource, protector);
        RuntimeBindingRecord restored = reconstructed.findById(
                ready.getBindingId());
        assertEquals(lease.getToken(), restored.getLease().getToken());
        assertEquals(lease.getEndpoint(), restored.getLease().getEndpoint());
        assertLeaseCredentialEncrypted(dataSource, ready.getBindingId(),
                lease.getToken());
    }

    private static void verifyExecution(DataSource dataSource, String prefix)
            throws Exception {
        JdbcToolExecutionRepository first =
                new JdbcToolExecutionRepository(dataSource);
        JdbcToolExecutionRepository second =
                new JdbcToolExecutionRepository(dataSource);
        String idempotencyKey = prefix + "-idempotency";

        List<ToolExecutionRecord> created = invokeConcurrently(32,
                index -> (index % 2 == 0 ? first : second).findOrCreate(
                        execution(prefix + "-execution-" + index,
                                idempotencyKey, prefix + "-digest")));
        Set<String> executionIds = created.stream()
                .map(ToolExecutionRecord::getExecutionCallId)
                .collect(Collectors.toSet());
        assertEquals(1, executionIds.size());
        String executionId = executionIds.iterator().next();
        assertThrows(IllegalArgumentException.class,
                () -> first.claimDispatch(executionId,
                        prefix + "-dispatcher-a", Duration.ofNanos(1)));

        ToolExecutionRecord ownerA = first.claimDispatch(executionId,
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        assertEquals(1, ownerA.getDispatchGeneration());
        ToolExecutionRecord renewedA = first.renewDispatch(executionId,
                prefix + "-dispatcher-a", ownerA.getDispatchGeneration(),
                Duration.ofMinutes(30));
        assertEquals(ownerA.getDispatchGeneration(),
                renewedA.getDispatchGeneration());
        assertEquals(ownerA.getVersion() + 1, renewedA.getVersion());
        ToolExecutionRecord executing = first.compareAndSet(renewedA,
                renewedA.withState(ToolExecutionRecord.State.EXECUTING,
                        false),
                prefix + "-dispatcher-a",
                renewedA.getDispatchGeneration());
        ToolExecutionRecord cancelling = second.requestCancel(executionId,
                executing.getVersion());
        assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                cancelling.getState());
        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        assertTrue(second.hasActiveByRuntimeSession(
                prefix + "-runtime-session"));
        assertTrue(second.hasActiveByBinding(prefix + "-binding", 1));
        expire(dataSource, "qwen_tool_execution",
                "dispatch_lease_until", "execution_call_id", executionId);

        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        ToolExecutionRecord unknown = second.findByExecutionCallId(
                executionId);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertEquals(prefix + "-dispatcher-a", unknown.getDispatchOwner());
        assertTrue(unknown.isCancelRequested());
        assertNull(first.renewDispatch(executionId,
                prefix + "-dispatcher-a", ownerA.getDispatchGeneration(),
                Duration.ofMinutes(30)));
        assertNull(first.compareAndSet(cancelling,
                cancelling.withResult(result("error"), 1, START),
                prefix + "-dispatcher-a",
                cancelling.getDispatchGeneration()));
        Map<String, Object> result = result("cancelled");
        ToolExecutionRecord settled = second.resolveUnknown(unknown, result,
                START);
        assertEquals(result, settled.getResult());
        assertFalse(first.hasActiveByRuntimeSession(
                prefix + "-runtime-session"));
        assertFalse(first.hasActiveByBinding(prefix + "-binding", 1));
        assertNull(first.claimDispatch(executionId,
                prefix + "-dispatcher-a", Duration.ofMinutes(1)));

        JdbcToolExecutionRepository reconstructed =
                new JdbcToolExecutionRepository(dataSource);
        ToolExecutionRecord restored = reconstructed
                .findByExecutionCallId(executionId);
        assertEquals("cancelled", restored.getExecutionStatus());
        assertEquals(result, restored.getResult());
        ToolExecutionRecord changed = execution(prefix + "-changed",
                idempotencyKey, prefix + "-changed-digest");
        ToolExecutionRecord original = reconstructed.findOrCreate(changed);
        assertEquals(executionId, original.getExecutionCallId());
        assertFalse(original.sameRequest(changed));
    }

    private static RuntimeScope scope(String tenant) {
        return new RuntimeScope(tenant, "workspace", "generation",
                "/workspace", "capability", "session");
    }

    private static ToolExecutionRecord execution(String executionCallId,
            String idempotencyKey, String digest) {
        String prefix = idempotencyKey.substring(0,
                idempotencyKey.length() - "-idempotency".length());
        return ToolExecutionRecord.prepared(executionCallId, idempotencyKey,
                prefix + "-binding", 1, prefix + "-harness",
                prefix + "-runtime-session", prefix + "-turn",
                prefix + "-tool", digest,
                Map.of("sessionId", prefix + "-runtime-session",
                        "promptId", prefix + "-turn", "callId",
                        prefix + "-tool", "argsDigest", digest));
    }

    private static Map<String, Object> result(String status) {
        return Map.of("executionStatus", status, "output",
                List.of("durable", "result"));
    }

    private static SecretProtector protector(String prefix) {
        byte[] key = new byte[32];
        byte[] source = prefix.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (int index = 0; index < key.length; index++) {
            key[index] = source[index % source.length];
        }
        return new AesGcmSecretProtector(prefix + "-key", key);
    }

    private static void assertSeedEncrypted(DataSource dataSource,
            String bindingId, String token) throws SQLException {
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT provision_seed_ciphertext, credential_key_id "
                                + "FROM qwen_runtime_binding "
                                + "WHERE binding_id = ?")) {
            statement.setString(1, bindingId);
            try (ResultSet result = statement.executeQuery()) {
                assertTrue(result.next());
                assertNotNull(result.getString(1));
                assertFalse(result.getString(1).contains(token));
                assertNotNull(result.getString(2));
            }
        }
    }

    private static void assertLeaseCredentialEncrypted(DataSource dataSource,
            String bindingId, String token) throws SQLException {
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT runtime_credential_ciphertext, "
                                + "runtime_credential_key_id, "
                                + "provision_seed_ciphertext "
                                + "FROM qwen_runtime_binding "
                                + "WHERE binding_id = ?")) {
            statement.setString(1, bindingId);
            try (ResultSet result = statement.executeQuery()) {
                assertTrue(result.next());
                assertNotNull(result.getString(1));
                assertFalse(result.getString(1).contains(token));
                assertNotNull(result.getString(2));
                assertNull(result.getString(3));
            }
        }
    }

    private static void expire(DataSource dataSource, String table,
            String leaseColumn, String idColumn, String id)
            throws SQLException {
        String sql = "UPDATE " + table + " SET " + leaseColumn
                + " = ? WHERE " + idColumn + " = ?";
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        sql)) {
            JdbcRepositorySupport.setInstant(statement, 1,
                    Instant.parse("2000-01-01T00:00:00Z"));
            statement.setString(2, id);
            assertEquals(1, statement.executeUpdate());
        }
    }

    private static <T> List<T> invokeConcurrently(int count,
            IndexedOperation<T> operation) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(8);
        try {
            List<Callable<T>> operations = new ArrayList<>();
            for (int index = 0; index < count; index++) {
                int current = index;
                operations.add(() -> operation.run(current));
            }
            List<Future<T>> futures = executor.invokeAll(operations);
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get());
            }
            return results;
        } finally {
            executor.shutdownNow();
        }
    }

    @FunctionalInterface
    private interface IndexedOperation<T> {
        T run(int index) throws Exception;
    }
}
