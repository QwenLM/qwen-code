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
    public static final String IDEMPOTENCY_HEADER = "Idempotency-Key";
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
        // Coverage follows the routed path (as the tenant filter does); the
        // canonical string still signs the raw request URI.
        return !PublicSurface.covers(
                PublicSurface.pathWithinApplication(request));
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
            reject(request, response, HttpServletResponse.SC_UNAUTHORIZED,
                    "authentication_required",
                    "Signed mode requires the " + ACTOR_HEADER + ", "
                            + SIGNATURE_HEADER + " and " + TIMESTAMP_HEADER
                            + " headers.");
            return;
        }
        // getHeader signs the first value while the controllers bind the
        // comma-joined pair, so a repeated key must be refused outright.
        if (java.util.Collections.list(
                request.getHeaders(IDEMPOTENCY_HEADER)).size() > 1) {
            reject(request, response, HttpServletResponse.SC_BAD_REQUEST,
                    "invalid_request",
                    "The " + IDEMPOTENCY_HEADER + " header is repeated.");
            return;
        }
        long signedAt;
        try {
            signedAt = Long.parseLong(timestamp.trim());
        } catch (NumberFormatException error) {
            reject(request, response, HttpServletResponse.SC_UNAUTHORIZED,
                    "invalid_signature",
                    "The signature timestamp is invalid.");
            return;
        }
        long drift = Math.abs(signedAt
                - System.currentTimeMillis() / 1000L);
        if (drift > security.getAllowedDrift().getSeconds()) {
            reject(request, response, HttpServletResponse.SC_UNAUTHORIZED,
                    "invalid_signature",
                    "The signature timestamp is outside the allowed drift.");
            return;
        }
        // The body is signed, so it is buffered here and re-exposed to the
        // chain; without it a captured signature would authorize any
        // substitute body on the same method and path inside the window. The
        // per-request buffer is bounded; the aggregate is bounded by the
        // servlet worker-thread count times that limit.
        long maxBody = security.getMaxSignedBodyBytes();
        long declared = request.getContentLengthLong();
        if (declared > maxBody) {
            reject(request, response,
                    HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE,
                    "payload_too_large",
                    "The request body exceeds the signed-body limit.");
            return;
        }
        byte[] body = readBounded(request.getInputStream(), maxBody,
                declared);
        if (body == null) {
            reject(request, response,
                    HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE,
                    "payload_too_large",
                    "The request body exceeds the signed-body limit.");
            return;
        }
        String expected = PREFIX + sign(request.getMethod(),
                request.getRequestURI(), request.getQueryString(), tenantId,
                actorId, timestamp.trim(), body,
                request.getHeader(IDEMPOTENCY_HEADER));
        if (!MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.US_ASCII),
                signature.trim().getBytes(StandardCharsets.US_ASCII))) {
            reject(request, response, HttpServletResponse.SC_UNAUTHORIZED,
                    "invalid_signature",
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

            @Override
            public jakarta.servlet.ServletInputStream getInputStream() {
                java.io.ByteArrayInputStream source =
                        new java.io.ByteArrayInputStream(body);
                return new jakarta.servlet.ServletInputStream() {
                    @Override
                    public boolean isFinished() {
                        return source.available() == 0;
                    }

                    @Override
                    public boolean isReady() {
                        return true;
                    }

                    @Override
                    public void setReadListener(
                            jakarta.servlet.ReadListener listener) {
                    }

                    @Override
                    public int read() {
                        return source.read();
                    }

                    @Override
                    public int read(byte[] target, int offset, int length) {
                        return source.read(target, offset, length);
                    }
                };
            }

            @Override
            public java.io.BufferedReader getReader() {
                return new java.io.BufferedReader(
                        new java.io.InputStreamReader(getInputStream(),
                                StandardCharsets.UTF_8));
            }

            // The charset parameter is unsigned, but a non-Unicode charset
            // steers Spring's JSON decoder away from the signed bytes. JSON
            // is UTF-8 by definition (RFC 8259), so the Content-Type the
            // chain observes is pinned to UTF-8 for JSON media types; the
            // decoded content then depends on the signed bytes alone. MVC
            // reads the header, not getReader(), so the pin must live on
            // the header accessors.
            @Override
            public String getContentType() {
                return pinJsonUtf8(super.getContentType());
            }

            @Override
            public String getHeader(String name) {
                if (HttpHeaders.CONTENT_TYPE.equalsIgnoreCase(name)) {
                    return pinJsonUtf8(super.getHeader(name));
                }
                return super.getHeader(name);
            }

            @Override
            public java.util.Enumeration<String> getHeaders(String name) {
                if (HttpHeaders.CONTENT_TYPE.equalsIgnoreCase(name)) {
                    String pinned = pinJsonUtf8(super.getHeader(name));
                    return java.util.Collections.enumeration(
                            pinned == null ? java.util.List.of()
                                    : java.util.List.of(pinned));
                }
                return super.getHeaders(name);
            }

            @Override
            public String getCharacterEncoding() {
                String contentType = super.getContentType();
                if (contentType != null
                        && !contentType.equals(pinJsonUtf8(contentType))) {
                    return StandardCharsets.UTF_8.name();
                }
                return super.getCharacterEncoding();
            }
        }, response);
    }

    private static String pinJsonUtf8(String contentType) {
        if (contentType == null) {
            return null;
        }
        MediaType parsed;
        try {
            parsed = MediaType.parseMediaType(contentType);
        } catch (org.springframework.http.InvalidMediaTypeException error) {
            return contentType;
        }
        if (!"application".equalsIgnoreCase(parsed.getType())) {
            return contentType;
        }
        String subtype = parsed.getSubtype()
                .toLowerCase(java.util.Locale.ROOT);
        if (!subtype.equals("json") && !subtype.endsWith("+json")) {
            return contentType;
        }
        return parsed.getType() + '/' + parsed.getSubtype()
                + ";charset=UTF-8";
    }

    private String sign(String method, String uri, String query,
            String tenantId, String actorId, String timestamp, byte[] body,
            String idempotencyKey) {
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + uri
                + "\n" + (query == null ? "" : query) + "\n" + tenantId
                + "\n" + actorId + "\n" + timestamp + "\n" + sha256Hex(body)
                + "\n" + (idempotencyKey == null ? "" : idempotencyKey);
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

    private static String sha256Hex(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(body));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    // Returns null once the stream runs past the limit, so a chunked or
    // under-declared body cannot outgrow the bound. The presize hint from
    // the declared length is capped at the chunk size: a client-controlled
    // Content-Length must not pin the full bound before a byte arrives.
    private static byte[] readBounded(java.io.InputStream source, long max,
            long declared) throws IOException {
        int hint = (int) Math.min(8192L, Math.min(Math.max(declared, 0),
                Math.min(max, Integer.MAX_VALUE - 8L)));
        java.io.ByteArrayOutputStream buffer =
                new java.io.ByteArrayOutputStream(hint);
        byte[] chunk = new byte[8192];
        long total = 0;
        int read;
        while ((read = source.read(chunk)) != -1) {
            total += read;
            if (total > max) {
                return null;
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private void reject(HttpServletRequest request,
            HttpServletResponse response, int status, String code,
            String message) throws IOException {
        response.setStatus(status);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(),
                ApiExceptionHandler.envelope(request, code, message));
    }
}
