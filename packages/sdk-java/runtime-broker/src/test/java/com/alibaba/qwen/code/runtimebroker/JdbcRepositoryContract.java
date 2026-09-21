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
        verifySession(dataSource, prefix);
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
                prefix + "-isolation");
        AtomicInteger firstIds = new AtomicInteger();
        AtomicInteger secondIds = new AtomicInteger();
        JdbcRuntimeBindingRepository first =
                new JdbcRuntimeBindingRepository(dataSource,
                        () -> prefix + "-binding-a-"
                                + firstIds.incrementAndGet());
        JdbcRuntimeBindingRepository second =
                new JdbcRuntimeBindingRepository(dataSource,
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

        RuntimeLease lease = new RuntimeLease(prefix + "-runtime",
                URI.create("http://127.0.0.1:4096"), prefix + "-token",
                prefix + "-lease", 1);
        RuntimeBindingRecord ready = second.compareAndSet(renewedB,
                renewedB.withState(RuntimeBindingRecord.State.READY, lease,
                        START));
        RuntimeBindingRecord healthy = second.compareAndSet(ready,
                ready.withLastHealthAt(START, START)
                        .withDrainRequested(true, START));
        RuntimeBindingRecord persistedReady = first.findById(bindingId);
        assertTrue(persistedReady.isDrainRequested());
        assertEquals(START, persistedReady.getLastHealthAt());
        assertEquals(prefix + "-token",
                persistedReady.getLease().getToken());
        RuntimeBindingRecord released = second.compareAndSet(healthy,
                healthy.withState(RuntimeBindingRecord.State.RELEASED, lease,
                        START));
        assertFalse(released.isActive());
        assertNull(first.findActive(request));

        RuntimeBindingRecord next = first.findOrCreate(request);
        assertEquals(2, next.getGeneration());
        assertTrue(next.isActive());
        JdbcRuntimeBindingRepository reconstructed =
                new JdbcRuntimeBindingRepository(dataSource);
        assertEquals(next.getBindingId(), reconstructed.findActive(request)
                .getBindingId());

        RuntimeScope otherScope = scope(prefix + "-other-tenant");
        RuntimeProvisionRequest otherRequest = new RuntimeProvisionRequest(
                otherScope, prefix + "-isolation");
        RuntimeBindingRecord other = second.findOrCreate(otherRequest);
        assertFalse(next.getBindingId().equals(other.getBindingId()));
        assertEquals(List.of(next.getBindingId()), first
                .findActiveByIsolationKey(scope, prefix + "-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(List.of(other.getBindingId()), first
                .findActiveByIsolationKey(otherScope,
                        prefix + "-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId).toList());

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
        RuntimeSessionRecord other = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-harness",
                        prefix + "-session", "bootstrap", otherScope),
                prefix + "-other-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertEquals(other.getBindingId(), second.findOrCreate(other)
                .getBindingId());
        assertEquals(candidate.getBindingId(), second.findById(scope,
                prefix + "-session").getBindingId());
        assertEquals(other.getBindingId(), first.findById(otherScope,
                prefix + "-session").getBindingId());

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

    private static RuntimeScope scope(String tenant) {
        return new RuntimeScope(tenant, "workspace", "generation",
                "/workspace", "capability", "session");
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
