package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.Principal;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Local stand-in for the trusted gateway that supplies the actor principal,
 * for single-host and E2E deployments without one. Disabled unless
 * qwen.managed-agent.trusted-actor-header names a header; never enable it
 * where untrusted clients can reach the server.
 */
@Component
public class TrustedActorHeaderFilter extends OncePerRequestFilter
        implements Ordered {
    private final String header;

    public TrustedActorHeaderFilter(ManagedAgentProperties properties) {
        String configured = properties.getTrustedActorHeader();
        this.header = configured == null ? "" : configured.trim();
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String actorId = header.isEmpty() ? null : request.getHeader(header);
        String tenantId = request.getHeader(TenantContextFilter.HEADER);
        // Stand in only for a missing principal: an upstream-authenticated
        // identity always wins over the header.
        if (request.getUserPrincipal() != null
                || actorId == null || actorId.isBlank()
                || tenantId == null || tenantId.isBlank()) {
            chain.doFilter(request, response);
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
}
