package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TenantContextFilterTest {
    private final TenantContextFilter filter = new TenantContextFilter(
            new ObjectMapper());

    @Test
    void acceptsOnlyMatchingTrustedPrincipal() throws Exception {
        MockHttpServletRequest request = request("tenant-a");
        request.setUserPrincipal(actor("tenant-a", "actor-a",
                "subject-a"));
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, new MockHttpServletResponse(), chain);
        TenantContext context = (TenantContext) request.getAttribute(
                TenantContextFilter.ATTRIBUTE);
        assertThat(context.requireActorId()).isEqualTo("actor-a");
        assertThat(context.actorSubjectId()).isEqualTo("subject-a");
        assertThat(context.principal().actorSubjectId()).isEqualTo("subject-a");
        assertThat(context.tenantId()).isEqualTo("tenant-a");
        assertThat(chain.getRequest()).isSameAs(request);
    }

    @Test
    void acceptsTrustedActorIdsAtTheUnicodeBoundary() throws Exception {
        // The ownership columns bound UTF-8 bytes: 128 astral code points
        // are exactly 512 bytes and must pass, like 512 ASCII characters.
        // The gate itself counts code points as WorkspaceValues.requireText
        // does: 257-512 astral code points exceed 512 UTF-16 units yet stay
        // inside the Workspace contract, so the filter must admit them (the
        // stricter principal byte bound applies where a principal is built).
        for (String actorId : new String[] {"alice@example.com",
                "a".repeat(512), "𝄞".repeat(128), "𝄞".repeat(300),
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
                .isInstanceOfSatisfying(ManagedAgentException.class, error ->
                        assertThat(error.getCode()).isEqualTo("actor_required"));
    }

    @Test
    void rejectsTenantHeaderSpoofingAndInvalidActorScope()
            throws ServletException, IOException {
        for (AuthenticatedTenantActor actor : new AuthenticatedTenantActor[] {
                actor("tenant-b", "actor-a"), actor("tenant-a", "bad\nactor"),
                // 513 code points exceed the Workspace contract itself
                // (WorkspaceValues.requireText), so the gate refuses them;
                // 512 astral code points stay admitted at the filter and are
                // refused only where a principal is actually built.
                actor("tenant-a", "𝄞".repeat(513)),
                actor("tenant-a", "a".repeat(513)),
                actor("tenant-a", " "),
                actor("tenant-a", "actor-a", "subject\nsplit"),
                actor("tenant-a", null, "subject-a")
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

    @Test
    void scopesTheBareAgentCollectionRoute() throws Exception {
        for (String path : new String[] {"/v1/agents",
                "/v1/agents;jsessionid=abc", "/v1;route=public/agents",
                "/v1/%61gents"}) {
            MockHttpServletRequest bare = new MockHttpServletRequest("POST", path);
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            filter.doFilter(bare, response, chain);
            assertThat(response.getStatus()).isEqualTo(400);
            assertThat(response.getContentAsString()).contains("invalid_tenant");
            assertThat(chain.getRequest()).isNull();
        }

        MockHttpServletRequest unrelated = new MockHttpServletRequest("POST",
                "/v1/agentsx");
        MockFilterChain passed = new MockFilterChain();
        filter.doFilter(unrelated, new MockHttpServletResponse(), passed);
        assertThat(passed.getRequest()).isSameAs(unrelated);
    }

    private static MockHttpServletRequest request(String tenant) {
        MockHttpServletRequest request = new MockHttpServletRequest(
                "POST", "/v1/agents/sessions");
        request.addHeader(TenantContextFilter.HEADER, tenant);
        return request;
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId) {
        return actor(tenant, actorId, null);
    }

    private static AuthenticatedTenantActor actor(String tenant,
            String actorId, String actorSubjectId) {
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

            @Override
            public String actorSubjectId() {
                return actorSubjectId;
            }
        };
    }
}
