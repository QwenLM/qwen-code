package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.stream.IntStream;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class BindingExecutionInventoryTest {
    private static final String BINDING = "binding";
    private static final long GENERATION = 2;
    private static final Instant COMPLETION = Instant.parse("2026-10-02T00:00:00Z");

    @Test
    void memoryInventoriesEveryStateAcrossSessionsWithStablePaging() {
        var repository = new InMemoryToolExecutionRepository();
        verifyInventory(repository, repository, repository::abandonByBinding);
        verifyBounds(repository);
    }

    @Test
    void independentJdbcInstancesInventoryEveryStateWithStablePaging() {
        DataSource source = dataSource();
        var writer = new JdbcToolExecutionRepository(source);
        var reader = new JdbcToolExecutionRepository(source);
        verifyInventory(writer, reader, binding ->
                JdbcRepositorySupport.transaction(source, connection -> {
                    JdbcToolExecutionRepository.abandonByBinding(connection, binding);
                    return null;
                }));
        verifyBounds(reader);
    }

    @Test
    void jdbcRejectsBindingAliasesFromCaseInsensitiveDatabaseComparison() throws Exception {
        DataSource source = dataSource();
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE qwen_tool_execution "
                    + "ALTER COLUMN binding_id VARCHAR_IGNORECASE(512) NOT NULL");
        }
        var writer = new JdbcToolExecutionRepository(source);
        writer.findOrCreate(prepared("foreign-case", "BINDING", GENERATION, "session"));
        var reader = new JdbcToolExecutionRepository(source);
        assertThrows(IllegalStateException.class,
                () -> reader.findByBinding(BINDING, GENERATION, null, 100));
    }

    @Test
    void jdbcFullyDecodesTerminalRecordsAndRejectsCorruptResults() throws Exception {
        DataSource source = dataSource();
        var writer = new JdbcToolExecutionRepository(source);
        ToolExecutionRecord record = writer.findOrCreate(prepared("settled", BINDING, GENERATION, "session"));
        writer.requestCancel(record.getExecutionCallId(), record.getVersion());
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            assertEquals(1, statement.executeUpdate("UPDATE qwen_tool_execution "
                    + "SET result_json = '{\"executionStatus\":\"success\"}'"));
        }
        var reader = new JdbcToolExecutionRepository(source);
        assertThrows(IllegalArgumentException.class,
                () -> reader.findByBinding(BINDING, GENERATION, null, 100));
    }

    @Test
    void jdbcRejectsCorruptExecutionHashesBeforeReturningInventory() throws Exception {
        DataSource source = dataSource();
        new JdbcToolExecutionRepository(source).findOrCreate(prepared("record", BINDING, GENERATION, "session"));
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            assertEquals(1, statement.executeUpdate("UPDATE qwen_tool_execution "
                    + "SET execution_call_id_hash = '" + "0".repeat(64) + "'"));
        }
        var reader = new JdbcToolExecutionRepository(source);
        assertThrows(IllegalStateException.class,
                () -> reader.findByBinding(BINDING, GENERATION, null, 100));
    }

    @Test
    void memoryRejectsExecutionIdsThatAliasWhenEncodedForTheHashCursor() {
        var repository = new InMemoryToolExecutionRepository();
        repository.findOrCreate(prepared("?", BINDING, GENERATION, "session"));
        repository.findOrCreate(prepared("\ud800", BINDING, GENERATION, "session"));
        assertEquals(JdbcRepositorySupport.valueKey("?"), JdbcRepositorySupport.valueKey("\ud800"));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findByBinding(BINDING, GENERATION, null, 100));
    }

    @Test
    void customRepositoryDefaultRejectsInventoryInsteadOfReportingEmpty() {
        ToolExecutionRepository custom = (ToolExecutionRepository) Proxy.newProxyInstance(
                ToolExecutionRepository.class.getClassLoader(), new Class<?>[] {ToolExecutionRepository.class},
                (proxy, method, arguments) -> {
                    assertTrue(method.isDefault());
                    return InvocationHandler.invokeDefault(proxy, method, arguments);
                });
        assertThrows(UnsupportedOperationException.class,
                () -> custom.findByBinding(BINDING, GENERATION, null, 100));
    }

    private static void verifyInventory(ToolExecutionRepository writer,
            ToolExecutionRepository reader, Consumer<RuntimeBindingRecord> abandon) {
        List<String> ids = IntStream.range(0, 105).mapToObj(index -> "execution-" + index)
                .sorted(Comparator.comparing(JdbcRepositorySupport::valueKey)).toList();
        writer.findOrCreate(prepared(ids.getFirst(), BINDING, GENERATION, "session-0"));
        RuntimeBindingRecord lost = lostBinding();
        abandon.accept(lost);
        assertFalse(lost.hasStoppedWriters(), "abandonment has no physical stop proof");
        assertFalse(reader.hasActiveByBinding(BINDING, GENERATION));
        assertEquals(ToolExecutionRecord.State.ABANDONED,
                reader.findByBinding(BINDING, GENERATION, null, 1).getFirst().getState());
        for (int index = 1; index < ids.size(); index++) {
            ToolExecutionRecord record = writer.findOrCreate(
                    prepared(ids.get(index), BINDING, GENERATION, "session-" + index));
            if (index <= 5) {
                record = writer.claimDispatch(record.getExecutionCallId(), "dispatcher", Duration.ofHours(1));
                if (index < 5) {
                    record = writer.compareAndSet(record,
                            record.withState(ToolExecutionRecord.State.EXECUTING, false),
                            record.getDispatchOwner(), record.getDispatchGeneration());
                }
                if (index == 1) {
                    writer.compareAndSet(record, record.withResult(
                            Map.of("executionStatus", "success", "output", List.of("original result")),
                            7, COMPLETION), record.getDispatchOwner(), record.getDispatchGeneration());
                } else if (index == 2) {
                    writer.compareAndSet(record, record.withUnknown(),
                            record.getDispatchOwner(), record.getDispatchGeneration());
                } else if (index == 3) {
                    writer.requestCancel(record.getExecutionCallId(), record.getVersion());
                }
            }
        }
        writer.findOrCreate(prepared("foreign-binding", "other-binding", GENERATION, "session-1"));
        writer.findOrCreate(prepared("older-generation", BINDING, GENERATION - 1, "session-1"));
        writer.findOrCreate(prepared("newer-generation", BINDING, GENERATION + 1, "session-1"));
        List<ToolExecutionRecord> first = reader.findByBinding(BINDING, GENERATION, null, 100);
        assertEquals(ids.subList(0, 100), executionIds(first));
        assertEquals(EnumSet.allOf(ToolExecutionRecord.State.class),
                EnumSet.copyOf(first.stream().map(ToolExecutionRecord::getState).toList()));
        for (ToolExecutionRecord record : first) {
            assertRecordEquals(writer.findByExecutionCallId(record.getExecutionCallId()), record);
        }
        assertThrows(UnsupportedOperationException.class, () -> first.removeFirst());

        for (String id : ids.subList(99, ids.size())) {
            ToolExecutionRecord before = writer.findByExecutionCallId(id);
            assertEquals(ToolExecutionRecord.State.PREPARED, before.getState());
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    writer.requestCancel(id, before.getVersion()).getState());
        }
        List<ToolExecutionRecord> second = reader.findByBinding(BINDING, GENERATION, ids.get(99), 100);
        assertEquals(ids.subList(100, ids.size()), executionIds(second),
                "settling the cursor and remaining rows must not skip them");
        assertTrue(second.stream().allMatch(ToolExecutionRecord::isSettled));
        List<String> visited = new ArrayList<>(executionIds(first));
        visited.addAll(executionIds(second));
        assertEquals(ids, visited);
        assertTrue(reader.findByBinding(BINDING, GENERATION, ids.getLast(), 100).isEmpty());
        assertEquals(List.of("older-generation"),
                executionIds(reader.findByBinding(BINDING, GENERATION - 1, null, 100)));
        assertEquals(List.of("newer-generation"),
                executionIds(reader.findByBinding(BINDING, GENERATION + 1, null, 100)));
        assertEquals(List.of("foreign-binding"),
                executionIds(reader.findByBinding("other-binding", GENERATION, null, 100)));
        assertTrue(reader.findByBinding("absent", GENERATION, null, 100).isEmpty());
        assertEquals(ids.stream().filter(id -> JdbcRepositorySupport.valueKey(id).compareTo(
                        JdbcRepositorySupport.valueKey("missing-cursor")) > 0).limit(100).toList(),
                executionIds(reader.findByBinding(BINDING, GENERATION, "missing-cursor", 100)));
    }

    private static void verifyBounds(ToolExecutionRepository repository) {
        for (String bindingId : Arrays.asList(null, "", "\0", "x".repeat(513))) {
            assertThrows(IllegalArgumentException.class,
                    () -> repository.findByBinding(bindingId, GENERATION, null, 100));
        }
        for (long generation : new long[] {0, -1, Long.MIN_VALUE}) {
            assertThrows(IllegalArgumentException.class,
                    () -> repository.findByBinding(BINDING, generation, null, 100));
        }
        for (int limit : new int[] {-1, 0, 101, Integer.MAX_VALUE}) {
            assertThrows(IllegalArgumentException.class,
                    () -> repository.findByBinding(BINDING, GENERATION, null, limit));
        }
        for (String cursor : List.of("", "\0", "x".repeat(513), "\ud800", "\udc00")) {
            assertThrows(IllegalArgumentException.class,
                    () -> repository.findByBinding(BINDING, GENERATION, cursor, 100));
        }
    }

    private static void assertRecordEquals(ToolExecutionRecord expected, ToolExecutionRecord actual) {
        assertTrue(expected.sameIdentity(actual));
        assertTrue(expected.sameDispatch(actual));
        assertEquals(expected.getState(), actual.getState());
        assertEquals(expected.getExecutionStatus(), actual.getExecutionStatus());
        assertEquals(expected.getResult(), actual.getResult());
        assertEquals(expected.getLastSequence(), actual.getLastSequence());
        assertEquals(expected.isCancelRequested(), actual.isCancelRequested());
        assertEquals(expected.getVersion(), actual.getVersion());
        assertEquals(expected.getSettledAt(), actual.getSettledAt());
        assertEquals(expected.getAbandonedAt(), actual.getAbandonedAt());
        assertEquals(expected.getLossEvidenceId(), actual.getLossEvidenceId());
    }

    private static List<String> executionIds(List<ToolExecutionRecord> records) {
        return records.stream().map(ToolExecutionRecord::getExecutionCallId).toList();
    }

    private static ToolExecutionRecord prepared(String id, String bindingId, long generation, String sessionId) {
        return ToolExecutionRecord.prepared(id, id + "-key", bindingId, generation,
                sessionId + "-harness", sessionId, "turn", id, "digest",
                Map.of("sessionId", sessionId, "promptId", "turn", "callId", id,
                        "argsDigest", "digest", "runtimeProtocol", 3));
    }

    private static RuntimeBindingRecord lostBinding() {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "generation",
                "/workspace", "capability", "workspace");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, null, "test");
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create(BINDING, GENERATION);
        RuntimeResourceHandle handle = new RuntimeResourceHandle("test", 1, Map.of("resource", "original"));
        RuntimeBindingRecord binding = new RuntimeBindingRecord(BINDING, request, seed, GENERATION,
                RuntimeBindingRecord.State.PROVISIONING, null, handle, 0, false,
                null, null, 0, 0, null, null, COMPLETION);
        return binding.withRecoveryEvidence(new RuntimeRecoveryEvidence("loss", RuntimeRecoveryEvidence.Fact.JOURNAL_LOST,
                "test", COMPLETION, "original-domain", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), handle), null, COMPLETION);
    }

    private static DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:binding-inventory-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        return source;
    }
}
