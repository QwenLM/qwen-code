package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The tool-publication surface funnels every writer-credential check through
 * {@code ManagedSessionStore.lockPublicationWriter}; with a bound policy a
 * self-minted token is refused before any state lookup.
 */
class ManagedSessionStoreCredentialTest {
    private static final String KEY = "0123456789abcdef0123456789abcdef";

    @ParameterizedTest
    @CsvSource({"ordinary", "lifecycle", "acquire", "renew", "seal", "commit"})
    void lifecycleWriterPathsRefuseForeignCredentialsBeforeStateLookup(String route) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.getDataSource()).thenReturn(new JdbcDataSource());
        ManagedSessionStore store = new ManagedSessionStore(jdbc);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey(KEY);
        WriterCredentialPolicy policy = new WriterCredentialPolicy(properties);
        store.setCredentials(policy);
        reset(jdbc);

        for (String token : new String[]{null, "self-minted-token-self-minted-token-0",
                policy.issue("foreign-tenant", "workspace", "session"),
                policy.issue("tenant", "foreign-workspace", "session"),
                policy.issue("tenant", "workspace", "foreign-session")}) {
            assertThatThrownBy(() -> invokeWriterPath(store, route, token))
                    .isInstanceOfSatisfying(ApiException.class, error -> {
                        assertThat(error.getStatus().value()).isEqualTo(403);
                        assertThat(error.getCode()).isEqualTo("writer_credential_invalid");
                    });
            verifyNoInteractions(jdbc);
        }
    }

    private static void invokeWriterPath(ManagedSessionStore store, String route, String token) {
        var authority = new com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority("operation", 1);
        switch (route) {
            case "ordinary" -> store.authorizeOrdinary("tenant", "session", token,
                    new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "writer", 1));
            case "lifecycle" -> store.authorizeLifecycle("tenant", "session", token,
                    new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "writer", 1), authority);
            case "acquire" -> store.acquireWriter("tenant", "session", token,
                    new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L), authority);
            case "renew" -> store.renewWriter("tenant", "session", token,
                    new ManagedSessionStoreModels.RenewWriterRequest("workspace", "writer", 1, 60_000L), authority);
            case "seal" -> store.sealWriter("tenant", "session", token,
                    new ManagedSessionStoreModels.SealWriterRequest("workspace", "writer", 1), authority);
            case "commit" -> store.commit("tenant", "session", token,
                    new ManagedSessionStoreModels.CommitTransactionRequest("workspace", "writer", 1, 0, 0,
                            "transaction", "operation", "command", "0".repeat(64), 0, 0, 0, null, null, null,
                            0, null, 1, "", "0".repeat(64), java.util.List.of()), authority);
            default -> throw new IllegalArgumentException(route);
        }
    }

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
