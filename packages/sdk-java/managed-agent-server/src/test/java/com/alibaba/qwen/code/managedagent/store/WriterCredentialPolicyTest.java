package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import org.junit.jupiter.api.Test;

class WriterCredentialPolicyTest {
    private static final String KEY = "0123456789abcdef0123456789abcdef";

    @Test
    void unboundKeepsFirstWriterWins() {
        WriterCredentialPolicy policy = WriterCredentialPolicy.unbound();
        assertThat(policy.isBound()).isFalse();
        assertThatThrownBy(() -> policy.issue("tenant", "workspace", "s"))
                .isInstanceOf(IllegalStateException.class);
        assertThatCode(() -> policy.require("tenant", "workspace", "s",
                "anything-at-all")).doesNotThrowAnyException();
        assertThatCode(() -> policy.require("tenant", "workspace", "s", null))
                .doesNotThrowAnyException();
    }

    @Test
    void boundIssuesDeterministicScopeCredentials() {
        WriterCredentialPolicy policy = policy(KEY);
        assertThat(policy.isBound()).isTrue();
        String token = policy.issue("tenant", "workspace", "session");
        assertThat(token).startsWith("qwt1_").hasSize(48)
                .matches("^[A-Za-z0-9_-]{32,512}$");
        assertThat(policy.issue("tenant", "workspace", "session"))
                .isEqualTo(token);
        assertThat(policy.issue("tenant", "workspace", "other"))
                .isNotEqualTo(token);
        assertThat(policy(KEY).issue("tenant", "workspace", "session"))
                .isEqualTo(token);
        assertThat(policy("ffffffffffffffffffffffffffffffff")
                .issue("tenant", "workspace", "session")).isNotEqualTo(token);
    }

    @Test
    void rejectsAWeakBindingKey() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey("short");
        assertThatThrownBy(() -> new WriterCredentialPolicy(properties))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("binding-key");
    }

    @Test
    void boundRejectsForeignAndSelfMintedTokens() {
        WriterCredentialPolicy policy = policy(KEY);
        String token = policy.issue("tenant", "workspace", "session");
        assertThatCode(() -> policy.require("tenant", "workspace", "session",
                token)).doesNotThrowAnyException();
        assertThatThrownBy(() -> policy.require("tenant", "workspace",
                "session", "self-minted-token-self-minted-token-0"))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus().value()).isEqualTo(403);
                    assertThat(error.getCode())
                            .isEqualTo("writer_credential_invalid");
                });
        assertThatThrownBy(() -> policy.require("tenant", "workspace",
                "other", token)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> policy.require("tenant", "other-workspace",
                "session", token)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> policy.require("other", "workspace",
                "session", token)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> policy.require("tenant", "workspace",
                "session", null)).isInstanceOf(ApiException.class);
    }

    private static WriterCredentialPolicy policy(String key) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey(key);
        return new WriterCredentialPolicy(properties);
    }
}
