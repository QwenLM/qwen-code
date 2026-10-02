package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.core.Ordered;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class TrustedActorHeaderFilterTest {
    private static final String HEADER = "X-E2E-Trusted-Actor";

    @Test
    void isDisabledByDefaultAndRunsFirst() throws Exception {
        TrustedActorHeaderFilter filter = filter(" ");
        MockHttpServletRequest request = request();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, new MockHttpServletResponse(), chain);
        assertThat(((HttpServletRequest) chain.getRequest()).getUserPrincipal()).isNull();
        assertThat(filter.getOrder()).isEqualTo(Ordered.HIGHEST_PRECEDENCE);
    }

    @Test
    void suppliesThePrincipalFromTheConfiguredHeader() throws Exception {
        MockHttpServletRequest request = request();
        MockFilterChain chain = new MockFilterChain();
        filter(HEADER).doFilter(request, new MockHttpServletResponse(), chain);
        assertThat(((HttpServletRequest) chain.getRequest()).getUserPrincipal())
                .isInstanceOfSatisfying(AuthenticatedTenantActor.class,
                        actor -> {
                            assertThat(actor.tenantId()).isEqualTo("tenant-a");
                            assertThat(actor.actorId()).isEqualTo("actor-a");
                            assertThat(actor.getName()).isEqualTo("actor-a");
                        });
    }

    @Test
    void missingOrBlankActorHeaderStaysAnonymous() throws Exception {
        for (String value : new String[] {null, " ", "\t"}) {
            MockHttpServletRequest request = new MockHttpServletRequest(
                    "POST", "/v1/agents/sessions");
            request.addHeader(TenantContextFilter.HEADER, "tenant-a");
            if (value != null) {
                request.addHeader(HEADER, value);
            }
            MockFilterChain chain = new MockFilterChain();
            filter(HEADER).doFilter(request, new MockHttpServletResponse(),
                    chain);
            assertThat(((HttpServletRequest) chain.getRequest()).getUserPrincipal()).isNull();
        }
    }

    @Test
    void missingTenantHeaderStaysAnonymous() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(
                "POST", "/v1/agents/sessions");
        request.addHeader(HEADER, "actor-a");
        MockFilterChain chain = new MockFilterChain();
        filter(HEADER).doFilter(request, new MockHttpServletResponse(), chain);
        assertThat(((HttpServletRequest) chain.getRequest()).getUserPrincipal()).isNull();
    }

    private static TrustedActorHeaderFilter filter(String configured) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.setTrustedActorHeader(configured);
        return new TrustedActorHeaderFilter(properties);
    }

    private static MockHttpServletRequest request() {
        MockHttpServletRequest request = new MockHttpServletRequest(
                "POST", "/v1/agents/sessions");
        request.addHeader(TenantContextFilter.HEADER, "tenant-a");
        request.addHeader(HEADER, "actor-a");
        return request;
    }
}
