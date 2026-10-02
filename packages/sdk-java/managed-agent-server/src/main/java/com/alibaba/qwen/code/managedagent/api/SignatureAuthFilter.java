package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.config.BrokerSecurity;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Principal;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates the tenant/actor header pair with an HMAC signature so the
 * broker can run multi-tenant without an external gateway. Active only when
 * the resolved mode is SIGNED; internal routes stay protected by the writer
 * binding credential instead.
 */
@Component
public class SignatureAuthFilter extends OncePerRequestFilter
        implements Ordered {
    public static final String ACTOR_HEADER = "X-Qwen-Actor-Id";
    public static final String SIGNATURE_HEADER = "X-Qwen-Signature";
    public static final String TIMESTAMP_HEADER = "X-Qwen-Signature-Timestamp";
    private static final String PREFIX = "v1=";
    private final BrokerSecurity security;
    private final ObjectMapper objectMapper;

    public SignatureAuthFilter(BrokerSecurity security,
            ObjectMapper objectMapper) {
        this.security = security;
        this.objectMapper = objectMapper;
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 10;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (security.getMode() != BrokerSecurity.Mode.SIGNED) {
            return true;
        }
        String path = request.getRequestURI();
        return !path.startsWith("/v1/agents/")
                && !path.startsWith("/api/agent/web-shell/v1/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String tenantId = request.getHeader(TenantContextFilter.HEADER);
        if (tenantId == null) {
            // The tenant filter answers a missing tenant with 400.
            chain.doFilter(request, response);
            return;
        }
        String actorId = request.getHeader(ACTOR_HEADER);
        String signature = request.getHeader(SIGNATURE_HEADER);
        String timestamp = request.getHeader(TIMESTAMP_HEADER);
        if (actorId == null || signature == null || timestamp == null) {
            reject(request, response, "authentication_required",
                    "Signed mode requires the " + ACTOR_HEADER + ", "
                            + SIGNATURE_HEADER + " and " + TIMESTAMP_HEADER
                            + " headers.");
            return;
        }
        long signedAt;
        try {
            signedAt = Long.parseLong(timestamp.trim());
        } catch (NumberFormatException error) {
            reject(request, response, "invalid_signature",
                    "The signature timestamp is invalid.");
            return;
        }
        long drift = Math.abs(signedAt
                - System.currentTimeMillis() / 1000L);
        if (drift > security.getAllowedDrift().getSeconds()) {
            reject(request, response, "invalid_signature",
                    "The signature timestamp is outside the allowed drift.");
            return;
        }
        String expected = PREFIX + sign(request.getMethod(),
                request.getRequestURI(), tenantId, actorId, timestamp.trim());
        if (!MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.US_ASCII),
                signature.trim().getBytes(StandardCharsets.US_ASCII))) {
            reject(request, response, "invalid_signature",
                    "The request signature is invalid.");
            return;
        }
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override
            public Principal getUserPrincipal() {
                return new AuthenticatedTenantActor() {
                    @Override
                    public String tenantId() {
                        return tenantId;
                    }

                    @Override
                    public String actorId() {
                        return actorId;
                    }

                    @Override
                    public String getName() {
                        return actorId;
                    }
                };
            }
        }, response);
    }

    private String sign(String method, String uri, String tenantId,
            String actorId, String timestamp) {
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + uri
                + "\n" + tenantId + "\n" + actorId + "\n" + timestamp;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(security.getSigningKey(),
                    "HmacSHA256"));
            return HexFormat.of().formatHex(
                    mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("HmacSHA256 is unavailable",
                    error);
        }
    }

    private void reject(HttpServletRequest request,
            HttpServletResponse response, String code, String message)
            throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(),
                ApiExceptionHandler.envelope(request, code, message));
    }
}
