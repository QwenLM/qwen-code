package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.web.ServerProperties;

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
        assertThatThrownBy(() -> new BrokerSecurity(properties, server))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("context-path");
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
        properties.getSessionStore().setBindingKey(KEY);
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

        ManagedAgentProperties publications = new ManagedAgentProperties();
        publications.getAuth().setMode("signed");
        publications.getAuth().setSigningKey(KEY);
        publications.getToolPublication().setEnabled(true);
        assertThatThrownBy(() -> security(publications, "10.0.0.8"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("binding-key");
    }

    @Test
    void classifiesLoopbackAddresses() {
        for (String loopback : new String[] {"127.0.0.1", "127.1.2.3",
                "localhost", "LOCALHOST", "::1", "[::1]",
                "0:0:0:0:0:0:0:1"}) {
            assertThat(BrokerSecurity.isLoopback(loopback)).isTrue();
        }
        for (String remote : new String[] {"0.0.0.0", "10.0.0.8",
                "192.168.1.1", "127.example.com", "example.invalid", "",
                " "}) {
            assertThat(BrokerSecurity.isLoopback(remote)).isFalse();
        }
        assertThat(BrokerSecurity.isLoopback(null)).isFalse();
    }

    private static BrokerSecurity security(ManagedAgentProperties properties,
            String address) throws Exception {
        ServerProperties server = new ServerProperties();
        server.setAddress(address == null ? null
                : InetAddress.getByName(address));
        return new BrokerSecurity(properties, server);
    }
}
