package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;

/**
 * Issue #13180, gaps 2+3, fixed form: the internal surface listens on its own
 * loopback connector and answers 404 for the wrong surface on either port,
 * while the writer credential is broker-provisioned - a self-minted token
 * cannot acquire a Session even during a free lease window.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "spring.datasource.url=jdbc:h2:mem:issue-13180-ports;MODE=MySQL;"
                    + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
            "spring.datasource.driver-class-name=org.h2.Driver",
            "spring.datasource.username=sa",
            "spring.datasource.password=",
            "qwen.managed-agent.harness.enabled=false",
            "qwen.managed-agent.session-store.enabled=true",
            "qwen.managed-agent.session-store.binding-key=0123456789abcdef0123456789abcdef",
            "qwen.managed-agent.internal-server.address=127.0.0.1"
        })
class Issue13180InternalPortTest {
    private static final String TENANT = "tenant-ports";
    private static final String WORKSPACE = "ws-ports";
    private static int internalPort;

    @LocalServerPort private int publicPort;
    @Autowired private WriterCredentialPolicy credentials;
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

    @Test
    void eachSurfaceAnswersOnlyOnItsOwnListener() throws Exception {
        String session = "session-" + UUID.randomUUID();
        String acquire = "/internal/managed-session-store/v1/sessions/"
                + session + "/writers:acquire";
        String token = credentials.issue(TENANT, WORKSPACE, session);
        String body = "{\"workspaceId\":\"" + WORKSPACE
                + "\",\"writerId\":\"writer-a\",\"leaseMillis\":60000}";

        assertThat(call(publicPort, acquire, token, body).statusCode())
                .isEqualTo(404);
        assertThat(call(internalPort, "/v1/agents/sessions", null, null)
                .statusCode()).isEqualTo(404);

        HttpResponse<String> acquired = call(internalPort, acquire, token,
                body);
        assertThat(acquired.statusCode()).as(acquired.body()).isEqualTo(200);

        HttpResponse<String> selfMinted = call(internalPort,
                "/internal/managed-session-store/v1/sessions/"
                        + UUID.randomUUID() + "/writers:acquire",
                "self-minted-token-self-minted-token-0", body);
        assertThat(selfMinted.statusCode()).as(selfMinted.body())
                .isEqualTo(403);
        assertThat(selfMinted.body()).contains("writer_credential_invalid");

        HttpResponse<String> publicApi = call(publicPort,
                "/v1/agents/sessions", null, null);
        assertThat(publicApi.statusCode()).as(publicApi.body()).isEqualTo(200);

        // The charset in Content-Type must not give the surface classifier a
        // different view than the router's fixed UTF-8 decoding.
        String encodedAcquire = "/%69%6Eternal/managed-session-store/v1/sessions/"
                + session + "/writers:acquire";
        HttpResponse<String> charsetProbe = http.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                                + publicPort + encodedAcquire))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("X-Qwen-Managed-Writer-Token", token)
                        .header("Content-Type",
                                "application/json; charset=UTF-16")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(charsetProbe.statusCode()).as(charsetProbe.body())
                .isEqualTo(404);
        HttpResponse<String> charsetInternal = http.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                                + internalPort + encodedAcquire))
                        .header("X-Qwen-Tenant-Id", TENANT)
                        .header("X-Qwen-Managed-Writer-Token", token)
                        .header("Content-Type",
                                "application/json; charset=UTF-16")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(charsetInternal.statusCode()).as(charsetInternal.body())
                .isEqualTo(200);
    }

    private HttpResponse<String> call(int port, String path, String token,
            String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(
                        URI.create("http://127.0.0.1:" + port + path))
                .header("X-Qwen-Tenant-Id", TENANT);
        if (token != null) {
            request.header("X-Qwen-Managed-Writer-Token", token);
        }
        if (body == null) {
            request.GET();
        } else {
            request.header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body));
        }
        return http.send(request.build(),
                HttpResponse.BodyHandlers.ofString());
    }
}
