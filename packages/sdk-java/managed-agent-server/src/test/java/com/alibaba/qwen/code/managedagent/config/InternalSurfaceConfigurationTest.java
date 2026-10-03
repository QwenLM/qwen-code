package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.InternalSurfaceConfiguration.RoutingFilter;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.core.Ordered;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class InternalSurfaceConfigurationTest {
    private static final int INTERNAL = 4183;
    private static final int PUBLIC = 8080;

    @Test
    void staysInactiveWithoutADedicatedPort() throws Exception {
        RoutingFilter filter = new RoutingFilter(properties(0),
                new ObjectMapper());
        MockHttpServletRequest request = request(
                "/internal/managed-session-store/v1/sessions/s/restore",
                PUBLIC);
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, new MockHttpServletResponse(), chain);
        assertThat(chain.getRequest()).isNotNull();
        assertThat(filter.getOrder()).isEqualTo(Ordered.HIGHEST_PRECEDENCE);
    }

    @Test
    void keepsEachSurfaceOnItsOwnListener() throws Exception {
        RoutingFilter filter = new RoutingFilter(properties(INTERNAL),
                new ObjectMapper());

        MockHttpServletResponse internalOnPublic = new MockHttpServletResponse();
        MockFilterChain first = new MockFilterChain();
        filter.doFilter(request(
                "/internal/managed-session-store/v1/sessions/s/restore",
                PUBLIC), internalOnPublic, first);
        assertThat(internalOnPublic.getStatus()).isEqualTo(404);
        assertThat(first.getRequest()).isNull();

        MockHttpServletResponse publicOnInternal = new MockHttpServletResponse();
        MockFilterChain second = new MockFilterChain();
        filter.doFilter(request("/v1/agents/sessions", INTERNAL),
                publicOnInternal, second);
        assertThat(publicOnInternal.getStatus()).isEqualTo(404);
        assertThat(second.getRequest()).isNull();

        MockHttpServletResponse internalOk = new MockHttpServletResponse();
        MockFilterChain third = new MockFilterChain();
        filter.doFilter(request(
                "/internal/managed-session-store/v1/sessions/s/restore",
                INTERNAL), internalOk, third);
        assertThat(internalOk.getStatus()).isEqualTo(200);
        assertThat(third.getRequest()).isNotNull();

        MockHttpServletResponse publicOk = new MockHttpServletResponse();
        MockFilterChain fourth = new MockFilterChain();
        filter.doFilter(request("/v1/agents/sessions", PUBLIC), publicOk,
                fourth);
        assertThat(publicOk.getStatus()).isEqualTo(200);
        assertThat(fourth.getRequest()).isNotNull();
    }

    @Test
    void classifiesNormalizedSpellingsOnTheRoutedPath() throws Exception {
        RoutingFilter filter = new RoutingFilter(properties(INTERNAL),
                new ObjectMapper());
        for (String spelling : new String[] {
                "/%69nternal/managed-session-store/v1/sessions/s/restore",
                "/internal;/managed-session-store/v1/sessions/s/restore",
                "/internal;x=1/managed-session-store/v1/sessions/s/restore"}) {
            MockHttpServletResponse onPublic = new MockHttpServletResponse();
            MockFilterChain publicChain = new MockFilterChain();
            filter.doFilter(request(spelling, PUBLIC), onPublic,
                    publicChain);
            assertThat(onPublic.getStatus()).as(spelling).isEqualTo(404);
            assertThat(publicChain.getRequest()).as(spelling).isNull();

            MockHttpServletResponse onInternal = new MockHttpServletResponse();
            MockFilterChain internalChain = new MockFilterChain();
            filter.doFilter(request(spelling, INTERNAL), onInternal,
                    internalChain);
            assertThat(internalChain.getRequest()).as(spelling).isNotNull();
        }
    }

    private static ManagedAgentProperties properties(int port) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getInternalServer().setPort(port);
        return properties;
    }

    private static MockHttpServletRequest request(String path, int port) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET",
                path);
        request.setLocalPort(port);
        return request;
    }
}
