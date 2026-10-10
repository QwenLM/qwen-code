package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class O4MySqlDatabaseTest {
    @ParameterizedTest
    @ValueSource(strings = {
            "jdbc:mysql://127.0.0.1:3306/qwen_o4_seed",
            "jdbc:mysql://[::1]:3306/qwen_o4_seed",
            "jdbc:mysql://db.internal/qwen_o4_seed?allowPublicKeyRetrieval=true&useSSL=false",
            "jdbc:mysql://db.internal/qwen_o4_seed?sslMode=VERIFY_IDENTITY&characterEncoding=UTF-8&connectTimeout=5000&socketTimeout=10000"
    })
    void acceptsSafeConnectionOptionsAndPreservesThemForTheOwnedDatabase(String url) {
        assertThatCode(() -> O4MySqlDatabase.validateUrl(url)).doesNotThrowAnyException();
        assertThat(O4MySqlDatabase.databaseUrl(url, "qwen_o4_owned"))
                .isEqualTo(url.replace("qwen_o4_seed", "qwen_o4_owned"));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "jdbc:mysql://127.0.0.1/production",
            "jdbc:mysql://user:secret@127.0.0.1/qwen_o4_seed",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed?user=secret",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed?password=secret",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed?authenticationPlugins=secret",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed#secret",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed?useSSL=false&",
            "jdbc:mysql://127.0.0.1/qwen_o4_seed?useSSL=secret%26password%3Dsecret"
    })
    void rejectsUnsafeAddressesWithoutEchoingTheirContents(String url) {
        assertThatThrownBy(() -> O4MySqlDatabase.validateUrl(url))
                .isInstanceOf(IllegalArgumentException.class).hasMessageNotContaining("secret");
    }
}
