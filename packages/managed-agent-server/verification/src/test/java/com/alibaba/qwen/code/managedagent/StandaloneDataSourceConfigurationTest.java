package com.alibaba.qwen.code.managedagent;

import com.alibaba.druid.pool.DruidDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.ConfigurationPropertiesBean;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.mock.env.MockEnvironment;

import java.util.Map;

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

    @Autowired
    ApplicationContext context;

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

    @Test
    void standaloneBeanFillsStatementCacheDefaultsAfterItsDruidSettings() {
        // The string form replaces every connection property, so a default added
        // before the Druid settings were bound would be gone.
        try (DruidDataSource mysql = new ManagedAgentServerApplication().standaloneDataSource(new MockEnvironment()
                .withProperty("spring.datasource.url", "jdbc:mysql://db/qwen?prepStmtCacheSqlLimit=4096")
                .withProperty("spring.datasource.druid.max-active", "3")
                .withProperty("spring.datasource.druid.connection-properties", "prepStmtCacheSize=64;connectTimeout=5000"))) {
            assertThat(mysql.getMaxActive()).isEqualTo(3);
            assertThat(mysql.getUrl()).isEqualTo("jdbc:mysql://db/qwen?prepStmtCacheSqlLimit=4096");
            assertThat(Map.copyOf(mysql.getConnectProperties())).isEqualTo(Map.of(
                    "prepStmtCacheSize", "64", "connectTimeout", "5000", "cachePrepStmts", "true"));
            assertThat(mysql.isInited()).isFalse();
        }
        assertThat(source.getConnectProperties()).doesNotContainKey("cachePrepStmts");
        // Spring would bind a @ConfigurationProperties bean again after its factory
        // returned, and the string form would drop the defaults.
        assertThat(ConfigurationPropertiesBean.getAll(context)).doesNotContainKey("managedAgentDataSource");
    }
}
