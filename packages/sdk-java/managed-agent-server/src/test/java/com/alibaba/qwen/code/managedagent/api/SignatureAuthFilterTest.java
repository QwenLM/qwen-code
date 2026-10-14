package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcProperties;
import org.springframework.core.Ordered;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class SignatureAuthFilterTest {
    private static final String KEY =
            "0123456789abcdef0123456789abcdef";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void staysOutOfOpenModeAndRunsBeforeTheHeaderStandIn() throws Exception {
        SignatureAuthFilter filter = filter(open());
        MockHttpServletRequest request = request("GET",
                "/v1/agents/sessions");
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, response, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNull();
        assertThat(filter.getOrder())
                .isEqualTo(Ordered.HIGHEST_PRECEDENCE + 10);
    }

    @Test
    void acceptsAValidSignatureAndInstallsThePrincipal() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();
        MockHttpServletRequest request = request("POST",
                "/v1/agents/sessions");
        request.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        request.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        request.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/agents/sessions", "tenant-a", "actor-a",
                        timestamp));
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, response, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isInstanceOfSatisfying(
                        AuthenticatedTenantActor.class, actor -> {
                            assertThat(actor.tenantId()).isEqualTo("tenant-a");
                            assertThat(actor.actorId()).isEqualTo("actor-a");
                        });
    }

    @Test
    void rejectsMissingAndWrongSignatures() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();

        MockHttpServletResponse missing = new MockHttpServletResponse();
        MockHttpServletRequest unsigned = request("GET",
                "/v1/agents/sessions");
        filter.doFilter(unsigned, missing, new MockFilterChain());
        assertThat(missing.getStatus()).isEqualTo(401);
        assertThat(missing.getContentAsString())
                .contains("authentication_required");

        MockHttpServletResponse wrong = new MockHttpServletResponse();
        MockHttpServletRequest forged = request("GET",
                "/v1/agents/sessions");
        forged.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        forged.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        forged.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("GET", "/v1/agents/sessions", "tenant-a", "attacker",
                        timestamp));
        filter.doFilter(forged, wrong, new MockFilterChain());
        assertThat(wrong.getStatus()).isEqualTo(401);
        assertThat(wrong.getContentAsString()).contains("invalid_signature");

        MockHttpServletResponse stale = new MockHttpServletResponse();
        MockHttpServletRequest old = request("GET", "/v1/agents/sessions");
        String oldTimestamp = Long.toString(
                System.currentTimeMillis() / 1000L - 3600);
        old.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        old.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, oldTimestamp);
        old.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("GET", "/v1/agents/sessions", "tenant-a", "actor-a",
                        oldTimestamp));
        filter.doFilter(old, stale, new MockFilterChain());
        assertThat(stale.getStatus()).isEqualTo(401);
        assertThat(stale.getContentAsString()).contains("invalid_signature");
    }

    @Test
    void doesNotCoverTheInternalSurfaceAndIgnoresAMissingTenant()
            throws Exception {
        SignatureAuthFilter filter = filter(signed());
        MockHttpServletRequest internal = new MockHttpServletRequest("POST",
                "/internal/managed-session-store/v1/sessions/s/writers:acquire");
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(internal, new MockHttpServletResponse(), chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNull();

        MockHttpServletRequest noTenant = new MockHttpServletRequest("GET",
                "/v1/agents/sessions");
        MockFilterChain second = new MockFilterChain();
        filter.doFilter(noTenant, new MockHttpServletResponse(), second);
        assertThat(((HttpServletRequest) second.getRequest())
                .getUserPrincipal()).isNull();
    }

    @Test
    void rejectsAnUnparsableTimestamp() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        MockHttpServletRequest request = request("GET",
                "/v1/agents/sessions");
        request.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        request.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, "not-a-number");
        request.addHeader(SignatureAuthFilter.SIGNATURE_HEADER, "v1=" + "0".repeat(64));
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(response.getContentAsString())
                .contains("invalid_signature");
    }

    @Test
    void coversBodyQueryAndIdempotencyKey() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        byte[] body = "{\"agent_id\":\"qwen-code\"}"
                .getBytes(StandardCharsets.UTF_8);
        String timestamp = now();
        String signed = sign("POST", "/v1/agents/sessions", "tenant-a",
                "actor-a", timestamp, body, "key-1");

        MockHttpServletRequest good = request("POST", "/v1/agents/sessions");
        good.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        good.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        good.addHeader(SignatureAuthFilter.SIGNATURE_HEADER, signed);
        good.addHeader(SignatureAuthFilter.IDEMPOTENCY_HEADER, "key-1");
        good.setContent(body);
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(good, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();

        // The same signature over a substituted body is a different request.
        MockHttpServletRequest swapped = request("POST",
                "/v1/agents/sessions");
        swapped.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        swapped.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        swapped.addHeader(SignatureAuthFilter.SIGNATURE_HEADER, signed);
        swapped.addHeader(SignatureAuthFilter.IDEMPOTENCY_HEADER, "key-1");
        swapped.setContent("{\"agent_id\":\"other\"}"
                .getBytes(StandardCharsets.UTF_8));
        MockHttpServletResponse denied = new MockHttpServletResponse();
        filter.doFilter(swapped, denied, new MockFilterChain());
        assertThat(denied.getStatus()).isEqualTo(401);
    }

    @Test
    void honorsTheConfiguredDriftWindow() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        properties.getAuth().setAllowedDrift(Duration.ofSeconds(1));
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        SignatureAuthFilter filter = filter(
                new BrokerSecurity(properties, server, new WebMvcProperties()));

        // Two seconds old: inside the default 5m, outside the 1s window.
        String timestamp = Long.toString(
                System.currentTimeMillis() / 1000L - 2);
        MockHttpServletRequest request = request("GET",
                "/v1/agents/sessions");
        request.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        request.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        request.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("GET", "/v1/agents/sessions", "tenant-a", "actor-a",
                        timestamp));
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(response.getContentAsString()).contains("drift");
    }

    @Test
    void coversTheWebShellSurface() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        MockHttpServletResponse unsigned = new MockHttpServletResponse();
        filter.doFilter(request("POST",
                "/api/agent/web-shell/v1/sessions/query"), unsigned,
                new MockFilterChain());
        assertThat(unsigned.getStatus()).isEqualTo(401);

        String timestamp = now();
        MockHttpServletRequest signedRequest = request("POST",
                "/api/agent/web-shell/v1/sessions/query");
        signedRequest.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        signedRequest.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER,
                timestamp);
        signedRequest.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/api/agent/web-shell/v1/sessions/query",
                        "tenant-a", "actor-a", timestamp));
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(signedRequest, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();
    }

    @Test
    void coversTheBareCollectionRouteAndNormalizedSpellings()
            throws Exception {
        SignatureAuthFilter filter = filter(signed());
        for (String path : new String[] {"/v1/agents", "/v1/%61gents",
                "/v1/agents;jsessionid=abc"}) {
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request("POST", path), response,
                    new MockFilterChain());
            assertThat(response.getStatus()).as(path).isEqualTo(401);
            assertThat(response.getContentAsString()).as(path)
                    .contains("authentication_required");
        }

        String timestamp = now();
        MockHttpServletRequest signedRequest = request("POST", "/v1/agents");
        signedRequest.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        signedRequest.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER,
                timestamp);
        signedRequest.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/agents", "tenant-a", "actor-a", timestamp));
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(signedRequest, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();
    }

    @Test
    void requiresEachSignatureHeader() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();
        String signature = sign("GET", "/v1/agents/sessions", "tenant-a",
                "actor-a", timestamp);
        for (String omitted : new String[] {SignatureAuthFilter.ACTOR_HEADER,
                SignatureAuthFilter.SIGNATURE_HEADER,
                SignatureAuthFilter.TIMESTAMP_HEADER}) {
            MockHttpServletRequest request = request("GET",
                    "/v1/agents/sessions");
            if (!omitted.equals(SignatureAuthFilter.ACTOR_HEADER)) {
                request.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
            }
            if (!omitted.equals(SignatureAuthFilter.SIGNATURE_HEADER)) {
                request.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                        signature);
            }
            if (!omitted.equals(SignatureAuthFilter.TIMESTAMP_HEADER)) {
                request.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER,
                        timestamp);
            }
            MockHttpServletResponse response = new MockHttpServletResponse();
            filter.doFilter(request, response, new MockFilterChain());
            assertThat(response.getStatus()).as(omitted).isEqualTo(401);
            assertThat(response.getContentAsString()).as(omitted)
                    .contains("authentication_required");
        }
    }

    @Test
    void rejectsARepeatedIdempotencyKey() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();
        MockHttpServletRequest request = request("POST",
                "/v1/agents/sessions");
        request.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        request.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        request.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/agents/sessions", "tenant-a", "actor-a",
                        timestamp, new byte[0], "key-1"));
        request.addHeader(SignatureAuthFilter.IDEMPOTENCY_HEADER, "key-1");
        request.addHeader(SignatureAuthFilter.IDEMPOTENCY_HEADER, "key-2");
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, new MockFilterChain());
        assertThat(response.getStatus()).isEqualTo(400);
        assertThat(response.getContentAsString()).contains("invalid_request");
    }

    @Test
    void boundsTheBufferedBody() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        properties.getAuth().setMaxSignedBodyBytes(1024);
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        SignatureAuthFilter filter = filter(new BrokerSecurity(properties,
                server, new WebMvcProperties()));

        MockHttpServletRequest oversized = request("POST",
                "/v1/agents/sessions");
        oversized.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        oversized.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, now());
        oversized.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                "v1=" + "0".repeat(64));
        oversized.setContent(new byte[2048]);
        MockHttpServletResponse refused = new MockHttpServletResponse();
        filter.doFilter(oversized, refused, new MockFilterChain());
        assertThat(refused.getStatus()).isEqualTo(413);
        assertThat(refused.getContentAsString())
                .contains("payload_too_large");

        // Under the limit the request reaches the signature check.
        String timestamp = now();
        byte[] body = new byte[512];
        MockHttpServletRequest within = request("POST", "/v1/agents/sessions");
        within.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        within.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        within.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/agents/sessions", "tenant-a", "actor-a",
                        timestamp, body, null));
        within.setContent(body);
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(within, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();
    }

    @Test
    void signsTheRawUriOnANormalizedSpelling() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();
        // Signed over the raw (undecoded) URI: accepted.
        MockHttpServletRequest raw = request("POST", "/v1/%61gents");
        raw.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        raw.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        raw.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/%61gents", "tenant-a", "actor-a",
                        timestamp));
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(raw, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();

        // Signed over the decoded path instead: refused.
        MockHttpServletRequest decoded = request("POST", "/v1/%61gents");
        decoded.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        decoded.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        decoded.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                sign("POST", "/v1/agents", "tenant-a", "actor-a", timestamp));
        MockHttpServletResponse refused = new MockHttpServletResponse();
        filter.doFilter(decoded, refused, new MockFilterChain());
        assertThat(refused.getStatus()).isEqualTo(401);
        assertThat(refused.getContentAsString()).contains("invalid_signature");
    }

    @Test
    void boundsAChunkedBodyWhoseLengthIsUndeclared() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        properties.getAuth().setMaxSignedBodyBytes(1024);
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        SignatureAuthFilter filter = filter(new BrokerSecurity(properties,
                server, new WebMvcProperties()));

        // A chunked request reports no declared length, so only the bounded
        // read can stop it.
        MockHttpServletRequest chunked = new MockHttpServletRequest("POST",
                "/v1/agents/sessions") {
            @Override
            public long getContentLengthLong() {
                return -1;
            }
        };
        chunked.addHeader(TenantContextFilter.HEADER, "tenant-a");
        chunked.setContent(new byte[2048]);
        chunked.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        chunked.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, now());
        chunked.addHeader(SignatureAuthFilter.SIGNATURE_HEADER,
                "v1=" + "0".repeat(64));
        MockHttpServletResponse refused = new MockHttpServletResponse();
        filter.doFilter(chunked, refused, new MockFilterChain());
        assertThat(refused.getStatus()).isEqualTo(413);
        assertThat(refused.getContentAsString())
                .contains("payload_too_large");
    }

    @Test
    void signsTheQueryString() throws Exception {
        SignatureAuthFilter filter = filter(signed());
        String timestamp = now();
        String signature = sign("GET", "/v1/agents/sessions", "limit=2",
                "tenant-a", "actor-a", timestamp, new byte[0], null);

        MockHttpServletRequest matching = request("GET",
                "/v1/agents/sessions");
        matching.setQueryString("limit=2");
        matching.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        matching.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        matching.addHeader(SignatureAuthFilter.SIGNATURE_HEADER, signature);
        MockHttpServletResponse accepted = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(matching, accepted, chain);
        assertThat(((HttpServletRequest) chain.getRequest())
                .getUserPrincipal()).isNotNull();

        // The same signature replayed against another query is refused.
        MockHttpServletRequest replayed = request("GET",
                "/v1/agents/sessions");
        replayed.setQueryString("limit=100");
        replayed.addHeader(SignatureAuthFilter.ACTOR_HEADER, "actor-a");
        replayed.addHeader(SignatureAuthFilter.TIMESTAMP_HEADER, timestamp);
        replayed.addHeader(SignatureAuthFilter.SIGNATURE_HEADER, signature);
        MockHttpServletResponse denied = new MockHttpServletResponse();
        filter.doFilter(replayed, denied, new MockFilterChain());
        assertThat(denied.getStatus()).isEqualTo(401);
        assertThat(denied.getContentAsString()).contains("invalid_signature");
    }

    private static MockHttpServletRequest request(String method,
            String path) {
        MockHttpServletRequest request = new MockHttpServletRequest(method,
                path);
        request.addHeader(TenantContextFilter.HEADER, "tenant-a");
        return request;
    }

    private static SignatureAuthFilter filter(BrokerSecurity security) {
        return new SignatureAuthFilter(security, JSON);
    }

    private static BrokerSecurity open() throws Exception {
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        return new BrokerSecurity(new ManagedAgentProperties(), server, new WebMvcProperties());
    }

    private static BrokerSecurity signed() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        return new BrokerSecurity(properties, server, new WebMvcProperties());
    }

    private static String now() {
        return Long.toString(System.currentTimeMillis() / 1000L);
    }

    private static String sign(String method, String uri, String tenant,
            String actor, String timestamp) throws Exception {
        return sign(method, uri, tenant, actor, timestamp, new byte[0], null);
    }

    private static String sign(String method, String uri, String tenant,
            String actor, String timestamp, byte[] body, String idempotencyKey)
            throws Exception {
        return sign(method, uri, "", tenant, actor, timestamp, body,
                idempotencyKey);
    }

    private static String sign(String method, String uri, String query,
            String tenant, String actor, String timestamp, byte[] body,
            String idempotencyKey) throws Exception {
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + uri
                + "\n" + (query == null ? "" : query) + "\n" + tenant + "\n"
                + actor + "\n" + timestamp + "\n" + sha256Hex(body) + "\n"
                + (idempotencyKey == null ? "" : idempotencyKey);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(KEY.getBytes(StandardCharsets.UTF_8),
                "HmacSHA256"));
        return "v1=" + HexFormat.of().formatHex(
                mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    private static String sha256Hex(byte[] body) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(body));
    }
}
