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

    @Test
    void theClassifierIgnoresTheRequestContentCharset() throws Exception {
        // The router decodes the URI as UTF-8; a Content-Type charset must
        // not give the classifier a different view.
        RoutingFilter filter = new RoutingFilter(properties(INTERNAL),
                new ObjectMapper());
        MockHttpServletRequest encoded = request(
                "/%69%6Eternal/managed-session-store/v1/sessions/s/restore",
                PUBLIC);
        encoded.setCharacterEncoding("UTF-16");
        MockHttpServletResponse onPublic = new MockHttpServletResponse();
        MockFilterChain publicChain = new MockFilterChain();
        filter.doFilter(encoded, onPublic, publicChain);
        assertThat(onPublic.getStatus()).isEqualTo(404);
        assertThat(publicChain.getRequest()).isNull();

        MockHttpServletRequest internal = request(
                "/%69%6Eternal/managed-session-store/v1/sessions/s/restore",
                INTERNAL);
        internal.setCharacterEncoding("UTF-16");
        MockFilterChain internalChain = new MockFilterChain();
        filter.doFilter(internal, new MockHttpServletResponse(),
                internalChain);
        assertThat(internalChain.getRequest()).isNotNull();
    }

    @Test
    void warnsWhenTheInternalListenerLeavesLoopbackWithoutTls() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(InternalSurfaceConfiguration.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            ManagedAgentProperties properties = properties(INTERNAL);
            properties.getInternalServer().setAddress("10.0.0.8");
            new InternalSurfaceConfiguration(properties).customize(
                    new org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory());
            assertThat(appender.list).anySatisfy(event -> assertThat(
                    event.getFormattedMessage())
                    .contains("non-loopback")
                    .contains("cleartext"));
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void warnsAboutCleartextCredentialsEvenWhenThePublicConnectorHasTls() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(InternalSurfaceConfiguration.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            ManagedAgentProperties properties = properties(INTERNAL);
            properties.getInternalServer().setAddress("10.0.0.8");
            var factory =
                    new org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory();
            var ssl = new org.springframework.boot.web.server.Ssl();
            ssl.setEnabled(true);
            factory.setSsl(ssl);
            new InternalSurfaceConfiguration(properties).customize(factory);
            assertThat(appender.list).anySatisfy(event -> assertThat(
                    event.getFormattedMessage())
                    .contains("non-loopback")
                    .contains("cleartext"));
        } finally {
            logger.detachAppender(appender);
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
