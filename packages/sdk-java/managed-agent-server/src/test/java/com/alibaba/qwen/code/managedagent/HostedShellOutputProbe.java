package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

final class HostedShellOutputProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final List<Map<String, Object>> sessions;
    private final Object local;
    private final Map<String, Map<String, Object>> owners = new HashMap<>();
    private final Set<ProcessHandle> processes = new LinkedHashSet<>();
    private final Set<String> prefixes = new HashSet<>();
    private final Set<String> killed = new HashSet<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();

    HostedShellOutputProbe(JdbcTemplate jdbc, String tenant, List<Map<String, Object>> sessions,
            EmbeddedRuntimeBroker broker, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.sessions = sessions;
        Object service = ReflectionTestUtils.getField(broker, "service");
        Object provisioner = ReflectionTestUtils.getField(service, "provisioner");
        local = ReflectionTestUtils.getField(provisioner, "delegate");
        server.createContext("/shell-output/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath().split("/");
                assertThat(route).hasSize(4);
                var session = sessions.stream().filter(value -> value.get("sessionId").equals(route[2]))
                        .findFirst().orElseThrow();
                byte[] response = JSON.writeValueAsBytes(check(session, route[3]));
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
                byte[] response = error.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, response.length);
                exchange.getResponseBody().write(response);
            } finally {
                exchange.close();
            }
        });
    }

    private Map<String, Object> execution(String id) {
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?", id);
        assertThat(rows).hasSize(1);
        return rows.getFirst();
    }

    private Map<String, Object> owner(Map<String, Object> session) throws Exception {
        String key = sha256((tenant + "\u0000storage-" + sessions.indexOf(session)).getBytes(StandardCharsets.UTF_8));
        return jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", key);
    }

    private List<?> owned() {
        return new ArrayList<>(((Map<?, ?>) ReflectionTestUtils.getField(local, "owned")).values());
    }

    private Process worker(Map<String, Object> execution) {
        var matching = owned().stream().filter(value -> {
            var seed = (RuntimeProvisionSeed) ReflectionTestUtils.getField(value, "seed");
            return seed.getProvisionalRuntimeId().equals(execution.get("binding_id"))
                    && seed.getEpoch() == ((Number) execution.get("runtime_generation")).longValue();
        }).toList();
        assertThat(matching).as("original execution's owned worker").hasSize(1);
        return (Process) ReflectionTestUtils.getField(matching.getFirst(), "process");
    }

    private void capture(Process process) {
        processes.add(process.toHandle());
        processes.addAll(process.descendants().toList());
    }

    private Map<String, Object> check(Map<String, Object> session, String phase) throws Exception {
        String id = session.get("sessionId").toString();
        String fault = session.get("fault").toString();
        var row = execution(id);
        if (phase.equals("state")) return Map.of("state", row.get("execution_state"));
        if (phase.equals("prepared")) {
            assertThat(owners.putIfAbsent(id, owner(session))).isNull();
            assertThat(row.get("execution_state")).isEqualTo("PREPARED");
            capture(worker(row));
        } else if (phase.equals("prefix") || phase.equals("kill-worker")) {
            assertThat(row.get("execution_state")).isEqualTo("EXECUTING");
            var resources = resources(id, "managed-tool-result-content");
            var prefix = resources.stream().filter(resource -> ((Number) resource.get("byte_length")).intValue() == 1024 * 1024).toList();
            assertThat(prefix).hasSize(1);
            assertThat((byte[]) prefix.getFirst().get("inline_bytes")).isEqualTo(prefixBytes());
            assertThat(prefix.getFirst().get("sha256")).isEqualTo(sha256(prefixBytes()));
            if (phase.equals("prefix")) assertThat(prefixes.add(id)).isTrue();
            if (fault.endsWith("-kill")) {
                Process worker = worker(row);
                assertThat(worker.isAlive()).isTrue();
                capture(worker);
                long pid = Long.parseLong(Files.readString(Path.of(session.get("directory").toString()).resolve("shell.pid")));
                assertThat(worker.descendants().filter(process -> process.pid() == pid && running(process)).toList())
                        .as("real Shell child alive at durable-prefix barrier").hasSize(1);
                assertThat(resources(id, "managed-tool-result-manifest")).isEmpty();
                assertThat(resources(id, "managed-tool-outcome")).isEmpty();
                if (phase.equals("kill-worker")) {
                    assertThat(fault).isEqualTo("worker-kill");
                    assertThat(killed.add(id)).isTrue();
                    worker.destroyForcibly();
                    assertThat(worker.waitFor(10, TimeUnit.SECONDS)).isTrue();
                    assertThat(worker.exitValue()).isEqualTo(137);
                    return Map.of("process", "worker", "pid", worker.pid(), "signal", "SIGKILL");
                }
            }
        } else {
            assertThat(phase).isEqualTo("finished");
            assertThat(prefixes).contains(id);
            assertThat(row.get("execution_state")).as("unaccepted Shell capture cannot settle Broker execution").isEqualTo("UNKNOWN");
            assertThat(row.get("execution_status")).isNull();
            assertThat(row.get("result_json")).isNull();
            assertThat(Files.readString(Path.of(session.get("directory").toString()).resolve("proof.txt"))).isEqualTo("xx");
            assertJournal(session, null);
            assertCapture(session, row);
        }
        assertThat(((Number) row.get("dispatch_generation")).longValue()).isEqualTo(phase.equals("prepared") ? 0 : 1);
        var original = owners.get(id);
        assertThat(original).isNotNull();
        assertThat(owner(session)).as("original workspace owner retained").isEqualTo(original);
        for (String key : List.of("binding_id", "runtime_generation", "runtime_session_id")) {
            assertThat(original.get(key)).isEqualTo(row.get(key));
        }
        assertThat(original.get("holder_key")).isEqualTo(sha256((row.get("binding_id") + "\u0000"
                + row.get("runtime_generation") + "\u0000" + row.get("runtime_session_id")).getBytes(StandardCharsets.UTF_8)));
        assertThat(jdbc.queryForList("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?",
                String.class, id)).containsExactly("READY");
        return Map.of("state", row.get("execution_state"));
    }

    private List<Map<String, Object>> resources(String id, String kind) {
        return jdbc.queryForList("SELECT * FROM qwen_managed_session_resource WHERE tenant_id = ? AND session_id = ? AND kind = ?",
                tenant, id, kind);
    }

    private byte[] resource(String id, String resourceId, String digest, int length) throws Exception {
        var row = jdbc.queryForMap("SELECT * FROM qwen_managed_session_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                tenant, id, resourceId);
        byte[] bytes = (byte[]) row.get("inline_bytes");
        assertThat(bytes).hasSize(length);
        assertThat(((Number) row.get("byte_length")).intValue()).isEqualTo(length);
        assertThat(sha256(bytes)).isEqualTo(digest).isEqualTo(row.get("sha256"));
        return bytes;
    }

    private void assertCapture(Map<String, Object> session, Map<String, Object> execution) throws Exception {
        String id = session.get("sessionId").toString();
        var manifests = resources(id, "managed-tool-result-manifest");
        if (session.get("fault").toString().endsWith("-kill")) {
            assertThat(manifests).isEmpty();
            assertThat(resources(id, "managed-tool-result-content")).hasSize(1);
            return;
        }
        assertThat(manifests).hasSize(1);
        var row = manifests.getFirst();
        JsonNode manifest = JSON.readTree(resource(id, row.get("resource_id").toString(), row.get("sha256").toString(),
                ((Number) row.get("byte_length")).intValue()));
        assertThat(manifest.path("tenantId").asText()).isEqualTo(tenant);
        assertThat(manifest.path("sessionId").asText()).isEqualTo(id);
        assertThat(manifest.path("turnId").asText()).isEqualTo(execution.get("turn_id"));
        assertThat(manifest.path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
        var reference = JSON.readTree(execution.get("reference_json").toString());
        assertThat(reference.path("runtimeProtocol").asInt()).isEqualTo(3);
        assertThat(manifest.path("callId").isTextual()).isTrue();
        assertThat(manifest.path("callId")).isEqualTo(reference.path("callId"));
        assertThat(manifest.path("invocationDigest").isTextual()).isTrue();
        assertThat(manifest.path("invocationDigest")).isEqualTo(reference.path("inputDigest"));
        assertThat(manifest.path("bindingGeneration").asText()).isEqualTo(execution.get("runtime_generation").toString());
        assertThat(manifest.path("captureStatus").asText()).isEqualTo("complete");
        assertThat(manifest.path("executionStatus").asText()).isEqualTo("success");
        assertThat(manifest.path("exitCode").asInt(-1)).isZero();
        assertThat(manifest.path("contents").size()).isEqualTo(2);
        var streams = new HashSet<String>();
        for (JsonNode content : manifest.path("contents")) {
            String stream = content.path("streamId").asText();
            assertThat(streams.add(stream)).isTrue();
            assertThat(content.path("state").asText()).isEqualTo("sealed");
            var bytes = new ByteArrayOutputStream();
            int ordinal = 0;
            for (JsonNode pageRef : content.path("body").path("pages")) {
                JsonNode ref = pageRef.path("ref");
                JsonNode page = JSON.readTree(resource(id, ref.path("resourceId").asText(), ref.path("digest").asText(), ref.path("byteLength").asInt()));
                assertThat(page.path("captureId")).isEqualTo(manifest.path("captureId"));
                assertThat(page.path("streamId").asText()).isEqualTo(stream);
                assertThat(page.path("firstOrdinal").asInt()).isEqualTo(ordinal);
                assertThat(page.path("offset").asInt()).isEqualTo(bytes.size());
                assertThat(page.path("segments").size()).isEqualTo(pageRef.path("segmentCount").asInt());
                int before = bytes.size();
                for (JsonNode segment : page.path("segments")) {
                    String resourceId = sha256(JSON.writeValueAsBytes(List.of(manifest.path("captureId").asText(), stream, ordinal++)));
                    bytes.write(resource(id, resourceId, segment.path("digest").asText(), segment.path("byteLength").asInt()));
                }
                assertThat(bytes.size() - before).isEqualTo(pageRef.path("byteLength").asInt());
            }
            byte[] expected = stream.equals("stdout") ? concat(prefixBytes(), "stdout-tail\n") : "stderr-tail\n".getBytes(StandardCharsets.UTF_8);
            assertThat(bytes.toByteArray()).isEqualTo(expected);
            assertThat(content.path("byteLength").asInt()).isEqualTo(expected.length);
            assertThat(content.path("digest").asText()).isEqualTo(sha256(expected));
        }
        assertThat(streams).containsExactlyInAnyOrder("stdout", "stderr");
    }

    private void assertJournal(Map<String, Object> session, JsonNode report) throws Exception {
        String id = session.get("sessionId").toString();
        boolean applied = session.get("fault").equals("receipt-reply");
        var journal = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", tenant, id);
        var events = new ArrayList<JsonNode>();
        var eventIds = new HashSet<String>();
        long revision = 0;
        long sequence = 0;
        Object previous = null;
        for (var row : journal) {
            assertThat(((Number) row.get("journal_revision")).longValue()).isEqualTo(++revision);
            assertThat(row.get("previous_commit_digest")).isEqualTo(previous);
            previous = row.get("commit_digest");
            byte[] bytes = (byte[]) row.get("record_bytes");
            assertThat(sha256(bytes)).isEqualTo(row.get("record_digest"));
            for (String line : new String(bytes, StandardCharsets.UTF_8).lines().toList()) {
                JsonNode record = JSON.readTree(line);
                if (!record.path("subtype").asText().equals("managed_session_event_v1")) continue;
                JsonNode event = record.path("managedSession");
                assertThat(event.path("sequence").asLong()).isEqualTo(++sequence);
                assertThat(eventIds.add(event.path("eventId").asText())).isTrue();
                assertThat(event.path("sessionKey").path("sessionId").asText()).isEqualTo(id);
                events.add(event);
            }
        }
        var execution = execution(id);
        for (String kind : List.of("input.accepted", "tool.intent", "tool.receipt", "turn.settled")) {
            var matching = events.stream().filter(event -> event.path("kind").asText().equals(kind)).toList();
            assertThat(matching).as(kind).hasSize(kind.equals("turn.settled") ? 0 : kind.equals("tool.receipt") ? (applied ? 1 : 0) : 1);
            if (kind.equals("input.accepted")) assertThat(matching.getFirst().path("payload").path("turnId").asText()).isEqualTo(execution.get("turn_id"));
            if (kind.equals("tool.intent") || kind.equals("tool.receipt") && applied) {
                assertThat(matching.getFirst().path("payload").path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
            }
        }
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                && event.path("payload").path("role").asText().equals("tool_result"))).isEmpty();
        var outcomes = resources(id, "managed-tool-outcome");
        assertThat(outcomes).hasSize(applied ? 1 : 0);
        if (applied) {
            JsonNode receipt = events.stream().filter(event -> event.path("kind").asText().equals("tool.receipt"))
                    .findFirst().orElseThrow().path("payload");
            JsonNode outcomeRef = receipt.path("toolOutcomeRef");
            assertThat(outcomeRef.path("resourceId").asText()).isEqualTo(outcomes.getFirst().get("resource_id"));
            assertThat(outcomeRef.path("kind").asText()).isEqualTo("managed-tool-outcome");
            var outcome = JSON.readTree(resource(id, outcomeRef.path("resourceId").asText(),
                    outcomeRef.path("digest").asText(), outcomeRef.path("byteLength").asInt()));
            assertThat(outcome.path("identity").path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
            assertThat(outcome.path("decision").asText()).isEqualTo("committed");
            JsonNode manifestRef = receipt.path("resultRef");
            assertThat(manifestRef.path("kind").asText()).isEqualTo("managed-tool-result-manifest");
            assertThat(outcome.path("envelope").path("capture").path("manifest")).isEqualTo(manifestRef);
            assertThat(receipt.path("resources")).isEqualTo(JSON.createArrayNode().add(manifestRef));
            assertThat(resources(id, "managed-tool-result-manifest").stream().map(row -> row.get("resource_id")))
                    .containsExactly(manifestRef.path("resourceId").asText());
            resource(id, manifestRef.path("resourceId").asText(), manifestRef.path("digest").asText(),
                    manifestRef.path("byteLength").asInt());
        }
        var head = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?", tenant, id);
        assertThat(((Number) head.get("journal_revision")).longValue()).isEqualTo(revision);
        assertThat(((Number) head.get("committed_sequence")).longValue()).isEqualTo(sequence);
        assertThat(head.get("last_commit_digest")).isEqualTo(previous);
        byte[] checkpoint = jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                byte[].class, tenant, id, head.get("latest_checkpoint_resource_id"));
        assertThat(JSON.readTree(checkpoint).path("continuation").path("phase").asText()).isEqualTo("await_runtime");
        if (report == null) return;
        // Cold load reads the journal before recording its own activation and release.
        assertThat(journal.subList(journal.size() - 2, journal.size()).stream().map(row -> row.get("operation")))
                .containsExactly("installActivation", "releaseActivation");
        assertThat(report.path("restoreTransactions").size()).isEqualTo(journal.size() - 2);
        for (int index = 0; index < report.path("restoreTransactions").size(); index++) {
            var restored = report.path("restoreTransactions").get(index);
            var row = journal.get(index);
            assertThat(restored.path("transactionId").asText()).isEqualTo(row.get("transaction_id"));
            assertThat(Base64.getDecoder().decode(restored.path("recordBytesBase64").asText())).isEqualTo((byte[]) row.get("record_bytes"));
            assertThat(restored.path("recordDigest").asText()).isEqualTo(row.get("record_digest"));
        }
        if (session.get("fault").toString().startsWith("receipt-")) {
            var target = report.path("target");
            assertThat(target.path("operation").asText()).isEqualTo("recordToolResult");
            assertThat(target.path("commandId").asText()).isEqualTo(execution.get("execution_call_id"));
            var matching = journal.stream().filter(row -> row.get("transaction_id").equals(target.path("transactionId").asText())).toList();
            assertThat(matching).hasSize(applied ? 1 : 0);
            if (applied) {
                assertThat((byte[]) matching.getFirst().get("record_bytes")).isEqualTo(Base64.getDecoder().decode(target.path("recordBytesBase64").asText()));
                assertThat(report.path("receipt").path("transactionId")).isEqualTo(target.path("transactionId"));
                assertThat(report.path("receipt").path("replayed").asBoolean(true)).isFalse();
            }
        }
    }

    void assertReport(Map<String, Object> session, JsonNode report) throws Exception {
        assertThat(failure.get()).as("independent Shell output probe").isNull();
        assertThat(report.path("fault").asText()).isEqualTo(session.get("fault"));
        assertThat(report.path("injections").asInt())
                .isEqualTo(session.get("fault").toString().startsWith("receipt-") ? 3 : 1);
        assertThat(report.path("modelCalls").asInt()).isEqualTo(1);
        var row = execution(session.get("sessionId").toString());
        assertThat(row.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
        assertThat(row.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
        assertThat(row.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
        assertThat(row.get("turn_id")).isEqualTo(report.path("promptId").asText());
        assertThat(killed.contains(session.get("sessionId").toString())).isEqualTo(session.get("fault").equals("worker-kill"));
        check(session, "finished");
        assertJournal(session, report);
        System.out.println("FG6F_LEDGER " + session.get("fault") + " original=" + row.get("execution_call_id") + " state=UNKNOWN owner=retained");
    }

    private static byte[] prefixBytes() {
        byte[] bytes = new byte[1024 * 1024];
        Arrays.fill(bytes, (byte) 'a');
        return bytes;
    }

    private static byte[] concat(byte[] prefix, String tail) throws Exception {
        var bytes = new ByteArrayOutputStream();
        bytes.write(prefix);
        bytes.write(tail.getBytes(StandardCharsets.UTF_8));
        return bytes.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static boolean running(ProcessHandle process) {
        if (!process.isAlive()) return false;
        Path stat = Path.of("/proc", Long.toString(process.pid()), "stat");
        if (!Files.exists(stat)) return true;
        try {
            String value = Files.readString(stat);
            return value.charAt(value.lastIndexOf(')') + 2) != 'Z';
        } catch (java.io.IOException gone) {
            return process.isAlive();
        }
    }

    @Override
    public void close() throws Exception {
        for (Object value : owned()) capture((Process) ReflectionTestUtils.getField(value, "process"));
        processes.forEach(ProcessHandle::destroyForcibly);
        for (ProcessHandle process : processes) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (running(process)) {
                assertThat(System.nanoTime()).as("Shell worker/descendant cleanup %s", process.pid()).isLessThan(deadline);
                Thread.sleep(20);
            }
        }
    }
}
