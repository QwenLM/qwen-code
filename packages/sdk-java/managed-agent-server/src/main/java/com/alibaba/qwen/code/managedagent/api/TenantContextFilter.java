package com.alibaba.qwen.code.managedagent.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class TenantContextFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Qwen-Tenant-Id";
    public static final String ATTRIBUTE = TenantContext.class.getName();
    private static final String MANAGED_SESSION_STORE_PREFIX =
            "/internal/managed-session-store/v1/";
    private static final Pattern TENANT_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    private final ObjectMapper objectMapper;

    public TenantContextFilter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/v1/agents/")
                && !path.startsWith("/api/agent/web-shell/v1/")
                && !path.startsWith(MANAGED_SESSION_STORE_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (request.getRequestURI()
                .startsWith(MANAGED_SESSION_STORE_PREFIX)) {
            response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        }
        String tenantId = request.getHeader(HEADER);
        if (tenantId == null || !TENANT_PATTERN.matcher(tenantId).matches()) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            objectMapper.writeValue(response.getOutputStream(), Map.of(
                    "error", Map.of(
                            "code", "invalid_tenant",
                            "message", HEADER
                                    + " is required and must contain 1-128"
                                    + " safe characters.")));
            return;
        }
        request.setAttribute(ATTRIBUTE, new TenantContext(tenantId));
        chain.doFilter(request, response);
    }
}
