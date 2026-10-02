package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The tool-publication surface funnels every writer-credential check through
 * {@code ManagedSessionStore.lockPublicationWriter}; with a bound policy a
 * self-minted token is refused before any state lookup.
 */
class ManagedSessionStoreCredentialTest {
    private static final String KEY = "0123456789abcdef0123456789abcdef";

    @Test
    void publicationWriterLockRequiresTheBoundCredential() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:credential-check;MODE=MySQL");
        ManagedSessionStore store = new ManagedSessionStore(
                new JdbcTemplate(dataSource));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey(KEY);
        store.setCredentials(new WriterCredentialPolicy(properties));

        assertThatThrownBy(() -> store.lockPublicationWriter("tenant",
                "workspace", "session", "writer", 1,
                "self-minted-token-self-minted-token-0"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus().value()).isEqualTo(403);
                    assertThat(error.getCode())
                            .isEqualTo("writer_credential_invalid");
                });
    }
}
