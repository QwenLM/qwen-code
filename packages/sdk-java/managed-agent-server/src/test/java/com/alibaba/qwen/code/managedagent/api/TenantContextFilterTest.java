package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.ServletException;
import java.io.IOException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class TenantContextFilterTest {
    private final TenantContextFilter filter = new TenantContextFilter(
            new ObjectMapper());

    @Test
    void acceptsOnlyMatchingTrustedPrincipal() throws Exception {
        MockHttpServletRequest request = request("tenant-a");
        request.setUserPrincipal(actor("tenant-a", "actor-a"));
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, new MockHttpServletResponse(), chain);
        TenantContext context = (TenantContext) request.getAttribute(
                TenantContextFilter.ATTRIBUTE);
        assertThat(context.requireActorId()).isEqualTo("actor-a");
        assertThat(context.tenantId()).isEqualTo("tenant-a");
        assertThat(chain.getRequest()).isSameAs(request);
    }

    @Test
    void acceptsTrustedActorIdsAtTheUnicodeBoundary() throws Exception {
        for (String actorId : new String[] {"alice@example.com", " ",
                "𝄞".repeat(512)}) {
            MockHttpServletRequest request = request("tenant-a");
            request.setUserPrincipal(actor("tenant-a", actorId));
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            filter.doFilter(request, response, chain);
            assertThat(chain.getRequest()).isSameAs(request);
            assertThat(response.getStatus()).isEqualTo(200);
            TenantContext context = (TenantContext) request.getAttribute(
                    TenantContextFilter.ATTRIBUTE);
            assertThat(context.requireActorId()).isEqualTo(actorId);
        }
    }

    @Test
    void doesNotAcceptAHeaderOrAnUnscopedPrincipalAsActor()
            throws ServletException, IOException {
        MockHttpServletRequest request = request("tenant-a");
        request.addHeader("X-Qwen-Actor-Id", "actor-a");
        request.setUserPrincipal(() -> "actor-a");
        filter.doFilter(request, new MockHttpServletResponse(),
                new MockFilterChain());
        TenantContext context = (TenantContext) request.getAttribute(
                TenantContextFilter.ATTRIBUTE);
        assertThatThrownBy(context::requireActorId)
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("actor_required"));
    }

    @Test
    void rejectsTenantHeaderSpoofingAndInvalidActorScope()
            throws ServletException, IOException {
        for (AuthenticatedTenantActor actor : new AuthenticatedTenantActor[] {
                actor("tenant-b", "actor-a"), actor("tenant-a", "bad\nactor"),
                actor("tenant-a", "𝄞".repeat(513))
        }) {
            MockHttpServletRequest request = request("tenant-a");
            request.setUserPrincipal(actor);
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            filter.doFilter(request, response, chain);
            assertThat(response.getStatus()).isEqualTo(403);
            assertThat(response.getContentAsString())
                    .contains("actor_scope_mismatch");
            assertThat(chain.getRequest()).isNull();
        }
    }

    private static MockHttpServletRequest request(String tenant) {
        MockHttpServletRequest request = new MockHttpServletRequest(
                "POST", "/v1/agents/sessions");
        request.addHeader(TenantContextFilter.HEADER, tenant);
        return request;
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId) {
        return new AuthenticatedTenantActor() {
            @Override
            public String getName() {
                return actorId;
            }

            @Override
            public String tenantId() {
                return tenant;
            }

            @Override
            public String actorId() {
                return actorId;
            }
        };
    }
}
