package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.flywaydb.core.Flyway;
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

    @Test
    void publicationWriterLockAdmitsTheIssuedCredential() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:credential-accept;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        ManagedSessionStore store = new ManagedSessionStore(
                new JdbcTemplate(dataSource));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey(KEY);
        WriterCredentialPolicy policy = new WriterCredentialPolicy(properties);
        store.setCredentials(policy);

        // Any outcome other than the credential refusal means the issued
        // credential passed the gate; the session itself does not exist.
        try {
            store.lockPublicationWriter("tenant", "workspace", "session",
                    "writer", 1,
                    policy.issue("tenant", "workspace", "session"));
        } catch (ApiException error) {
            assertThat(error.getCode())
                    .isNotEqualTo("writer_credential_invalid");
        }
    }
}
