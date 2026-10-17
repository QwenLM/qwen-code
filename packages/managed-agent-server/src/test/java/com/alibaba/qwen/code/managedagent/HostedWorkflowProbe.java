package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.service.ChildResultRelay;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

// FG10 (issue #14165): the gate-side half of the workflow child_run fault
// gates. `state` answers the JDBC ground truth the driver sequences on;
// `tamper-envelope` rewrites the pinned launch envelope's script bytes
// after the child_run record committed and before the relay may read them
// (FG10a runs with the relay scan held at 3600 s, so this endpoint is the
// only walk the row ever gets); `relay-drive` then steps the relay until
// the record settles. No SSE relay here — the letter gates no stream.
final class HostedWorkflowProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final ChildResultRelay relay;
    private volatile Throwable failure;

    HostedWorkflowProbe(JdbcTemplate jdbc, String tenant,
            ChildResultRelay relay, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.relay = relay;
        server.createContext("/fg10/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath()
                        .split("/");
                assertThat(route).hasSize(4);
                String sessionId = route[2];
                Object response = switch (route[3]) {
                    case "state" -> state(sessionId);
                    case "tamper-envelope" -> tamperEnvelope(sessionId,
                            JSON.readTree(exchange.getRequestBody()));
                    case "relay-create" -> relayCreate(sessionId);
                    case "child-turn-output" -> childTurnOutput(sessionId);
                    default -> throw new IllegalArgumentException(route[3]);
                };
                byte[] bytes = JSON.writeValueAsBytes(response);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (Throwable error) {
                failure = error;
                byte[] bytes = error.toString().getBytes(
                        StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, bytes.length);
                exchange.getResponseBody().write(bytes);
            } finally {
                exchange.close();
            }
        });
    }

    private Map<String, Object> state(String sessionId) {
        return Map.of(
                "childRuns", HostedGateTestSupport.extensionRecords(jdbc,
                        tenant, sessionId, "child_run"),
                "operations", jdbc.queryForList(
                        "SELECT * FROM ma_operation WHERE tenant_id = ?"
                                + " AND operation_kind IN"
                                + " ('CHILD_SESSION_START',"
                                + " 'CHILD_SESSION_CLOSE')", tenant),
                "sessions", jdbc.queryForList(
                        "SELECT session_id, parent_session_id, status FROM"
                                + " ma_session WHERE tenant_id = ?",
                        tenant),
                "turns", jdbc.queryForList(
                        "SELECT session_id, turn_id, status FROM ma_turn"
                                + " WHERE tenant_id = ?", tenant));
    }

    // The FG10a injection: the envelope's script bytes change while its
    // pinned definitionDigest does not. The rewrite keeps the script's
    // byte length equal — nothing but the digest can catch it — and keeps
    // the resource row self-consistent (sha256 and byte_length track the
    // new bytes), so the only thing that refuses it is the launch's own
    // re-verification.
    private Map<String, Object> tamperEnvelope(String sessionId,
            JsonNode request) throws Exception {
        boolean substitute = "substitute".equals(request.path("mode")
                .asText());
        var rows = jdbc.queryForList(
                "SELECT record_id, record_resource_id FROM"
                        + " ma_session_record WHERE tenant_id = ?"
                        + " AND session_id = ? AND domain = 'child_run'",
                tenant, sessionId);
        assertThat(rows).as("one child_run record").hasSize(1);
        String recordId = rows.getFirst().get("record_id").toString();
        // The tamper must land before the relay's first read, or the gate
        // passes vacuously: the letter holds the relay scan at 3600 s, so
        // no ledger row may exist yet.
        Integer claimed = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ?"
                        + " AND operation_kind = 'CHILD_SESSION_START'"
                        + " AND operation_id = ?", Integer.class, tenant,
                recordId);
        assertThat(claimed)
                .as("the relay never read the envelope before the tamper")
                .isZero();
        JsonNode record = HostedGateTestSupport.extensionRecords(jdbc,
                tenant, sessionId, "child_run").getFirst();
        // The record's inputRef carries its own digest of the envelope,
        // left stale here on purpose: the tamper simulates the stored
        // bytes diverging from every pin, and the launch's definition
        // digest is the one the gate needs to see catch it.
        String resourceId = record.required("inputRef")
                .required("resourceId").asText();
        var envelopeRows = jdbc.queryForList(
                "SELECT CONVERT(inline_bytes USING utf8mb4) AS body FROM"
                        + " ma_resource WHERE tenant_id = ? AND session_id"
                        + " = ? AND resource_id = ?", tenant, sessionId,
                resourceId);
        assertThat(envelopeRows).as("the launch envelope").hasSize(1);
        ObjectNode envelope = (ObjectNode) JSON.readTree(
                envelopeRows.getFirst().get("body").toString());
        String script = envelope.required("script").asText();
        String rewritten;
        if (substitute) {
            // A wholesale same-length substitution with a syntactically
            // valid, runnable script the driver authors — the letter's
            // substitute-script-baseline case proves it runs to
            // completion under a matching digest, so the refusal here is
            // attributable to the digest alone, never to a parse error.
            rewritten = request.required("script").asText();
        } else {
            // A single-byte corruption inside the sentinel.
            StringBuilder flipped = new StringBuilder(script.length());
            for (int index = 0; index < script.length(); index++) {
                char c = script.charAt(index);
                flipped.append(c == 'O' && script.startsWith(
                        "FG10_SHOULD_NEVER_RUN", index - "FG10_SH".length())
                        ? '0' : c);
            }
            rewritten = flipped.toString();
        }
        assertThat(rewritten.getBytes(StandardCharsets.UTF_8))
                .as("the tamper preserves the script's byte length")
                .hasSize(script.getBytes(StandardCharsets.UTF_8).length);
        assertThat(rewritten)
                .as("the tamper actually changed the script")
                .isNotEqualTo(script);
        envelope.put("script", rewritten);
        byte[] bytes = JSON.writeValueAsBytes(envelope);
        String shaAfter = java.util.HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(bytes));
        int updated = jdbc.update(
                "UPDATE ma_resource SET inline_bytes = ?, byte_length = ?,"
                        + " sha256 = ? WHERE tenant_id = ? AND session_id"
                        + " = ? AND resource_id = ?", bytes, bytes.length,
                shaAfter, tenant, sessionId, resourceId);
        assertThat(updated).as("the envelope row updated").isEqualTo(1);
        var reread = jdbc.queryForList(
                "SELECT sha256, byte_length FROM ma_resource WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " resource_id = ?", tenant, sessionId, resourceId);
        assertThat(reread.getFirst().get("sha256").toString())
                .as("the tamper landed").isEqualTo(shaAfter);
        return Map.of("resourceId", resourceId, "childRunId", recordId,
                "shaBefore", sha256Hex(script.getBytes(
                        StandardCharsets.UTF_8)),
                "shaAfter", shaAfter,
                "pinnedDigest", envelope.required("definition")
                        .required("definitionDigest").asText());
    }

    // FG10a drives exactly ONE relay scan: it fires the create (reading the
    // — possibly tampered — envelope) and dispatches the child's first
    // Turn. Never a second scan: bind() would drive an operation on the
    // driver-held parent and wedge on its attach. The letter holds the
    // scheduled scan at 3600 s, so this single call is the row's only walk.
    private Map<String, Object> relayCreate(String sessionId)
            throws Exception {
        relay.scan();
        // The create is synchronous up to the child Session's own row:
        // after one scan a session naming this parent must exist, or the
        // drive failed. (The record's childSessionId is set later, at the
        // acceptance — not the observable to wait on here.)
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            var children = jdbc.queryForList(
                    "SELECT session_id FROM ma_session WHERE tenant_id = ?"
                            + " AND parent_session_id = ?", tenant,
                    sessionId);
            if (!children.isEmpty()) {
                return Map.of("childSessionId",
                        children.getFirst().get("session_id").toString());
            }
            Thread.sleep(250);
        }
        throw new IllegalStateException(
                "the relay's single scan never created the child session");
    }

    // The child Turn's final content: the workflow executor commits it as
    // the child session journal's assistant message (model == "workflow").
    // FG10a's positive and baseline cases assert the script's own return
    // value made it back out — the fractional args' exact ECMAScript
    // rendering, and the substitute script's sentinel.
    private Map<String, Object> childTurnOutput(String sessionId)
            throws Exception {
        var children = jdbc.queryForList(
                "SELECT session_id FROM ma_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?", tenant, sessionId);
        assertThat(children).as("the child session").hasSize(1);
        String child = children.getFirst().get("session_id").toString();
        var bodies = jdbc.queryForList(
                "SELECT CONVERT(inline_bytes USING utf8mb4) AS body FROM"
                        + " ma_resource WHERE tenant_id = ? AND session_id"
                        + " = ?", tenant, child);
        List<String> texts = new java.util.ArrayList<>();
        for (var row : bodies) {
            JsonNode body = JSON.readTree(row.get("body").toString());
            if (!"assistant".equals(body.path("type").asText())
                    || !"workflow".equals(body.path("model").asText())) {
                continue;
            }
            for (JsonNode part : body.required("message")
                    .required("parts")) {
                if (part.hasNonNull("text")) {
                    texts.add(part.required("text").asText());
                }
            }
        }
        assertThat(texts).as("the child Turn's workflow output message")
                .hasSize(1);
        return Map.of("text", texts.getFirst());
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    @Override
    public void close() {
        if (failure != null) {
            throw new IllegalStateException("FG10 probe failure", failure);
        }
    }
}
