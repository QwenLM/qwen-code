package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

class HostedWorkspaceToolTurnIT {
    @TempDir
    private Path temporary;

    @Test
    @Timeout(360)
    void packagedHarnessUsesSavedWorkspacesThroughRealBrokerWorkerAndSqlStore() throws Exception {
        runDriver(List.of("alpha", "beta", "shell", "storage-failure", "raw-reply-loss", "cancel"),
                "workspace-tool-turn");
    }

    @Test
    @Timeout(180)
    void lostBrokerRepliesNeverReplayEffectsOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG6a requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("FG6a requires -Dmysql.user").isNotBlank();
        String selected = System.getProperty("qwen.fg6a.case");
        List<String> cases = List.of("acquire", "prepare", "prepare-twice", "start", "status", "cancel",
                "release", "release-before-forward");
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        runDriver(cases, "broker-reply-loss");
    }

    @Test
    @Timeout(180)
    @ExtendWith(OutputCaptureExtension.class)
    void sessionStoreFailuresNeverReplayEffectsOnMySql(CapturedOutput output) throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG6b requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("FG6b requires -Dmysql.user").isNotBlank();
        String selected = System.getProperty("qwen.fg6b.case");
        List<String> cases = List.of("arguments", "intent", "await-runtime", "result-message",
                "result-checkpoint", "result-reply", "turn-reply");
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        runDriver(cases, "store-failure");
        for (String fault : cases) {
            if (!fault.endsWith("-reply")) assertThat(output).contains("java.sql.SQLException: FG6B_" + fault);
        }
    }

    @Test
    @Timeout(180)
    void cancellationRequiresPhysicalSettlementOnMySql() throws Exception {
        assertThat(System.getProperty("mysql.url")).as("FG6d requires -Dmysql.url").startsWith("jdbc:mysql:");
        assertThat(System.getProperty("mysql.user")).as("FG6d requires -Dmysql.user").isNotBlank();
        assertThat(System.getProperty("os.name").toLowerCase()).doesNotContain("windows");
        List<String> cases = List.of("prepared", "running", "status-unavailable", "cancel-reply");
        String selected = System.getProperty("qwen.fg6d.case");
        if (selected != null) {
            assertThat(cases).contains(selected);
            cases = List.of(selected);
        }
        runDriver(cases, "cancellation");
    }

    private void runDriver(List<String> cases, String driverName) throws Exception {
        boolean faults = !driverName.equals("workspace-tool-turn");
        boolean storeFaults = driverName.equals("store-failure");
        boolean cancellations = driverName.equals("cancellation");
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../../dist/cli.js")).toAbsolutePath().normalize();
        assertThat(cli).isRegularFile();
        String node = System.getProperty("node.executable");
        assertThat(node).as("Pass -Dnode.executable with an absolute Node.js 22+ path").isNotBlank();
        temporary = temporary.toRealPath();
        Files.createDirectory(temporary.resolve("runtime"));
        Path root = cli.getParent().getParent();
        String tenant = "hosted-tools-" + UUID.randomUUID();
        List<Path> workspaces = new ArrayList<>();
        for (String name : cases) workspaces.add(Files.createDirectory(temporary.resolve(name)));
        boolean mysql = System.getProperty("mysql.url") != null;
        var arguments = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + System.getProperty("mysql.url",
                        "jdbc:h2:mem:hosted-tools;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"),
                "--spring.datasource.driver-class-name=" + (mysql ? "com.mysql.cj.jdbc.Driver" : "org.h2.Driver"),
                "--spring.datasource.username=" + System.getProperty("mysql.user", "sa"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.capability-digest=sha256:" + "a".repeat(64),
                "--qwen.managed-agent.runtime-broker.enabled=true",
                "--qwen.managed-agent.runtime-broker.port=0",
                "--qwen.managed-agent.runtime-broker.token=hosted-tools-broker-token",
                "--qwen.managed-agent.runtime-broker.workspace-cwd=" + temporary,
                "--qwen.managed-agent.runtime-broker.state-directory=" + temporary.resolve("runtime"),
                "--qwen.managed-agent.runtime-broker.credential-key-id=test",
                "--qwen.managed-agent.runtime-broker.credential-key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "--qwen.managed-agent.runtime-broker.node-executable=" + node,
                "--qwen.managed-agent.runtime-broker.worker-entry=" + cli,
                "--qwen.managed-agent.runtime-broker.cli-entry=" + cli));
        for (int index = 0; index < workspaces.size(); index++) {
            String prefix = "--qwen.managed-agent.runtime-broker.workspace-mounts[" + index + "].";
            arguments.add(prefix + "tenant-id=" + tenant);
            arguments.add(prefix + "storage-id=storage-" + index);
            arguments.add(prefix + "root=" + workspaces.get(index));
            Files.createDirectory(workspaces.get(index).resolve("child"));
        }
        try (var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(arguments.toArray(String[]::new))) {
            JdbcTemplate jdbc = spring.getBean(JdbcTemplate.class);
            if (faults) {
                var metadata = jdbc.queryForMap("SELECT VERSION() AS version, @@version_comment AS engine");
                System.out.println((cancellations ? "FG6D_DATABASE " : storeFaults ? "FG6B_DATABASE " : "FG6A_DATABASE ") + metadata);
                assertThat(metadata.toString().toLowerCase()).containsAnyOf("mysql", "mariadb");
            }
            ManagedAgentStore store = spring.getBean(ManagedAgentStore.class);
            var sessions = new ArrayList<Map<String, Object>>();
            for (int index = 0; index < workspaces.size(); index++) {
                String workspaceId = "workspace-" + index;
                jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, ?, 1, ?,"
                        + " 'Workspace', ?, ?, 'ACTIVE')", tenant, workspaceId, "storage-" + index,
                        WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
                jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, ?, ?, TRUE, TRUE)", tenant, workspaceId, "actor".getBytes(StandardCharsets.UTF_8));
                var created = store.insertWorkspaceSessionCommand(tenant, "actor", "create-" + index,
                        "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection(workspaceId, "child"));
                sessions.add(Map.of("sessionId", created.sessionId(), "workspaceId", workspaceId,
                        "toolProfile", faults || index < 2 ? "hosted-workspace-files/1" : "hosted-workspace-shell/1",
                        "directory", workspaces.get(index).resolve("child").toString(), "fault", cases.get(index)));
                if (faults) Files.writeString(workspaces.get(index).resolve("child/proof.txt"), "x");
            }
            Path config = temporary.resolve("driver.json");
            Path resultFile = temporary.resolve("shell-output.json");
            EmbeddedRuntimeBroker broker = spring.getBean(EmbeddedRuntimeBroker.class);
            CompletableFuture<Void> statusGate = new CompletableFuture<>();
            HttpServer gateServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            gateServer.createContext("/release", exchange -> {
                statusGate.complete(null);
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
            if (faults && cases.contains("status")) {
                String statusSession = sessions.get(cases.indexOf("status")).get("sessionId").toString();
                Object service = ReflectionTestUtils.getField(broker, "service");
                RuntimeTransport transport = (RuntimeTransport) ReflectionTestUtils.getField(service, "transport");
                RuntimeTransport gated = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(),
                        new Class<?>[] {RuntimeTransport.class}, (proxy, method, args) -> {
                            Object result = method.invoke(transport, args);
                            if (method.getName().equals("execute")
                                    && ((RuntimeSession) args[1]).getHarnessSessionId().equals(statusSession)) {
                                return ((CompletionStage<?>) result).thenCombine(statusGate, (value, ignored) -> value);
                            }
                            return result;
                        });
                ReflectionTestUtils.setField(service, "transport", gated);
            }
            HostedCancellationProbe cancellationProbe = cancellations
                    ? new HostedCancellationProbe(jdbc, tenant, sessions, broker, gateServer) : null;
            gateServer.start();
            List<String> triggers = new ArrayList<>();
            try {
                if (storeFaults) {
                    for (Map<String, Object> session : sessions) {
                        if (!session.get("fault").toString().endsWith("-reply")) {
                            String trigger = "fg6b_" + UUID.randomUUID().toString().replace("-", "");
                            triggers.add(trigger);
                            createStoreFaultTrigger(jdbc, tenant, session, trigger);
                        }
                    }
                }
                new ObjectMapper().writeValue(config.toFile(), Map.of("tenantId", tenant, "sessions", sessions,
                        "resultFile", resultFile.toString(),
                        "storeUrl", "http://127.0.0.1:" + spring.getWebServer().getPort(),
                        "brokerUrl", broker.getBaseUri().toString(),
                        "statusGateUrl", "http://127.0.0.1:" + gateServer.getAddress().getPort() + "/release"));
                Path log = temporary.resolve("driver.log");
                Process driver = new ProcessBuilder(node, "--import", "tsx",
                        "integration-tests/helpers/hosted-" + driverName + "-driver.ts", config.toString())
                        .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
                try {
                    assertThat(driver.waitFor(faults ? 130 : 270, TimeUnit.SECONDS)).as("Driver timeout: %s", Files.readString(log)).isTrue();
                    assertThat(driver.exitValue()).as("Driver output: %s", Files.readString(log)).isZero();
                    System.out.println(Files.readString(log));
                    assertThat(Files.readString(log)).contains(cancellations ? "HOSTED_CANCELLATION_OK"
                            : storeFaults ? "HOSTED_STORE_FAILURES_OK"
                            : faults ? "HOSTED_REPLY_LOSS_OK" : "HOSTED_WORKSPACE_TOOLS_OK");
                    JsonNode reports = faults ? new ObjectMapper().readTree(
                            Files.readString(temporary.resolve("driver.json.results"))) : null;
                    if (faults && cases.contains("status")) assertThat(statusGate.isDone()).isTrue();
                    for (int index = 0; index < workspaces.size(); index++) {
                        Path workspace = workspaces.get(index);
                        if (cancellations) cancellationProbe.assertReport(sessions.get(index), reports.get(index));
                        else if (faults) assertFaultLedger(jdbc, tenant, sessions.get(index), index, reports.get(index), storeFaults);
                        else if (index < 2) assertThat(Files.readString(workspace.resolve("child/proof.txt"))).isEqualTo("after");
                        assertThat(workspace.resolve("proof.txt")).doesNotExist();
                    }
                } finally {
                    driver.descendants().forEach(process -> process.destroyForcibly());
                    if (driver.isAlive()) driver.destroyForcibly();
                }
                if (!faults) {
                    List<ProcessHandle> producers = ProcessHandle.current().descendants().toList();
                    assertThat(producers).as("Runtime producers before Broker shutdown").isNotEmpty();
                    broker.close();
                    for (ProcessHandle producer : producers) {
                        producer.onExit().get(10, TimeUnit.SECONDS);
                        assertThat(producer.isAlive()).as("Producer %s before retained read", producer.pid()).isFalse();
                    }
                    System.out.println("HOSTED_SHELL_PRODUCERS_EXITED: " + producers.size());
                    Path readerLog = temporary.resolve("reader.log");
                    Process reader = new ProcessBuilder(node, "--import", "tsx",
                            "integration-tests/helpers/hosted-shell-result-reader.ts", resultFile.toString())
                            .directory(root.toFile()).redirectErrorStream(true).redirectOutput(readerLog.toFile()).start();
                    try {
                        assertThat(reader.waitFor(60, TimeUnit.SECONDS)).as("Reader timeout: %s", Files.readString(readerLog)).isTrue();
                        assertThat(reader.exitValue()).as("Reader output: %s", Files.readString(readerLog)).isZero();
                        assertThat(Files.readString(readerLog)).contains("HOSTED_SHELL_RETAINED_OUTPUT_OK");
                    } finally {
                        if (reader.isAlive()) reader.destroyForcibly();
                    }
                }
            } finally {
                statusGate.complete(null);
                gateServer.stop(0);
                if (cancellationProbe != null) cancellationProbe.close();
                RuntimeException cleanupFailure = null;
                for (String trigger : triggers) {
                    try {
                        jdbc.execute("DROP TRIGGER IF EXISTS " + trigger);
                    } catch (RuntimeException cause) {
                        if (cleanupFailure == null) cleanupFailure = cause;
                        else cleanupFailure.addSuppressed(cause);
                    }
                }
                if (cleanupFailure != null) throw cleanupFailure;
            }
        }
    }

    private void assertFaultLedger(JdbcTemplate jdbc, String tenant, Map<String, Object> session, int index,
            JsonNode report, boolean storeFaults) throws Exception {
        String fault = session.get("fault").toString();
        boolean started = storeFaults ? fault.startsWith("result-") || fault.equals("turn-reply")
                : !List.of("acquire", "prepare-twice", "cancel").contains(fault);
        assertThat(Files.readString(Path.of(session.get("directory").toString()).resolve("proof.txt")))
                .as(fault + " physical effect").isEqualTo(started ? "xx" : "x");
        List<Map<String, Object>> executions = jdbc.queryForList("SELECT execution_call_id, idempotency_key,"
                + " runtime_session_id, dispatch_generation, execution_state, execution_status"
                + " FROM qwen_tool_execution WHERE harness_session_id = ?", session.get("sessionId"));
        assertThat(executions).as(fault + " reservations").hasSize(fault.equals("acquire") ? 0 : 1);
        for (Map<String, Object> execution : executions) {
            assertThat(execution.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
            assertThat(execution.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
            assertThat(execution.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
            assertThat(((Number) execution.get("dispatch_generation")).longValue()).isEqualTo(started ? 1 : 0);
            assertThat(execution.get("execution_state")).isEqualTo(fault.equals("prepare-twice") ? "PREPARED" : "SETTLED");
            if (started) assertThat(execution.get("execution_status")).isEqualTo("success");
        }
        String storageKey = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((tenant + "\u0000storage-" + index).getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> owner = jdbc.queryForMap("SELECT holder_key, runtime_session_id"
                + " FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
        boolean released = storeFaults ? fault.equals("turn-reply") : List.of("prepare", "start", "release").contains(fault);
        if (released) assertThat(owner.get("holder_key")).as(fault + " released owner").isNull();
        else {
            assertThat(owner.get("holder_key")).as(fault + " retained owner").isNotNull();
            assertThat(owner.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
        }
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, session.get("sessionId"), report.path("promptId").asText()))
                .isEqualTo(released ? "RELEASED" : "READY");
        if (storeFaults) assertStoreJournal(jdbc, tenant, session, report);
    }

    private void createStoreFaultTrigger(JdbcTemplate jdbc, String tenant, Map<String, Object> session,
            String trigger) {
        String fault = session.get("fault").toString();
        String table = fault.equals("arguments") ? "qwen_managed_session_resource" : "qwen_managed_session_journal_tx";
        String condition = switch (fault) {
            case "arguments" -> "NEW.kind = 'managed-tool-input'";
            case "intent" -> "NEW.operation = 'toolIntent'";
            case "result-message" -> "NEW.operation = 'commitMessage'"
                    + " AND LOCATE('\"role\":\"tool_result\"', CONVERT(NEW.record_bytes USING utf8mb4)) > 0";
            case "await-runtime", "result-checkpoint" -> "NEW.operation = 'commitCheckpoint' AND EXISTS (SELECT 1"
                    + " FROM qwen_managed_session_resource r WHERE r.tenant_id = NEW.tenant_id"
                    + " AND r.session_id = NEW.session_id AND r.resource_id = NEW.latest_checkpoint_resource_id"
                    + " AND r.kind = 'managed-checkpoint' AND JSON_UNQUOTE(JSON_EXTRACT("
                    + "CONVERT(r.inline_bytes USING utf8mb4), '$.continuation.phase')) = '"
                    + (fault.equals("await-runtime") ? "await_runtime" : "results_ready") + "')";
            default -> throw new IllegalArgumentException(fault);
        };
        assertThat(tenant).matches("hosted-tools-[0-9a-f-]{36}");
        assertThat(session.get("sessionId").toString()).matches("[0-9a-f-]{36}");
        jdbc.execute("CREATE TRIGGER " + trigger + " BEFORE INSERT ON " + table + " FOR EACH ROW BEGIN IF"
                + " NEW.tenant_id = '" + tenant + "' AND NEW.session_id = '" + session.get("sessionId")
                + "' AND (" + condition + ") THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'FG6B_"
                + fault + "'; END IF; END");
    }

    private void assertStoreJournal(JdbcTemplate jdbc, String tenant, Map<String, Object> session,
            JsonNode report) throws Exception {
        String sessionId = session.get("sessionId").toString();
        String fault = session.get("fault").toString();
        boolean applied = fault.endsWith("-reply");
        JsonNode target = report.path("target");
        assertThat(report.path("fault").asText()).isEqualTo(fault);
        assertThat(target.path("workspaceId").asText()).isEqualTo(session.get("workspaceId"));
        assertThat(target.path("resources").isArray()).isTrue();
        List<Map<String, Object>> committed = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? AND operation = ? AND command_id = ?",
                tenant, sessionId, target.path("operation").asText(), target.path("commandId").asText());
        assertThat(committed).as(fault + " target commit").hasSize(applied ? 1 : 0);
        assertThat(report.path("receipt").isMissingNode()).isEqualTo(!applied);
        if (applied) {
            Map<String, Object> transaction = committed.getFirst();
            JsonNode receipt = report.path("receipt");
            assertThat(transaction.get("transaction_id")).isEqualTo(target.path("transactionId").asText());
            assertThat(transaction.get("content_digest")).isEqualTo(target.path("contentDigest").asText());
            assertThat(transaction.get("record_digest")).isEqualTo(target.path("recordDigest").asText());
            assertThat(transaction.get("commit_digest")).isEqualTo(target.path("commitDigest").asText());
            assertThat((byte[]) transaction.get("record_bytes"))
                    .isEqualTo(Base64.getDecoder().decode(target.path("recordBytesBase64").asText()));
            assertThat(((Number) transaction.get("journal_revision")).longValue())
                    .isEqualTo(target.path("expectedJournalRevision").asLong() + 1)
                    .isEqualTo(receipt.path("journalRevision").asLong());
            assertThat(receipt.path("transactionId")).isEqualTo(target.path("transactionId"));
            assertThat(receipt.path("commandId")).isEqualTo(target.path("commandId"));
            assertThat(receipt.path("operation")).isEqualTo(target.path("operation"));
            assertThat(receipt.path("commitDigest")).isEqualTo(target.path("commitDigest"));
            assertThat(((Number) transaction.get("first_sequence")).longValue())
                    .isEqualTo(target.path("firstSequence").asLong()).isEqualTo(receipt.path("firstSequence").asLong());
            assertThat(((Number) transaction.get("last_sequence")).longValue())
                    .isEqualTo(target.path("lastSequence").asLong()).isEqualTo(receipt.path("committedSequence").asLong());
        }
        for (JsonNode resource : target.path("resources")) {
            List<Map<String, Object>> stored = jdbc.queryForList("SELECT * FROM qwen_managed_session_resource"
                    + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                    tenant, sessionId, resource.path("resourceId").asText());
            if (!applied) {
                if (resource.has("bytesBase64")) assertThat(stored).as(fault + " rolled-back resource").isEmpty();
                continue;
            }
            assertThat(stored).hasSize(1);
            Map<String, Object> row = stored.getFirst();
            assertThat(row.get("kind")).isEqualTo(resource.path("kind").asText());
            assertThat(row.get("sha256")).isEqualTo(resource.path("digest").asText());
            assertThat(((Number) row.get("schema_version")).intValue()).isEqualTo(resource.path("schemaVersion").asInt());
            byte[] bytes = (byte[]) row.get("inline_bytes");
            assertThat(bytes.length).isEqualTo(resource.path("byteLength").asInt());
            assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                    .isEqualTo(resource.path("digest").asText());
            if (resource.has("bytesBase64")) {
                assertThat(bytes).isEqualTo(Base64.getDecoder().decode(resource.path("bytesBase64").asText()));
            }
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref f"
                + " LEFT JOIN qwen_managed_session_resource r ON r.session_scope_key = f.session_scope_key"
                + " AND r.resource_id = f.resource_id LEFT JOIN qwen_managed_session_journal_tx t"
                + " ON t.tenant_id = f.tenant_id AND t.session_id = f.session_id AND t.journal_revision = f.journal_revision"
                + " WHERE f.tenant_id = ? AND f.session_id = ? AND (r.resource_id IS NULL OR t.transaction_id IS NULL)",
                Integer.class, tenant, sessionId)).as(fault + " dangling resource references").isZero();
        assertThat(report.path("restoreTransactions").isArray()).isTrue();
        int restored = 0;
        for (JsonNode transaction : report.path("restoreTransactions")) {
            if (transaction.path("transactionId").equals(target.path("transactionId"))) {
                restored++;
                assertThat(transaction.path("recordBytesBase64")).isEqualTo(target.path("recordBytesBase64"));
                assertThat(transaction.path("recordDigest")).isEqualTo(target.path("recordDigest"));
            }
        }
        assertThat(restored).as(fault + " target restored exactly once").isEqualTo(applied ? 1 : 0);

        ObjectMapper mapper = new ObjectMapper();
        List<Map<String, Object>> journal = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", tenant, sessionId);
        var transactionIds = new HashSet<String>();
        var eventIds = new HashSet<String>();
        List<JsonNode> events = new ArrayList<>();
        long revision = 0;
        long sequence = 0;
        Object digest = null;
        Object checkpointId = null;
        for (Map<String, Object> transaction : journal) {
            assertThat(((Number) transaction.get("journal_revision")).longValue()).isEqualTo(++revision);
            assertThat(transactionIds.add(transaction.get("transaction_id").toString())).isTrue();
            assertThat(transaction.get("previous_commit_digest")).isEqualTo(digest);
            byte[] bytes = (byte[]) transaction.get("record_bytes");
            assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                    .isEqualTo(transaction.get("record_digest"));
            long firstSequence = sequence + 1;
            int count = 0;
            for (String line : new String(bytes, StandardCharsets.UTF_8).lines().toList()) {
                JsonNode record = mapper.readTree(line);
                if (!record.path("subtype").asText().equals("managed_session_event_v1")) continue;
                JsonNode event = record.path("managedSession");
                assertThat(event.path("sequence").asLong()).isEqualTo(++sequence);
                assertThat(eventIds.add(event.path("eventId").asText())).as(fault + " duplicate event").isTrue();
                assertThat(event.path("sessionKey").path("sessionId").asText()).isEqualTo(sessionId);
                events.add(event);
                count++;
            }
            assertThat(((Number) transaction.get("event_count")).intValue()).isEqualTo(count);
            assertThat(((Number) transaction.get("first_sequence")).longValue()).isEqualTo(count == 0 ? sequence : firstSequence);
            assertThat(((Number) transaction.get("last_sequence")).longValue()).isEqualTo(sequence);
            digest = transaction.get("commit_digest");
            if (transaction.get("latest_checkpoint_resource_id") != null) {
                checkpointId = transaction.get("latest_checkpoint_resource_id");
            }
        }
        Map<String, Object> head = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, sessionId);
        assertThat(((Number) head.get("journal_revision")).longValue()).isEqualTo(revision);
        assertThat(((Number) head.get("committed_sequence")).longValue()).isEqualTo(sequence);
        assertThat(head.get("last_commit_digest")).isEqualTo(digest);
        assertThat(head.get("latest_checkpoint_resource_id")).isEqualTo(checkpointId);
        byte[] checkpoint = jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?", byte[].class,
                tenant, sessionId, checkpointId);
        String phase = mapper.readTree(checkpoint).path("continuation").path("phase").asText();
        if (fault.startsWith("result-")) assertThat(phase).isEqualTo("await_runtime");
        else assertThat(phase).isNotEqualTo("await_runtime");
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("input.accepted")
                && event.path("payload").path("turnId").asText().equals(report.path("promptId").asText())).count()).isEqualTo(1);
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("turn.settled")))
                .hasSize(fault.equals("turn-reply") ? 1 : 0);
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("tool.intent")))
                .hasSize(List.of("arguments", "intent").contains(fault) ? 0 : 1);
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                && event.path("payload").path("role").asText().equals("tool_result")))
                .hasSize(List.of("result-checkpoint", "result-reply", "turn-reply").contains(fault) ? 1 : 0);
    }
}
