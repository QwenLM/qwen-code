package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;

/** Child-process fixture for shared-MySQL ownership and recovery proof. */
public final class RuntimeBrokerProcessFixtureMain {
    private static final RuntimeScope SCOPE = new RuntimeScope(
            "mysql-process-tenant", "mysql-process-workspace", "generation",
            "/workspace", "capability", "workspace");

    private RuntimeBrokerProcessFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        DataSource dataSource = new DriverManagerDataSource(
                required("P3_MYSQL_URL"), required("P3_MYSQL_USER"),
                System.getenv().getOrDefault("P3_MYSQL_PASSWORD", ""));
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 7);
        RuntimeProvisioner provisioner = new WitnessProvisioner(dataSource);
        RuntimeTransport transport = new WitnessTransport(dataSource);
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, transport,
                new JdbcRuntimeBindingRepository(dataSource,
                        new AesGcmSecretProtector("p3-test-key", key)),
                new JdbcRuntimeSessionRepository(dataSource),
                new JdbcToolExecutionRepository(dataSource),
                required("P3_BROKER_OWNER"))) {
            service.warm("shared-harness").toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            service.acquire("shared-harness", "shared-runtime-session",
                    "bootstrap").toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            Map<String, Object> created = service.createExecution(
                    "shared-idempotency", "shared-harness",
                    "shared-runtime-session", "turn", "tool", "args",
                    Map.of("sessionId", "shared-runtime-session",
                            "promptId", "turn", "callId", "tool",
                            "argsDigest", "args", "invocationId",
                            "shared-invocation"));
            String executionCallId = (String) created.get("executionCallId");
            for (int attempt = 0; attempt < 200; attempt++) {
                Map<String, Object> current = service.getExecution(
                        "shared-harness", "shared-runtime-session",
                        executionCallId, null);
                if ("settled".equals(status(current).get("state"))) {
                    System.out.println("P3_PROCESS_FIXTURE_OK");
                    return;
                }
                Thread.sleep(10);
            }
            throw new IllegalStateException("execution did not settle");
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> status(Map<String, Object> value) {
        return (Map<String, Object>) value.get("status");
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private static final class WitnessProvisioner
            implements RuntimeProvisioner {
        private final DataSource dataSource;

        WitnessProvisioner(DataSource dataSource) {
            this.dataSource = dataSource;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new AssertionError("durable path is required");
        }

        @Override
        public String kind() {
            return "mysql-process-witness";
        }

        @Override
        public String placementDomain() {
            return "mysql-process-domain";
        }

        @Override
        public String runtimeTemplateDigest() {
            return "sha256:mysql-process-template";
        }

        @Override
        public boolean supportsDurableRecovery() {
            return true;
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle knownHandle) {
            return CompletableFuture.supplyAsync(() -> {
                try (Connection connection = dataSource.getConnection();
                        PreparedStatement insert = connection.prepareStatement(
                                "INSERT IGNORE INTO p3_physical_runtime "
                                        + "(provision_request_id) VALUES (?)")) {
                    insert.setString(1, seed.getProvisionRequestId());
                    insert.executeUpdate();
                    return handle(seed);
                } catch (SQLException exception) {
                    throw new IllegalStateException(exception);
                }
            });
        }

        @Override
        public CompletionStage<RuntimeObservation> reconcile(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle, RuntimeLease lastLease) {
            return CompletableFuture.supplyAsync(() -> {
                try (Connection connection = dataSource.getConnection();
                        PreparedStatement query = connection.prepareStatement(
                                "SELECT provision_request_id "
                                        + "FROM p3_physical_runtime "
                                        + "WHERE provision_request_id = ?")) {
                    query.setString(1, seed.getProvisionRequestId());
                    try (ResultSet result = query.executeQuery()) {
                        if (!result.next()) {
                            return RuntimeObservation.notFound();
                        }
                    }
                    return RuntimeObservation.ready(handle(seed),
                            URI.create("http://127.0.0.1:4190"),
                            seed.getProvisionalRuntimeId(),
                            seed.getLeaseId(), seed.getEpoch());
                } catch (SQLException exception) {
                    return RuntimeObservation.unknown(handle);
                }
            });
        }

        private RuntimeResourceHandle handle(RuntimeProvisionSeed seed) {
            return new RuntimeResourceHandle(kind(), 1,
                    Map.of("provisionRequestId",
                            seed.getProvisionRequestId()));
        }
    }

    private static final class WitnessTransport implements RuntimeTransport {
        private final DataSource dataSource;

        WitnessTransport(DataSource dataSource) {
            this.dataSource = dataSource;
        }

        @Override
        public CompletionStage<RuntimeAttestation> attest(
                RuntimeLease lease, RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed) {
            return CompletableFuture.completedFuture(new RuntimeAttestation(
                    lease.getRuntimeInstanceId(),
                    seed.getGatewayIncarnation(), lease.getLeaseId(),
                    lease.getEpoch(), request.getScope(),
                    seed.getProvisionRequestId()));
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(operation);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            try (Connection connection = dataSource.getConnection();
                    PreparedStatement insert = connection.prepareStatement(
                            "INSERT INTO p3_physical_execution "
                                    + "(invocation_id) VALUES (?)")) {
                insert.setString(1, (String) reference.get("invocationId"));
                insert.executeUpdate();
            } catch (SQLException exception) {
                return CompletableFuture.failedFuture(exception);
            }
            return CompletableFuture.completedFuture(
                    Map.of("executionStatus", "success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> status(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, long afterSequence) {
            boolean executed;
            try (Connection connection = dataSource.getConnection();
                    PreparedStatement query = connection.prepareStatement(
                            "SELECT invocation_id "
                                    + "FROM p3_physical_execution "
                                    + "WHERE invocation_id = ?")) {
                query.setString(1, (String) reference.get("invocationId"));
                try (ResultSet result = query.executeQuery()) {
                    executed = result.next();
                }
            } catch (SQLException exception) {
                return CompletableFuture.failedFuture(exception);
            }
            if (!executed) {
                return CompletableFuture.completedFuture(Map.of(
                        "state", "prepared", "cancelRequested", false,
                        "lastSeq", 0, "firstAvailableSeq", 1,
                        "progressGap", false, "progress",
                        java.util.List.of()));
            }
            return CompletableFuture.completedFuture(Map.of(
                    "state", "settled", "cancelRequested", false,
                    "lastSeq", 0, "firstAvailableSeq", 1,
                    "progressGap", false, "progress", java.util.List.of(),
                    "result", Map.of("executionStatus", "success")));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return status(lease, session, reference, 0);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
