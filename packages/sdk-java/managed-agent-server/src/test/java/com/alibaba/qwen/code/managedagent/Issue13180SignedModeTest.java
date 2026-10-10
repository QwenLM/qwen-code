package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Issue #13180, gap 1, fixed form: in signed mode the broker authenticates
 * the tenant/actor header pair itself. An unsigned request is answered 401;
 * a signed request installs the principal and drives tenant scoping. The
 * internal surface stays outside the signature scheme and keeps its own
 * credential check.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "spring.datasource.url=jdbc:h2:mem:issue-13180-signed;MODE=MySQL;"
                    + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
            "spring.datasource.driver-class-name=org.h2.Driver",
            "spring.datasource.username=sa",
            "spring.datasource.password=",
            "qwen.managed-agent.harness.enabled=false",
            "qwen.managed-agent.session-store.enabled=true",
            "qwen.managed-agent.auth.mode=signed",
            "qwen.managed-agent.auth.signing-key=0123456789abcdef0123456789abcdef"
        })
class Issue13180SignedModeTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String KEY = "0123456789abcdef0123456789abcdef";
    private static final String TENANT = "tenant-signed";
    private static final String DEFINITION_BODY = "{\"model\":{},"
            + "\"instructions\":\"test\",\"tools\":[],"
            + "\"permission_policy\":{}}";

    @LocalServerPort private int port;
    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    void unsignedPublicTrafficIsRejected() throws Exception {
        HttpResponse<String> created = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create(
                                "http://127.0.0.1:" + port
                                        + "/v1/agents/sessions"))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .POST(HttpRequest.BodyPublishers.ofString(
                                "{\"agent_id\":\"qwen-code\",\"input\":[]}"))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(created.statusCode()).as(created.body()).isEqualTo(401);
        assertThat(created.body()).contains("authentication_required");

        String timestamp = now();
        HttpResponse<String> wrongKey = call("GET", "/v1/agents/sessions",
                TENANT, "actor-a", timestamp,
                BrokerSignatures.sign("ffffffffffffffffffffffffffffffff",
                        "GET", "/v1/agents/sessions", TENANT, "actor-a",
                        timestamp));
        assertThat(wrongKey.statusCode()).as(wrongKey.body()).isEqualTo(401);
        assertThat(wrongKey.body()).contains("invalid_signature");
    }

    @Test
    void signedTrafficCreatesAndReadsBackWithinTheSignedTenant()
            throws Exception {
        String idempotencyKey = UUID.randomUUID().toString();
        String createTimestamp = now();
        HttpResponse<String> created = call("POST", "/v1/agents/sessions",
                TENANT, "actor-a", createTimestamp,
                sign("POST", "/v1/agents/sessions", TENANT, "actor-a",
                        createTimestamp,
                        "{\"agent_id\":\"qwen-code\",\"input\":[]}"
                                .getBytes(StandardCharsets.UTF_8),
                        idempotencyKey), idempotencyKey,
                "{\"agent_id\":\"qwen-code\",\"input\":[]}");
        assertThat(created.statusCode()).as(created.body()).isEqualTo(202);
        String session = JSON.readTree(created.body()).path("id").asText();
        assertThat(session).isNotBlank();

        String readTimestamp = now();
        HttpResponse<String> read = call("GET",
                "/v1/agents/sessions/" + session, TENANT, "actor-a",
                readTimestamp,
                sign("GET", "/v1/agents/sessions/" + session, TENANT,
                        "actor-a", readTimestamp));
        assertThat(read.statusCode()).as(read.body()).isEqualTo(200);
        assertThat(read.body()).contains(session);

        // A signature over another tenant does not unlock the session.
        String foreignTimestamp = now();
        HttpResponse<String> foreign = call("GET",
                "/v1/agents/sessions/" + session, "tenant-other", "actor-a",
                foreignTimestamp,
                sign("GET", "/v1/agents/sessions/" + session, "tenant-other",
                        "actor-a", foreignTimestamp));
        assertThat(foreign.statusCode()).as(foreign.body()).isEqualTo(404);
    }

    @Test
    void theInternalSurfaceNeedsNoSignature() throws Exception {
        String timestamp = now();
        ObjectNode body = JSON.createObjectNode()
                .put("workspaceId", "ws-signed")
                .put("writerId", "writer-signed")
                .put("leaseMillis", 60_000);
        HttpResponse<String> acquire = http.send(
                HttpRequest.newBuilder(URI.create(
                                "http://127.0.0.1:" + port
                                        + "/internal/managed-session-store/v1/sessions/session-signed/writers:acquire"))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("X-Qwen-Managed-Writer-Token",
                                "self-minted-token-self-minted-token-0")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                body.toString()))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        // No signature headers: the signature filter does not cover the
        // internal surface, and the unbound store still accepts the token.
        assertThat(acquire.statusCode()).as(acquire.body()).isEqualTo(200);
    }

    /** Signed-mode hosted create replays under the recorded actor. */
    @Test
    void signedHostedCreateReplaysUnderTheSameActor() throws Exception {
        byte[] createBody = "{\"agent_id\":\"qwen-code\",\"input\":[]}"
                .getBytes(StandardCharsets.UTF_8);
        String idempotencyKey = UUID.randomUUID().toString();
        String firstTimestamp = now();
        HttpResponse<String> first = call("POST", "/v1/agents/sessions",
                TENANT, "actor-a", firstTimestamp,
                sign("POST", "/v1/agents/sessions", TENANT, "actor-a",
                        firstTimestamp, createBody, idempotencyKey),
                idempotencyKey, new String(createBody,
                        StandardCharsets.UTF_8));
        assertThat(first.statusCode()).as(first.body()).isEqualTo(202);
        String session = JSON.readTree(first.body()).path("id").asText();
        assertThat(session).isNotBlank();

        String secondTimestamp = now();
        HttpResponse<String> second = call("POST", "/v1/agents/sessions",
                TENANT, "actor-a", secondTimestamp,
                sign("POST", "/v1/agents/sessions", TENANT, "actor-a",
                        secondTimestamp, createBody, idempotencyKey),
                idempotencyKey, new String(createBody,
                        StandardCharsets.UTF_8));
        assertThat(second.statusCode()).as(second.body()).isEqualTo(202);
        String replayed = JSON.readTree(second.body()).path("id").asText();
        assertThat(replayed).isNotBlank();
        assertThat(replayed).isEqualTo(session);
        assertThat(second.headers().firstValue("X-Qwen-Idempotent-Replay"))
                .hasValue("true");
    }

    /**
     * Issue #13180 review R6-1: the signature binds the raw body bytes but
     * not the Content-Type charset, while Spring's Jackson converter decodes
     * a non-Unicode charset through that parameter. The broker must decode
     * signed JSON as UTF-8 regardless of the declared charset, so a relayed
     * request persists the same content its signer wrote. The content digest
     * and the idempotency record are both computed over the decoded content,
     * so a charset-switched decode is observable through either.
     */
    @Test
    void signedJsonDecodesAsUtf8RegardlessOfTheDeclaredCharset()
            throws Exception {
        byte[] body = ("{\"model\":{},\"instructions\":\"café\","
                + "\"tools\":[],\"permission_policy\":{}}")
                .getBytes(StandardCharsets.UTF_8);
        String idempotencyKey = UUID.randomUUID().toString();
        String timestamp = now();
        HttpResponse<String> created = http.send(
                HttpRequest.newBuilder(URI.create(
                                "http://127.0.0.1:" + port + "/v1/agents"))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("X-Qwen-Actor-Id", "actor-a")
                        .header("X-Qwen-Signature-Timestamp", timestamp)
                        .header("X-Qwen-Signature",
                                sign("POST", "/v1/agents", TENANT, "actor-a",
                                        timestamp, body, idempotencyKey))
                        .header("Idempotency-Key", idempotencyKey)
                        .header("Content-Type",
                                "application/json; charset=ISO-8859-1")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(created.statusCode()).as(created.body()).isEqualTo(202);
        String attackDigest = JSON.readTree(created.body()).path("digest")
                .asText();
        assertThat(attackDigest).isNotBlank();

        // The identical signed bytes with a UTF-8 declaration must be an
        // idempotent replay of the same content, never a conflict.
        String replayTimestamp = now();
        HttpResponse<String> replay = http.send(
                HttpRequest.newBuilder(URI.create(
                                "http://127.0.0.1:" + port + "/v1/agents"))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("X-Qwen-Actor-Id", "actor-a")
                        .header("X-Qwen-Signature-Timestamp", replayTimestamp)
                        .header("X-Qwen-Signature",
                                sign("POST", "/v1/agents", TENANT, "actor-a",
                                        replayTimestamp, body,
                                        idempotencyKey))
                        .header("Idempotency-Key", idempotencyKey)
                        .header("Content-Type",
                                "application/json; charset=UTF-8")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(replay.statusCode()).as(replay.body()).isEqualTo(202);
        assertThat(replay.headers().firstValue("X-Qwen-Idempotent-Replay"))
                .hasValue("true");

        // A fresh UTF-8 control persists the identical content digest.
        String controlKey = UUID.randomUUID().toString();
        String controlTimestamp = now();
        HttpResponse<String> control = call("POST", "/v1/agents", TENANT,
                "actor-a", controlTimestamp,
                sign("POST", "/v1/agents", TENANT, "actor-a",
                        controlTimestamp, body, controlKey),
                controlKey, new String(body, StandardCharsets.UTF_8));
        assertThat(control.statusCode()).as(control.body()).isEqualTo(202);
        assertThat(JSON.readTree(control.body()).path("digest").asText())
                .isEqualTo(attackDigest);
    }

    /** The bare collection route and its normalized spellings are covered. */
    @Test
    void theBareCollectionRouteRequiresASignature() throws Exception {
        for (String path : new String[] {"/v1/agents", "/v1/%61gents",
                "/v1/agents;jsessionid=abc"}) {
            HttpResponse<String> unsigned = http.send(
                    HttpRequest.newBuilder(URI.create(
                                    "http://127.0.0.1:" + port + path))
                            .header("X-Qwen-Tenant-Id", TENANT)
                            .header("Idempotency-Key",
                                    UUID.randomUUID().toString())
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(
                                    DEFINITION_BODY))
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            assertThat(unsigned.statusCode()).as(path + ": " + unsigned.body())
                    .isEqualTo(401);
            assertThat(unsigned.body()).contains("authentication_required");
        }

        byte[] body = DEFINITION_BODY.getBytes(StandardCharsets.UTF_8);
        String idempotencyKey = UUID.randomUUID().toString();
        String timestamp = now();
        HttpResponse<String> signed = call("POST", "/v1/agents", TENANT,
                "actor-a", timestamp,
                sign("POST", "/v1/agents", TENANT, "actor-a", timestamp, body,
                        idempotencyKey),
                idempotencyKey, DEFINITION_BODY);
        assertThat(signed.statusCode()).as(signed.body()).isEqualTo(202);
    }

    private HttpResponse<String> call(String method, String path,
            String tenant, String actor, String timestamp, String signature)
            throws Exception {
        return call(method, path, tenant, actor, timestamp, signature, null,
                null);
    }

    private HttpResponse<String> call(String method, String path,
            String tenant, String actor, String timestamp, String signature,
            String idempotencyKey, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + path))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("X-Qwen-Actor-Id", actor)
                .header("X-Qwen-Signature-Timestamp", timestamp)
                .header("X-Qwen-Signature", signature);
        if (idempotencyKey != null) {
            request.header("Idempotency-Key", idempotencyKey);
        }
        if (body == null) {
            request.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            request.header("Content-Type", "application/json")
                    .method(method, HttpRequest.BodyPublishers.ofString(body));
        }
        return http.send(request.build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private static String now() {
        return Long.toString(System.currentTimeMillis() / 1000L);
    }

    private static String sign(String method, String uri, String tenant,
            String actor, String timestamp) {
        return BrokerSignatures.sign(KEY, method, uri, tenant, actor,
                timestamp);
    }

    private static String sign(String method, String uri, String tenant,
            String actor, String timestamp, byte[] body,
            String idempotencyKey) {
        return BrokerSignatures.sign(KEY, method, uri, null, tenant, actor,
                timestamp, body, idempotencyKey);
    }
}
