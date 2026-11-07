package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.util.Map;
import java.util.Properties;

import static org.assertj.core.api.Assertions.assertThat;

class MySqlStatementCacheTest {
    private static final Map<String, String> ALL = Map.of(
            "cachePrepStmts", "true", "prepStmtCacheSize", "512", "prepStmtCacheSqlLimit", "8192");

    @Test
    void aMySqlPoolGetsEveryDefault() {
        assertThat(filled("jdbc:mysql://db:3306/qwen_managed_agent", new Properties())).isEqualTo(ALL);
        assertThat(filled("jdbc:mysql://db:3306/qwen_managed_agent?useSSL=false", new Properties())).isEqualTo(ALL);
        assertThat(filled("jdbc:mysql:loadbalance://a,b/qwen_managed_agent", new Properties())).isEqualTo(ALL);
        assertThat(filled("jdbc:mysql+srv://cluster/qwen_managed_agent", new Properties())).isEqualTo(ALL);
    }

    @Test
    void aSettingTheUrlNamesKeepsItsValueInAnyCaseOrPlace() {
        assertThat(filled("jdbc:mysql://db/qwen?CachePrepStmts=false", new Properties())).isEqualTo(Map.of(
                "prepStmtCacheSize", "512", "prepStmtCacheSqlLimit", "8192"));
        assertThat(filled("jdbc:mysql://address=(host=db)(port=3306)(prepstmtcachesize=64)/qwen", new Properties()))
                .isEqualTo(Map.of("cachePrepStmts", "true", "prepStmtCacheSqlLimit", "8192"));
        // Connector/J decodes percent escapes in names before it reads them.
        assertThat(filled("jdbc:mysql://db/qwen?%63achePrepStmts=false", new Properties())).isEqualTo(Map.of(
                "prepStmtCacheSize", "512", "prepStmtCacheSqlLimit", "8192"));
        // A fragment is not decoded, so a stray escape in it does not hide the name.
        assertThat(filled("jdbc:mysql://db/qwen?prepStmt%43acheSize=16#50%", new Properties())).isEqualTo(Map.of(
                "cachePrepStmts", "true", "prepStmtCacheSqlLimit", "8192"));
    }

    @Test
    void aSettingTheConnectionPropertiesNameKeepsItsValue() {
        var properties = new Properties();
        properties.setProperty("connectTimeout", "5000");
        properties.setProperty("PREPSTMTCACHESQLLIMIT", "2048");
        assertThat(filled("jdbc:mysql://db/qwen", properties)).isEqualTo(Map.of(
                "connectTimeout", "5000", "PREPSTMTCACHESQLLIMIT", "2048",
                "cachePrepStmts", "true", "prepStmtCacheSize", "512"));
        // Druid keeps the space after a separator in the name.
        var source = new DruidDataSource();
        source.setUrl("jdbc:mysql://db/qwen");
        source.setConnectionProperties("connectTimeout=5000; cachePrepStmts=false");
        MySqlStatementCache.fillDefaults(source);
        assertThat(Map.copyOf(source.getConnectProperties())).isEqualTo(Map.of(
                "connectTimeout", "5000", " cachePrepStmts", "false",
                "prepStmtCacheSize", "512", "prepStmtCacheSqlLimit", "8192"));
    }

    @Test
    void serverSideStatementsInEitherPlaceGetNoDefaults() {
        assertThat(filled("jdbc:mysql://db/qwen?useServerPrepStmts=true", new Properties())).isEmpty();
        var properties = new Properties();
        properties.setProperty("useServerPrepStmts", "false");
        assertThat(filled("jdbc:mysql://db/qwen", properties)).isEqualTo(Map.of("useServerPrepStmts", "false"));
        // A cursor fetch turns server-side statements on.
        assertThat(filled("jdbc:mysql://db/qwen?useCursorFetch=true", new Properties())).isEmpty();
        var cursor = new Properties();
        cursor.setProperty("useCursorFetch", "true");
        assertThat(filled("jdbc:mysql://db/qwen", cursor)).isEqualTo(Map.of("useCursorFetch", "true"));
    }

    @Test
    void anotherDriverGetsNoDefaults() {
        assertThat(filled("jdbc:h2:mem:qwen;MODE=MySQL", new Properties())).isEmpty();
        assertThat(filled("jdbc:mariadb://db/qwen", new Properties())).isEmpty();
        var source = new DruidDataSource();
        MySqlStatementCache.fillDefaults(source);
        assertThat(source.getConnectProperties()).isEmpty();
    }

    @Test
    void theEmbeddedPoolGetsTheDefaults() {
        try (DruidDataSource source = new ManagedAgentPersistenceConfiguration().managedAgentDataSource(
                new MockEnvironment().withProperty("qwen.managed-agent.datasource.url", "jdbc:mysql://db/qwen"))) {
            assertThat(Map.copyOf(source.getConnectProperties())).isEqualTo(ALL);
            assertThat(source.isInited()).isFalse();
        }
    }

    private static Map<Object, Object> filled(String url, Properties properties) {
        var source = new DruidDataSource();
        source.setUrl(url);
        source.setConnectProperties(properties);
        MySqlStatementCache.fillDefaults(source);
        return Map.copyOf(source.getConnectProperties());
    }
}
