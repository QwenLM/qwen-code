package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * Issue #13180 verification: re-runs the original reproduction's attack
 * scenarios against the hardened configuration (signed auth mode, writer
 * binding key, dedicated internal listener). Every attack must now fail,
 * while the broker-provisioned credential and the recorded creator keep
 * working.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "spring.datasource.url=jdbc:h2:mem:issue-13180-hardened;MODE=MySQL;"
                    + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
            "spring.datasource.driver-class-name=org.h2.Driver",
            "spring.datasource.username=sa",
            "spring.datasource.password=",
            "qwen.managed-agent.harness.enabled=false",
            "qwen.managed-agent.session-store.enabled=true",
            "qwen.managed-agent.session-store.binding-key="
                    + "fedcba9876543210fedcba9876543210",
            "qwen.managed-agent.auth.mode=signed",
            "qwen.managed-agent.auth.signing-key="
                    + "0123456789abcdef0123456789abcdef",
            "qwen.managed-agent.internal-server.address=127.0.0.1"
        })
class Issue13180HardenedVerificationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SIGNING_KEY = "0123456789abcdef0123456789abcdef";
    private static final String WRONG_KEY = "ffffffffffffffffffffffffffffffff";
    private static final String WORKSPACE = "ws-verify";
    private static final String SELF_MINTED =
            "attacker-self-minted-token-0000000000";
    private static int internalPort;

    @LocalServerPort private int publicPort;
    @Autowired private WriterCredentialPolicy credentials;
    @Autowired private JdbcTemplate jdbc;
    private final HttpClient http = HttpClient.newHttpClient();

    @DynamicPropertySource
    static void internalPort(DynamicPropertyRegistry registry)
            throws IOException {
        try (ServerSocket probe = new ServerSocket(0)) {
            internalPort = probe.getLocalPort();
        }
        registry.add("qwen.managed-agent.internal-server.port",
                () -> internalPort);
    }

    /** Gap 1: header-asserted tenant/actor identity must be rejected. */
    @Test
    void gap1HeaderAssertedIdentityIsRejected() throws Exception {
        String tenant = "tenant-g1-" + UUID.randomUUID();
        // Original attack: tenant header only.
        HttpResponse<String> create = raw(publicPort, "POST",
                "/v1/agents/sessions", tenant, null,
                UUID.randomUUID().toString(),
                "{\"agent_id\":\"qwen-code\",\"input\":[]}");
        assertThat(create.statusCode()).as(create.body()).isEqualTo(401);
        assertThat(create.body()).contains("authentication_required");

        // Original attack with the old trusted-actor stand-in header added.
        HttpResponse<String> createWithActor = raw(publicPort, "POST",
                "/v1/agents/sessions", tenant, "attacker",
                UUID.randomUUID().toString(),
                "{\"agent_id\":\"qwen-code\",\"input\":[]}");
        assertThat(createWithActor.statusCode())
                .as(createWithActor.body()).isEqualTo(401);
        assertThat(createWithActor.body()).contains("authentication_required");

        // A signature made with the wrong key must not authenticate.
        String timestamp = now();
        HttpResponse<String> wrongKey = signed(publicPort, "GET",
                "/v1/agents/sessions", tenant, "attacker", timestamp,
                sign(WRONG_KEY, "GET", "/v1/agents/sessions", tenant,
                        "attacker", timestamp, new byte[0], null),
                null, null);
        assertThat(wrongKey.statusCode()).as(wrongKey.body()).isEqualTo(401);
        assertThat(wrongKey.body()).contains("invalid_signature");

        // Control: a correctly signed request still works.
        String t2 = now();
        HttpResponse<String> ok = signed(publicPort, "GET",
                "/v1/agents/sessions", tenant, "attacker", t2,
                sign("GET", "/v1/agents/sessions", tenant, "attacker", t2),
                null, null);
        assertThat(ok.statusCode()).as(ok.body()).isEqualTo(200);
    }

    /** Gap 2: self-minted writer token takeover during a free lease window. */
    @Test
    void gap2WriterTakeoverWithSelfMintedTokenFails() throws Exception {
        String tenant = "tenant-g2-" + UUID.randomUUID();
        String session = createSession(tenant, "victim");
        String token = credentials.issue(tenant, WORKSPACE, session);

        // Victim acquires with the broker-provisioned credential, 1 s lease.
        HttpResponse<String> acquire = acquire(internalPort, tenant, session,
                token, "writer-victim", 1_000);
        assertThat(acquire.statusCode()).as(acquire.body()).isEqualTo(200);
        assertThat(JSON.readTree(acquire.body()).path("writerGeneration")
                .asLong()).isEqualTo(1);

        // Victim commits the genesis transaction.
        HttpResponse<String> genesis = commit(internalPort, tenant, session,
                token, "writer-victim", 1);
        assertThat(genesis.statusCode()).as(genesis.body()).isEqualTo(200);

        // The original attack: wait out the lease window, then take over.
        Thread.sleep(1_500);

        HttpResponse<String> takeover = acquire(internalPort, tenant, session,
                SELF_MINTED, "writer-attacker", 60_000);
        assertThat(takeover.statusCode()).as(takeover.body()).isEqualTo(403);
        assertThat(takeover.body()).contains("writer_credential_invalid");

        // A direct commit with a self-minted token is rejected too.
        HttpResponse<String> forgeCommit = commit(internalPort, tenant,
                session, SELF_MINTED, "writer-attacker", 2);
        assertThat(forgeCommit.statusCode()).as(forgeCommit.body())
                .isEqualTo(403);
        assertThat(forgeCommit.body()).contains("writer_credential_invalid");

        // The internal surface is not signed; a forged tenant header just
        // derives a different expected credential, so the stolen token fails.
        HttpResponse<String> crossTenant = acquire(internalPort,
                "tenant-evil", session, token, "writer-attacker", 60_000);
        assertThat(crossTenant.statusCode()).as(crossTenant.body())
                .isEqualTo(403);
        assertThat(crossTenant.body()).contains("writer_credential_invalid");

        // The provisioned token is scope-bound: another session rejects it.
        String otherSession = createSession(tenant, "victim");
        HttpResponse<String> crossSession = acquire(internalPort, tenant,
                otherSession, token, "writer-attacker", 60_000);
        assertThat(crossSession.statusCode()).as(crossSession.body())
                .isEqualTo(403);
        assertThat(crossSession.body()).contains("writer_credential_invalid");

        // Control: the legitimate harness re-acquires after the lapse.
        HttpResponse<String> reacquire = acquire(internalPort, tenant,
                session, token, "writer-victim-reboot", 60_000);
        assertThat(reacquire.statusCode()).as(reacquire.body()).isEqualTo(200);
        assertThat(JSON.readTree(reacquire.body()).path("writerGeneration")
                .asLong()).isEqualTo(2);
    }

    /** Gap 3: the internal surface must not answer on the public port. */
    @Test
    void gap3InternalSurfaceIsOffThePublicPort() throws Exception {
        String tenant = "tenant-g3-" + UUID.randomUUID();
        String session = createSession(tenant, "owner");
        String token = credentials.issue(tenant, WORKSPACE, session);

        // Original attack: writer mutation on the public port.
        HttpResponse<String> onPublic = acquire(publicPort, tenant, session,
                token, "writer-a", 60_000);
        assertThat(onPublic.statusCode()).as(onPublic.body()).isEqualTo(404);

        // The public API must not answer on the internal port either.
        String timestamp = now();
        HttpResponse<String> onInternal = signed(internalPort, "GET",
                "/v1/agents/sessions", tenant, "owner", timestamp,
                sign("GET", "/v1/agents/sessions", tenant, "owner",
                        timestamp), null, null);
        assertThat(onInternal.statusCode()).as(onInternal.body())
                .isEqualTo(404);

        // Control: each surface works on its own listener.
        HttpResponse<String> okInternal = acquire(internalPort, tenant,
                session, token, "writer-a", 60_000);
        assertThat(okInternal.statusCode()).as(okInternal.body())
                .isEqualTo(200);
    }

    /** Gap 4: a hosted approval answers its recorded creator only. */
    @Test
    void gap4HostedApprovalOwnershipIsEnforced() throws Exception {
        String tenant = "tenant-g4-" + UUID.randomUUID();
        String session = createSession(tenant, "owner");

        // The durable creator record must exist (V40 creator_actor_key).
        byte[] creator = jdbc.queryForObject(
                "SELECT creator_actor_key FROM managed_agent_session WHERE"
                        + " tenant_id = ? AND session_id = ?",
                byte[].class, tenant, session);
        assertThat(creator).as("creator_actor_key recorded").isNotNull();

        String actionId = "tool_approval_"
                + UUID.randomUUID().toString().replace("-", "");
        long nowMillis = System.currentTimeMillis();
        jdbc.update(
                "INSERT INTO managed_agent_action (tenant_id, session_id,"
                        + " action_id, state, options_json, created_at)"
                        + " VALUES (?, ?, ?, 'requested', ?, ?)",
                tenant, session, actionId,
                "{\"v\":1,\"requestId\":\"" + actionId + "\","
                        + "\"turnId\":\"turn-verify\","
                        + "\"functionCallId\":\"call-verify\","
                        + "\"toolName\":\"write_file\","
                        + "\"policyRevision\":\"hosted-tool-approval/1\","
                        + "\"inputRevision\":1,\"createdAt\":" + nowMillis
                        + ",\"expiresAt\":9007199254740991,"
                        + "\"options\":[{\"id\":\"allow\",\"label\":\"Allow\"}"
                        + ",{\"id\":\"deny\",\"label\":\"Deny\"}]}",
                nowMillis);

        String path = "/v1/agents/sessions/" + session + "/actions/"
                + actionId + "/responses";
        String body = "{\"kind\":\"permission\",\"input_revision\":1,"
                + "\"policy_revision\":\"hosted-tool-approval/1\","
                + "\"option_id\":\"allow\"}";

        // Original attack: no principal at all.
        HttpResponse<String> anonymous = raw(publicPort, "POST", path, tenant,
                null, "anon-" + UUID.randomUUID(), body);
        assertThat(anonymous.statusCode()).as(anonymous.body()).isEqualTo(401);

        // Original attack: a different, guessable actor identity.
        String intruderTimestamp = now();
        String intruderKey = "intruder-" + UUID.randomUUID();
        HttpResponse<String> intruder = signed(publicPort, "POST", path,
                tenant, "intruder", intruderTimestamp,
                sign("POST", path, tenant, "intruder", intruderTimestamp,
                        body, intruderKey),
                intruderKey, body);
        assertThat(intruder.statusCode()).as(intruder.body()).isEqualTo(403);
        assertThat(intruder.body()).contains("action_forbidden");

        // Fixed behavior: the recorded creator's answer is accepted.
        String ownerTimestamp = now();
        String ownerKey = "owner-" + UUID.randomUUID();
        HttpResponse<String> owner = signed(publicPort, "POST", path, tenant,
                "owner", ownerTimestamp,
                sign("POST", path, tenant, "owner", ownerTimestamp, body,
                        ownerKey),
                ownerKey, body);
        assertThat(owner.statusCode()).as(owner.body()).isEqualTo(202);
        JsonNode operation = JSON.readTree(owner.body());
        assertThat(operation.path("id").asText()).startsWith("op_");
    }

    private String createSession(String tenant, String actor)
            throws Exception {
        String timestamp = now();
        String idempotencyKey = UUID.randomUUID().toString();
        String createBody = "{\"agent_id\":\"qwen-code\",\"input\":[]}";
        HttpResponse<String> created = signed(publicPort, "POST",
                "/v1/agents/sessions", tenant, actor, timestamp,
                sign("POST", "/v1/agents/sessions", tenant, actor, timestamp,
                        createBody, idempotencyKey),
                idempotencyKey, createBody);
        assertThat(created.statusCode()).as(created.body()).isEqualTo(202);
        return JSON.readTree(created.body()).path("id").asText();
    }

    private HttpResponse<String> acquire(int port, String tenant,
            String session, String token, String writer, long leaseMillis)
            throws Exception {
        return internal(port, "POST",
                "/internal/managed-session-store/v1/sessions/" + session
                        + "/writers:acquire",
                tenant, token,
                "{\"workspaceId\":\"" + WORKSPACE + "\",\"writerId\":\""
                        + writer + "\",\"leaseMillis\":" + leaseMillis + "}");
    }

    private HttpResponse<String> commit(int port, String tenant,
            String session, String token, String writer, long generation)
            throws Exception {
        String records = "{\"subtype\":\"session_execution_engine\"}\n"
                + "{\"subtype\":\"managed_session_header_v1\"}\n";
        String base64 = Base64.getEncoder().encodeToString(
                records.getBytes(StandardCharsets.UTF_8));
        String transactionId = "transaction-genesis-" + generation;
        String body = "{\"workspaceId\":\"" + WORKSPACE + "\",\"writerId\":\""
                + writer + "\",\"writerGeneration\":" + generation
                + ",\"expectedJournalRevision\":" + (generation - 1)
                + ",\"expectedCommittedSequence\":0,\"transactionId\":\""
                + transactionId + "\",\"operation\":\"session.create\","
                + "\"commandId\":\"command-genesis\",\"contentDigest\":\""
                + sha256("genesis") + "\",\"firstSequence\":0,"
                + "\"lastSequence\":0,\"eventCount\":0,\"activationEpoch\":0,"
                + "\"recordCount\":2,\"recordBytesBase64\":\"" + base64
                + "\",\"recordDigest\":\"" + sha256(records)
                + "\",\"resources\":[]}";
        return internal(port, "POST",
                "/internal/managed-session-store/v1/sessions/" + session
                        + "/transactions:commit",
                tenant, token, body);
    }

    private HttpResponse<String> internal(int port, String method,
            String path, String tenant, String token, String body)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + path))
                .header("X-Qwen-Tenant-Id", tenant)
                .header("X-Qwen-Managed-Writer-Token", token)
                .header("Content-Type", "application/json")
                .method(method, HttpRequest.BodyPublishers.ofString(body));
        return http.send(request.build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> raw(int port, String method, String path,
            String tenant, String actor, String idempotencyKey, String body)
            throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + path))
                .header("X-Qwen-Tenant-Id", tenant);
        if (actor != null) {
            request.header("X-Qwen-Actor-Id", actor);
        }
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

    private HttpResponse<String> signed(int port, String method, String path,
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
        return BrokerSignatures.sign(SIGNING_KEY, method, uri, tenant, actor,
                timestamp);
    }

    private static String sign(String method, String uri, String tenant,
            String actor, String timestamp, String body,
            String idempotencyKey) {
        return BrokerSignatures.sign(SIGNING_KEY, method, uri, null, tenant,
                actor, timestamp, body == null ? new byte[0]
                        : body.getBytes(StandardCharsets.UTF_8),
                idempotencyKey);
    }

    private static String sign(String key, String method, String uri,
            String tenant, String actor, String timestamp, byte[] body,
            String idempotencyKey) {
        return BrokerSignatures.sign(key, method, uri, null, tenant, actor,
                timestamp, body, idempotencyKey);
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
