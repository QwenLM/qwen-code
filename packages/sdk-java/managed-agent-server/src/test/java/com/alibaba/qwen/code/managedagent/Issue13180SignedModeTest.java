package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
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
                signWith("ffffffffffffffffffffffffffffffff", "GET",
                        "/v1/agents/sessions", TENANT, "actor-a", timestamp));
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
                        createTimestamp), idempotencyKey,
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
    void theInternalSurfaceStaysOnItsWriterCredential() throws Exception {
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
            String actor, String timestamp) throws Exception {
        return signWith(KEY, method, uri, tenant, actor, timestamp);
    }

    private static String signWith(String key, String method, String uri,
            String tenant, String actor, String timestamp) throws Exception {
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + uri
                + "\n" + tenant + "\n" + actor + "\n" + timestamp;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8),
                "HmacSHA256"));
        return "v1=" + HexFormat.of().formatHex(
                mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }
}
