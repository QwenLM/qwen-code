package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.SecretProtector;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:runtime-broker-config;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.harness.capability-digest=sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "qwen.managed-agent.runtime-broker.enabled=true",
        "qwen.managed-agent.runtime-broker.host=127.0.0.1",
        "qwen.managed-agent.runtime-broker.port=0",
        "qwen.managed-agent.runtime-broker.token=broker-token",
        "qwen.managed-agent.runtime-broker.credential-key-id=test-key",
        "qwen.managed-agent.runtime-broker.credential-key="
                + "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        "qwen.managed-agent.runtime-broker.previous-credential-keys.previous-key="
                + "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        "qwen.managed-agent.runtime-broker.provisioner=static",
        "qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false",
        "qwen.managed-agent.runtime-broker.workspace-id=workspace",
        "qwen.managed-agent.runtime-broker.workspace-cwd=workspace",
        "qwen.managed-agent.runtime-broker.isolation-class=workspace",
        "qwen.managed-agent.runtime-broker.static-endpoint=http://127.0.0.1:9",
        "qwen.managed-agent.runtime-broker.static-token=runtime-token"
})
class RuntimeBrokerConfigurationIntegrationTest {
    @Autowired
    private RuntimeWarmer runtimeWarmer;
    @Autowired
    private RuntimeBindingRepository bindingRepository;
    @Autowired
    private RuntimeSessionRepository sessionRepository;
    @Autowired
    private ToolExecutionRepository executionRepository;
    @Autowired
    private SecretProtector secretProtector;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private org.springframework.context.ApplicationContext context;

    @Test
    void recoveryTickRunsOnADedicatedScheduler() throws Exception {
        assertThat(context.containsBean("runtimeRecoveryScheduler")).isTrue();
        assertThat(context.getBean("runtimeRecoveryScheduler"))
                .isNotSameAs(context.getBean("taskScheduler"));
        var scheduled = EmbeddedRuntimeBroker.class.getMethod("recoverSavedRuntimes")
                .getAnnotation(org.springframework.scheduling.annotation.Scheduled.class);
        assertThat(scheduled.scheduler()).isEqualTo("runtimeRecoveryScheduler");
    }

    @Test
    void selectsTheEmbeddedBrokerAsTheRuntimeWarmer() {
        assertThat(runtimeWarmer).isInstanceOf(EmbeddedRuntimeBroker.class);
        assertThat(bindingRepository)
                .isInstanceOf(JdbcRuntimeBindingRepository.class);
        assertThat(sessionRepository)
                .isInstanceOf(JdbcRuntimeSessionRepository.class);
        assertThat(executionRepository)
                .isInstanceOf(JdbcToolExecutionRepository.class);
        assertThat(secretProtector).isNotNull();
        assertThat(columnCount("provision_seed_ciphertext")).isEqualTo(1);
        assertThat(columnCount("runtime_credential_ciphertext")).isEqualTo(1);
        assertThat(columnCount("runtime_token")).isZero();
    }

    @Test
    void decryptsCredentialsWrittenWithAConfiguredPreviousKey() {
        byte[] previousKey = new byte[32];
        Arrays.fill(previousKey, (byte) 2);
        byte[] plaintext = "previous-runtime-secret"
                .getBytes(StandardCharsets.UTF_8);
        var encrypted = new AesGcmSecretProtector("previous-key", previousKey)
                .protect("binding-1", plaintext);

        assertThat(secretProtector.unprotect("binding-1", encrypted))
                .containsExactly(plaintext);
        assertThat(secretProtector.protect("binding-2", plaintext).getKeyId())
                .isEqualTo("test-key");
    }

    private Integer columnCount(String columnName) {
        return jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM information_schema.columns "
                        + "WHERE table_name = 'ma_runtime_binding' "
                        + "AND column_name = ?",
                Integer.class, columnName);
    }
}
