package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcProperties;

class BrokerSecurityTest {
    private static final String KEY =
            "0123456789abcdef0123456789abcdef";

    @Test
    void autoResolvesOpenOnLoopback() throws Exception {
        BrokerSecurity security = security(new ManagedAgentProperties(),
                "127.0.0.1");
        assertThat(security.getMode()).isEqualTo(BrokerSecurity.Mode.OPEN);
    }

    @Test
    void autoHonorsTheInsecureBindOverride() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setAllowInsecureBind(true);
        assertThat(security(properties, "0.0.0.0").getMode())
                .isEqualTo(BrokerSecurity.Mode.OPEN);
    }

    @Test
    void refusesAContextPathThatWouldBypassThePathFilters()
            throws Exception {
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        server.getServlet().setContextPath("/broker");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        assertThatThrownBy(() -> new BrokerSecurity(properties, server, new WebMvcProperties()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("context-path");
    }

    @Test
    void refusesANonRootServletPathThatWouldBypassThePathFilters()
            throws Exception {
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("127.0.0.1"));
        WebMvcProperties mvc = new WebMvcProperties();
        mvc.getServlet().setPath("/broker");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        assertThatThrownBy(() -> new BrokerSecurity(properties, server, mvc))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("servlet.path");
    }

    @Test
    void refusesAPlaintextStoreUrlEveryHarnessWouldReject()
            throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore()
                .setBaseUrl("http://broker.internal:4183");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("allow-insecure-http");
        properties.getSessionStore()
                .setBaseUrl("http://127.example.com:4183");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("allow-insecure-http");
        // A bare "127" is not loopback either: WHATWG URL parsing maps it
        // to 0.0.0.127, which the client refuses.
        properties.getSessionStore().setBaseUrl("http://127:4183");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("allow-insecure-http");
        properties.getSessionStore().setAllowInsecureHttp(true);
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
        properties.getSessionStore().setAllowInsecureHttp(false);
        properties.getSessionStore()
                .setBaseUrl("https://broker.internal:4183");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
        for (String loopback : new String[] {"http://127.0.0.1:4183",
                "http://localhost:4183", "http://broker.localhost:4183",
                "http://[::1]:4183", "http://127.1:4183"}) {
            properties.getSessionStore().setBaseUrl(loopback);
            assertThatCode(() -> security(properties, "127.0.0.1"))
                    .as(loopback)
                    .doesNotThrowAnyException();
        }
    }

    @Test
    void refusesAPlaintextNonLoopbackPublicationUrl() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getToolPublication().setEnabled(true);
        properties.getToolPublication()
                .setServiceBaseUrl("http://publication.internal:4184");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("service-base-url");
        properties.getAuth().setAllowInsecureBind(true);
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
        properties.getAuth().setAllowInsecureBind(false);
        properties.getToolPublication()
                .setServiceBaseUrl("https://publication.internal:4184");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();

        // The consumer resolves /internal/... against the base, so a path
        // prefix or a loopback spelling outside its literal set is refused
        // even with TLS.
        for (String bad : new String[] {
                "https://publication.internal:4184/broker/",
                "http://127.0.0.2:4184"}) {
            properties.getToolPublication().setServiceBaseUrl(bad);
            assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                    .as(bad)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("service-base-url");
        }
        for (String good : new String[] {"http://127.0.0.1:4184",
                "http://localhost:4184", "http://[::1]:4184"}) {
            properties.getToolPublication().setServiceBaseUrl(good);
            assertThatCode(() -> security(properties, "127.0.0.1"))
                    .as(good)
                    .doesNotThrowAnyException();
        }
    }

    @Test
    void theInsecureBindOverrideNamesEveryGuardItSkips() throws Exception {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(BrokerSecurity.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getAuth().setAllowInsecureBind(true);
            properties.getSessionStore().setEnabled(true);
            properties.getHarness().setEnabled(true);
            properties.getHarness().setBaseUrl("http://10.0.0.9:4170");
            properties.getToolPublication().setEnabled(true);
            properties.getToolPublication()
                    .setServiceBaseUrl("http://10.0.0.10:4184");
            BrokerSecurity security = security(properties, "10.0.0.8");
            assertThat(security.getMode()).isEqualTo(BrokerSecurity.Mode.OPEN);
            assertThat(appender.list).anySatisfy(event -> assertThat(
                    event.getFormattedMessage())
                    .contains("skipped=")
                    .contains("public-bind")
                    .contains("internal-binding-key")
                    .contains("harness-transport")
                    .contains("publication-transport"));
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void autoRefusesNonLoopbackAndWildcardAddresses() throws Exception {
        for (String address : new String[] {"0.0.0.0", "10.0.0.8"}) {
            assertThatThrownBy(
                            () -> security(new ManagedAgentProperties(),
                                    address))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("auth.mode");
        }
        assertThatThrownBy(() -> security(new ManagedAgentProperties(), null))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void openRequiresLoopbackUnlessExplicitlyOverridden() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("open");
        assertThatThrownBy(() -> security(properties, "10.0.0.8"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("allow-insecure-bind");
        properties.getAuth().setAllowInsecureBind(true);
        assertThat(security(properties, "10.0.0.8").getMode())
                .isEqualTo(BrokerSecurity.Mode.OPEN);
    }

    @Test
    void signedRequiresAdequateKeyAndNoHeaderStandIn() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("signing-key");
        properties.getAuth().setSigningKey("short");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class);
        properties.getAuth().setSigningKey(KEY);
        properties.setTrustedActorHeader("X-E2E-Trusted-Actor");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("trusted-actor-header");
        properties.setTrustedActorHeader("");
        BrokerSecurity security = security(properties, "10.0.0.8");
        assertThat(security.getMode()).isEqualTo(BrokerSecurity.Mode.SIGNED);
        assertThat(security.getSigningKey()).hasSize(32);
    }

    @Test
    void rejectsAnUnknownMode() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("mtls");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("auto, open or signed");
    }

    @Test
    void internalSurfaceLeavingLoopbackRequiresTheBindingKey()
            throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        properties.getSessionStore().setEnabled(true);
        assertThatThrownBy(() -> security(properties, "10.0.0.8"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("binding-key");
        properties.getSessionStore().setBindingKey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assertThatCode(() -> security(properties, "10.0.0.8"))
                .doesNotThrowAnyException();

        ManagedAgentProperties dedicated = new ManagedAgentProperties();
        dedicated.getInternalServer().setPort(4183);
        dedicated.getInternalServer().setAddress("0.0.0.0");
        assertThatThrownBy(() -> security(dedicated, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("binding-key");
        dedicated.getInternalServer().setAddress("127.0.0.1");
        assertThatCode(() -> security(dedicated, "127.0.0.1"))
                .doesNotThrowAnyException();
        // A blank address (unset template variable) binds loopback, exactly
        // as the connector resolves it.
        dedicated.getInternalServer().setAddress("");
        assertThatCode(() -> security(dedicated, "127.0.0.1"))
                .doesNotThrowAnyException();

        ManagedAgentProperties publications = new ManagedAgentProperties();
        publications.getAuth().setMode("signed");
        publications.getAuth().setSigningKey(KEY);
        publications.getToolPublication().setEnabled(true);
        assertThatThrownBy(() -> security(publications, "10.0.0.8"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("binding-key");
    }

    @Test
    void refusesAnInternalPortEqualToThePublicPort() throws Exception {
        // Equal port numbers on different addresses bind two sockets, and
        // the port-based routing filter would serve /internal/** on the
        // public address.
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getInternalServer().setPort(8080);
        properties.getInternalServer().setAddress("127.0.0.1");
        ServerProperties server = new ServerProperties();
        server.setAddress(InetAddress.getByName("10.0.0.8"));
        server.setPort(8080);
        properties.getAuth().setAllowInsecureBind(true);
        assertThatThrownBy(() -> new BrokerSecurity(properties, server, new WebMvcProperties()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("internal-server.port");
        // An unset server.port is the Spring Boot default 8080.
        server.setPort(null);
        assertThatThrownBy(() -> new BrokerSecurity(properties, server, new WebMvcProperties()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("internal-server.port");
        properties.getInternalServer().setPort(8081);
        assertThatCode(() -> new BrokerSecurity(properties, server, new WebMvcProperties()))
                .doesNotThrowAnyException();
    }

    @Test
    void refusesASubSecondSignatureDrift() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setAllowedDrift(
                java.time.Duration.ofMillis(500));
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("allowed-drift");
    }

    @Test
    void refusesALoopbackStoreUrlMissingTheInternalPort() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setEnabled(true);
        properties.getSessionStore().setBaseUrl("http://127.0.0.1:8080");
        properties.getInternalServer().setPort(4183);
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("base-url");
        properties.getSessionStore()
                .setBaseUrl("http://127.0.0.1:4183");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
    }

    @Test
    void refusesAPlaintextNonLoopbackHarnessUrl() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setBaseUrl("http://10.0.0.9:4170");
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("harness.base-url");
        properties.getHarness().setBaseUrl("https://harness.internal:4170");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
        properties.getHarness().setBaseUrl("http://10.0.0.9:4170");
        properties.getAuth().setAllowInsecureBind(true);
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
        // Abbreviated loopback spellings the client accepts (URI.getHost is
        // null for them, so the authority fallback must classify them).
        properties.getAuth().setAllowInsecureBind(false);
        properties.getHarness().setBaseUrl("http://127.1:4170");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
    }

    @Test
    void refusesReusingTheSigningKeyAsTheBindingKey() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey(KEY);
        properties.getSessionStore().setBindingKey(KEY);
        assertThatThrownBy(() -> security(properties, "127.0.0.1"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("must differ");
        properties.getSessionStore().setBindingKey(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assertThatCode(() -> security(properties, "127.0.0.1"))
                .doesNotThrowAnyException();
    }

    @Test
    void classifiesLoopbackAddresses() {
        for (String loopback : new String[] {"127.0.0.1", "127.1.2.3",
                "localhost", "LOCALHOST", "::1", "[::1]",
                "0:0:0:0:0:0:0:1"}) {
            assertThat(BrokerSecurity.isLoopback(loopback)).isTrue();
        }
        // Only resolver-independent negatives: a hostname lookup answers
        // whatever the runner's resolver says (a catch-all resolver maps
        // anything to loopback, which is then genuinely loopback).
        for (String remote : new String[] {"0.0.0.0", "10.0.0.8",
                "192.168.1.1", "", " "}) {
            assertThat(BrokerSecurity.isLoopback(remote)).isFalse();
        }
        assertThat(BrokerSecurity.isLoopback(null)).isFalse();
    }

    private static BrokerSecurity security(ManagedAgentProperties properties,
            String address) throws Exception {
        ServerProperties server = new ServerProperties();
        server.setAddress(address == null ? null
                : InetAddress.getByName(address));
        return new BrokerSecurity(properties, server, new WebMvcProperties());
    }
}
