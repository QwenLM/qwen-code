package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.Principal;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UrlPathHelper;

@Component
public class TenantContextFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Qwen-Tenant-Id";
    public static final String ATTRIBUTE = TenantContext.class.getName();
    private static final String MANAGED_SESSION_STORE_PREFIX =
            "/internal/managed-session-store/v1/";
    private static final String TOOL_PUBLICATION_PREFIX =
            "/internal/managed-tool-publications/v1/";
    private static final Pattern TENANT_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    private final ObjectMapper objectMapper;

    public TenantContextFilter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = UrlPathHelper.defaultInstance
                .getPathWithinApplication(request);
        // The bare collection route (POST /v1/agents) has no trailing slash,
        // so the prefix alone would let it skip the tenant scope.
        return !path.equals("/v1/agents")
                && !path.startsWith("/v1/agents/")
                && !path.startsWith("/api/agent/web-shell/v1/")
                && !path.startsWith(MANAGED_SESSION_STORE_PREFIX)
                && !path.startsWith(TOOL_PUBLICATION_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = UrlPathHelper.defaultInstance
                .getPathWithinApplication(request);
        if (path.startsWith(MANAGED_SESSION_STORE_PREFIX)
                || path.startsWith(TOOL_PUBLICATION_PREFIX)
                || path.startsWith("/v1/agents/workspaces")
                || path.startsWith("/api/agent/web-shell/v1/workspaces/")) {
            response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        }
        String tenantId = request.getHeader(HEADER);
        if (tenantId == null || !TENANT_PATTERN.matcher(tenantId).matches()) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            objectMapper.writeValue(response.getOutputStream(),
                    ApiExceptionHandler.envelope(request, "invalid_tenant",
                            HEADER + " is required and must contain 1-128"
                                    + " safe characters."));
            return;
        }
        Principal principal = request.getUserPrincipal();
        String actorId = null;
        if (principal instanceof AuthenticatedTenantActor actor) {
            String claimedActorId = actor.actorId();
            if (!tenantId.equals(actor.tenantId())
                    || !validActorId(tenantId, claimedActorId)) {
                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                objectMapper.writeValue(response.getOutputStream(),
                        ApiExceptionHandler.envelope(request,
                                "actor_scope_mismatch",
                                "Authenticated actor scope is invalid."));
                return;
            }
            actorId = claimedActorId;
        }
        request.setAttribute(ATTRIBUTE, new TenantContext(tenantId, actorId));
        chain.doFilter(request, response);
    }

    private static boolean validActorId(String tenantId, String actorId) {
        try {
            new WorkspaceActor(tenantId, actorId);
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }
}
