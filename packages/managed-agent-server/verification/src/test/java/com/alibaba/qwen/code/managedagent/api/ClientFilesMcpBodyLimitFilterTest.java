package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

public class ClientFilesMcpBodyLimitFilterTest {
    private static final String MCP_PATH =
            "/internal/managed-client-files/v1/sessions/session-1/mcp";
    private static final ObjectMapper JSON = new ObjectMapper();

    private ClientFilesMcpBodyLimitFilter filter(int maxPayloadBytes) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getClientFiles().setEnabled(true);
        properties.getClientFiles().setMaxPayloadBytes(maxPayloadBytes);
        return new ClientFilesMcpBodyLimitFilter(properties, JSON);
    }

    private MockHttpServletRequest request(String path, byte[] body, boolean declareLength) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", path) {
            @Override
            public long getContentLengthLong() {
                return declareLength ? super.getContentLengthLong() : -1;
            }

            @Override
            public int getContentLength() {
                return declareLength ? super.getContentLength() : -1;
            }
        };
        request.setContentType("application/json");
        request.setContent(body);
        return request;
    }

    @Test
    void refusesAnOversizedDeclaredBodyBeforeTheControllerBuffersIt() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(64);
        byte[] body = "x".repeat(65).getBytes(StandardCharsets.UTF_8);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request(MCP_PATH, body, true), response,
                (wrapped, result) -> reached.set(true));
        assertThat(reached).isFalse();
        assertThat(response.getStatus()).isEqualTo(400);
        assertThat(JSON.readTree(response.getContentAsString()).at("/error/code").asText())
                .isEqualTo("client_files_payload_too_large");
    }

    @Test
    void refusesAnOversizedChunkedBodyWithoutAContentLength() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(64);
        byte[] body = "x".repeat(4096).getBytes(StandardCharsets.UTF_8);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        // No declared length: the read itself must stay bounded, so the refusal
        // cannot be turned into an unbounded buffer either.
        filter.doFilter(request(MCP_PATH, body, false), response,
                (wrapped, result) -> reached.set(true));
        assertThat(reached).isFalse();
        assertThat(response.getStatus()).isEqualTo(400);
        assertThat(JSON.readTree(response.getContentAsString()).at("/error/code").asText())
                .isEqualTo("client_files_payload_too_large");
    }

    @Test
    void replaysAWithinBoundBodyToTheController() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(64);
        byte[] body = "{\"jsonrpc\":\"2.0\",\"id\":\"1\"}".getBytes(StandardCharsets.UTF_8);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request(MCP_PATH, body, true), response, (wrapped, result) -> {
            assertThat(((HttpServletRequest) wrapped).getInputStream().readAllBytes())
                    .isEqualTo(body);
            reached.set(true);
        });
        assertThat(reached).isTrue();
        assertThat(response.getStatus()).isEqualTo(200);
    }

    @Test
    void admitsABodyExactlyAtTheBound() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(64);
        byte[] body = "x".repeat(64).getBytes(StandardCharsets.UTF_8);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request(MCP_PATH, body, false), response,
                (wrapped, result) -> reached.set(true));
        assertThat(reached).isTrue();
    }

    @Test
    void boundsAnEncodedSpellingOfTheMcpPath() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(64);
        byte[] body = "x".repeat(4096).getBytes(StandardCharsets.UTF_8);
        // A percent-encoded spelling still routes to the MCP handler, so the
        // body bound must decide on the normalized path, not the raw URI.
        MockHttpServletRequest request = new MockHttpServletRequest(
                "POST", "/%69nternal/managed-client-files/v1/sessions/session-1/mcp");
        request.setContentType("application/json");
        request.setContent(body);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request, response, (wrapped, result) -> reached.set(true));
        assertThat(reached).isFalse();
        assertThat(response.getStatus()).isEqualTo(400);
        assertThat(JSON.readTree(response.getContentAsString()).at("/error/code").asText())
                .isEqualTo("client_files_payload_too_large");
    }

    @Test
    void doesNotBoundOtherRoutes() throws Exception {
        ClientFilesMcpBodyLimitFilter filter = filter(8);
        byte[] body = "x".repeat(4096).getBytes(StandardCharsets.UTF_8);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicBoolean reached = new AtomicBoolean(false);
        filter.doFilter(request("/api/agent/web-shell/v1/client-files/register", body, true),
                response, (wrapped, result) -> reached.set(true));
        assertThat(reached).isTrue();
    }
}
