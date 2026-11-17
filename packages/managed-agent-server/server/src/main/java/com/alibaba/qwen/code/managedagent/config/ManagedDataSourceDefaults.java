package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;

import java.util.List;

/**
 * The MySQL defaults every managed pool applies once its URL and credentials are
 * bound: strict session mode and the Connector/J statement cache. Schema admission
 * requires strict mode, so applying it here keeps the standalone, embedded and
 * maintenance pools uniform instead of leaving each caller to configure it.
 */
public final class ManagedDataSourceDefaults {
    private ManagedDataSourceDefaults() {
    }

    /** Call after the pool's URL and connection properties are bound. */
    public static void applyMySqlDefaults(DruidDataSource source) {
        String url = source.getUrl();
        if (url != null && (url.startsWith("jdbc:mysql:") || url.startsWith("jdbc:mariadb:"))) {
            source.setConnectionInitSqls(List.of("SET SESSION sql_mode ="
                    + " CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES')"));
        }
        MySqlStatementCache.fillDefaults(source);
    }
}
