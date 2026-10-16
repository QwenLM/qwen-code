package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

class JdbcCsiHistoricalTerminalTest {
    @ParameterizedTest
    @ValueSource(strings = {"autocommit", "writable", "read-committed", "serializable", "missing-binding"})
    void refusesInvalidSnapshotBeforeAnyQuery(String fault) {
        var connection = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, arguments) -> switch (method.getName()) {
                    case "getAutoCommit" -> "autocommit".equals(fault);
                    case "isReadOnly" -> !"writable".equals(fault);
                    case "getTransactionIsolation" -> switch (fault) {
                        case "read-committed" -> Connection.TRANSACTION_READ_COMMITTED;
                        case "serializable" -> Connection.TRANSACTION_SERIALIZABLE;
                        default -> Connection.TRANSACTION_REPEATABLE_READ;
                    };
                    default -> throw new AssertionError("Unexpected SQL access: " + method.getName());
                });
        assertThrows(RuntimeBrokerException.class,
                () -> JdbcCsiActivationAdmission.readHistoricalTerminal(connection, null, null));
    }

    @ParameterizedTest
    @MethodSource("historicalTimes")
    void malformedOrOverflowedTimeHasStableErrorAndClosesTheRead(String startedAt, long deadline, boolean reachesBlob) throws Exception {
        String retirement = "00000000-0000-4000-8000-000000000001";
        String binding = "00000000-0000-4000-8000-000000000002";
        var identity = new java.util.LinkedHashMap<String, Object>();
        identity.put("operationId", retirement);
        identity.put("physicalKey", "a".repeat(64));
        identity.put("phase", "DRAINING");
        identity.put("reservation", Map.of("phase", "RESERVED", "revision", 1L,
                "reservationId", "00000000-0000-4000-8000-000000000003", "registrationKey", "registration",
                "registrationRevision", 1L, "bindingId", binding, "runtimeGeneration", 1L, "provisionRequestId", "provision"));
        identity.put("sealedBindingVersion", 1L);
        identity.put("resourceHandleKind", "kubernetes-workspace");
        identity.put("resourceHandleVersion", 3);
        identity.put("resourceHandleJson", "{}");
        identity.put("runtimeInstanceId", "original-session");
        identity.put("leaseId", "lease");
        identity.put("epoch", 1L);
        identity.put("leaseDigest", "b".repeat(64));
        identity.put("attestationGeneration", 1L);
        identity.put("startedAt", startedAt);
        String encoded = new ObjectMapper().writeValueAsString(identity);
        var blobRead = new AtomicBoolean();
        var rowClosed = new AtomicInteger();
        var statementClosed = new AtomicInteger();
        var queryCount = new AtomicInteger();
        var rows = (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[] {ResultSet.class},
                (proxy, method, arguments) -> switch (method.getName()) {
                    case "next" -> true;
                    case "getString" -> switch ((String) arguments[0]) {
                        case "progress_format" -> "qwen-csi-application-retirement/1";
                        case "progress_stage" -> "DRAINED";
                        case "identity_json" -> encoded;
                        case "retirement_id" -> retirement;
                        case "physical_key" -> "a".repeat(64);
                        case "phase" -> "DRAINING";
                        default -> throw new AssertionError("Unexpected column read");
                    };
                    case "getLong" -> switch ((String) arguments[0]) {
                        case "progress_version" -> 4L;
                        case "settlement_deadline_ms" -> deadline;
                        default -> throw new AssertionError("Unexpected long column read");
                    };
                    case "getBinaryStream" -> {
                        assertEquals("frozen_request_bytes", arguments[0]);
                        blobRead.set(true);
                        yield null;
                    }
                    case "close" -> { rowClosed.incrementAndGet(); yield null; }
                    default -> throw new AssertionError("Unexpected row access: " + method.getName());
                });
        var statement = (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
                new Class<?>[] {PreparedStatement.class}, (proxy, method, arguments) -> switch (method.getName()) {
                    case "setString", "setLong", "setQueryTimeout" -> null;
                    case "executeQuery" -> { queryCount.incrementAndGet(); yield rows; }
                    case "close" -> { statementClosed.incrementAndGet(); yield null; }
                    default -> throw new AssertionError("Unexpected SQL access: " + method.getName());
                });
        var connection = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, arguments) -> switch (method.getName()) {
                    case "getAutoCommit" -> false;
                    case "isReadOnly" -> true;
                    case "getTransactionIsolation" -> Connection.TRANSACTION_REPEATABLE_READ;
                    case "prepareStatement" -> {
                        String sql = (String) arguments[0];
                        assertTrue(sql.startsWith("SELECT ") && sql.contains("FROM managed_workspace_csi_retirement")
                                && !sql.contains("FOR UPDATE"));
                        yield statement;
                    }
                    default -> throw new AssertionError("Unexpected connection access: " + method.getName());
                });
        var request = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                CsiFilesRetirementProfile.CAPABILITY_DIGEST, "session"), "original-session", "kubernetes-workspace", "storage");
        var original = new JdbcCsiFilesRetirementGuard.Original(request, binding, 1L,
                RuntimeBindingRecord.State.RELEASED, true, 1L, 2L);
        var error = assertThrows(RuntimeBrokerException.class, () -> JdbcCsiRetirementSeal.readHistorical(connection, original,
                new byte[] {0}, new JdbcCsiActivationAdmission.JournalRead(System.nanoTime())));
        assertEquals(409, error.getStatusCode());
        assertEquals("csi_retirement_identity_unavailable", error.getCode());
        assertEquals(reachesBlob, blobRead.get());
        assertEquals(1, queryCount.get());
        assertEquals(1, rowClosed.get());
        assertEquals(1, statementClosed.get());
    }

    private static Stream<Arguments> historicalTimes() {
        return Stream.of(
                Arguments.of(Instant.MAX.toString(), 0L, false),
                Arguments.of(Instant.MIN.toString(), 0L, false),
                Arguments.of(Instant.ofEpochMilli(Long.MAX_VALUE - 299999L).toString(), 0L, false),
                Arguments.of(Instant.ofEpochMilli(Long.MAX_VALUE - 300000L).toString(), Long.MAX_VALUE, true),
                Arguments.of("2001-01-01T00:00:00Z", 978307500000L, true),
                Arguments.of("not-an-instant", 0L, false));
    }
}
