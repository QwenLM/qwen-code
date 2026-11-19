package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Bounds the relay MCP request body before Spring materialises it for
 * {@code @RequestBody}. The controller examines the relay credential only
 * after the payload has been buffered, so without this guard an unauthenticated
 * caller could make the control plane buffer an unbounded body even though the
 * service later refuses oversized payloads. The bound mirrors the service's
 * {@code requirePayloadSize} so an oversized payload is refused identically
 * whether or not it declares a Content-Length, and the read is capped at one
 * byte past the limit so the refusal itself cannot be turned into a buffer.
 */
@Component
@ConditionalOnProperty(prefix = "qwen.managed-agent.client-files", name = "enabled", havingValue = "true")
public class ClientFilesMcpBodyLimitFilter extends OncePerRequestFilter {
    private final int maxPayloadBytes;
    private final ObjectMapper objectMapper;

    public ClientFilesMcpBodyLimitFilter(ManagedAgentSettings settings, ObjectMapper objectMapper) {
        this.maxPayloadBytes = settings.getClientFiles().getMaxPayloadBytes();
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Decide on the same normalized path the routing filter uses, so a
        // percent-encoded or matrix-parameter spelling cannot slip past the
        // body bound and still reach the MCP handler.
        String path = PublicSurface.pathWithinApplication(request);
        return !"POST".equals(request.getMethod())
                || !path.startsWith("/internal/managed-client-files/")
                || !path.endsWith("/mcp");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (request.getContentLengthLong() > maxPayloadBytes) {
            refuse(response);
            return;
        }
        byte[] body = request.getInputStream().readNBytes(maxPayloadBytes + 1);
        if (body.length > maxPayloadBytes) {
            refuse(response);
            return;
        }
        chain.doFilter(new CachedBodyRequest(request, body), response);
    }

    private void refuse(HttpServletResponse response) throws IOException {
        response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(),
                Map.of("error", Map.of("code", "client_files_payload_too_large")));
    }

    /** Replays the already-bounded body so Spring reads the cached copy. */
    private static final class CachedBodyRequest extends HttpServletRequestWrapper {
        private final byte[] body;

        CachedBodyRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream source = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public boolean isFinished() {
                    return source.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener readListener) {
                    throw new UnsupportedOperationException();
                }

                @Override
                public int read() {
                    return source.read();
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(
                    new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }
}
