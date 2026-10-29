package com.alibaba.qwen.code.managedagent;

import com.alibaba.druid.pool.DruidDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:standalone-pool-binding;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "spring.datasource.druid.max-active=3",
        "spring.datasource.druid.max-wait=5000",
        "spring.datasource.druid.connect-properties.connectTimeout=5000",
        "spring.datasource.druid.connect-properties.socketTimeout=10000",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.runtime-broker.enabled=false"
})
class StandaloneDataSourceConfigurationTest {
    @Autowired
    @Qualifier("managedAgentDataSource")
    DruidDataSource source;

    @Test
    void standaloneBeanBindsCommonAndDruidSettingsBeforeOpeningThePool() {
        assertThat(source.getUrl()).startsWith("jdbc:h2:mem:standalone-pool-binding;");
        assertThat(source.getUsername()).isEqualTo("sa");
        assertThat(source.getPassword()).isEmpty();
        assertThat(source.getMaxActive()).isEqualTo(3);
        assertThat(source.getMaxWait()).isEqualTo(5000);
        assertThat(source.getConnectProperties().getProperty("connectTimeout")).isEqualTo("5000");
        assertThat(source.getConnectProperties().getProperty("socketTimeout")).isEqualTo("10000");
        assertThat(source.isInited()).isTrue();
    }
}
