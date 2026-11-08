package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceActor;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.Principal;
import java.util.regex.Pattern;

@Component
public class TenantContextFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Qwen-Tenant-Id";
    public static final String ATTRIBUTE = TenantContext.class.getName();
    private static final String MANAGED_SESSION_STORE_PREFIX =
            "/internal/managed-session-store/v1/";
    private static final String TOOL_PUBLICATION_PREFIX =
            "/internal/managed-tool-publications/v1/";
    private static final String MANAGED_CHANNELS_PREFIX =
            "/internal/managed-channels/v1/";
    private static final String MANAGED_WORKSPACES_PREFIX =
            "/internal/managed-workspaces/v1/";
    private static final Pattern TENANT_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    private final ObjectMapper objectMapper;

    public TenantContextFilter(@Qualifier("managedAgentObjectMapper") ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = PublicSurface.pathWithinApplication(request);
        return !PublicSurface.covers(path)
                && !path.startsWith(MANAGED_SESSION_STORE_PREFIX)
                && !path.startsWith(TOOL_PUBLICATION_PREFIX)
                && !path.startsWith(MANAGED_CHANNELS_PREFIX)
                && !path.startsWith(MANAGED_WORKSPACES_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = PublicSurface.pathWithinApplication(request);
        if (path.startsWith(MANAGED_SESSION_STORE_PREFIX)
                || path.startsWith(TOOL_PUBLICATION_PREFIX)
                || path.startsWith(MANAGED_CHANNELS_PREFIX)
                || path.startsWith(MANAGED_WORKSPACES_PREFIX)
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
        String actorSubjectId = null;
        if (principal instanceof AuthenticatedTenantActor actor) {
            String claimedActorId = actor.actorId();
            String claimedActorSubjectId = actor.actorSubjectId();
            if (!tenantId.equals(actor.tenantId())
                    || !validActorId(tenantId, claimedActorId)
                    || claimedActorSubjectId != null
                            && !validActorSubject(tenantId,
                                    claimedActorId,
                                    claimedActorSubjectId)) {
                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                objectMapper.writeValue(response.getOutputStream(),
                        ApiExceptionHandler.envelope(request,
                                "actor_scope_mismatch",
                                "Authenticated actor scope is invalid."));
                return;
            }
            actorId = claimedActorId;
            actorSubjectId = claimedActorSubjectId;
        }
        request.setAttribute(ATTRIBUTE,
                new TenantContext(tenantId, actorId, actorSubjectId));
        chain.doFilter(request, response);
    }

    private static boolean validActorId(String tenantId, String actorId) {
        if (actorId == null || actorId.isBlank()) {
            return false;
        }
        try {
            new WorkspaceActor(tenantId, actorId);
            // The global gate keeps the Workspace surface's actor contract, not
            // the principal's 512-UTF-8-byte bound: a 512-code-point BMP actor
            // (e.g. 512 CJK characters, 1536 bytes) is admitted here so
            // workspace-only routes keep working. The bound counts code
            // points, exactly as WorkspaceValues.requireText does — a
            // UTF-16 length check would refuse astral actors the Workspace
            // contract admits. The stricter byte bound is enforced where a
            // principal is actually built (TenantContext.requirePrincipal /
            // the ownership row), so a Session can never be committed under
            // an actor the principal cannot represent.
            if (actorId.codePointCount(0, actorId.length())
                    > com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceValues.MAXIMUM_TEXT_CODE_POINTS) {
                return false;
            }
            return true;
        } catch (IllegalArgumentException
                | com.alibaba.qwen.code.managedagent.exception.ManagedAgentException error) {
            return false;
        }
    }

    private static boolean validActorSubject(String tenantId, String actorId,
            String actorSubjectId) {
        if (actorId == null || actorId.isBlank()) {
            return false;
        }
        try {
            com.alibaba.qwen.code.managedagent.model.SessionPrincipal.of(
                    tenantId, actorId, actorSubjectId);
            return true;
        } catch (com.alibaba.qwen.code.managedagent.exception.ManagedAgentException
                error) {
            return false;
        }
    }
}
