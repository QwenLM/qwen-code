package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.druid.pool.DruidDataSource;
import java.net.URI;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Assumptions;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Creates and drops only a fresh, explicitly named O4 test database. */
final class O4MySqlDatabase implements AutoCloseable {
    private final JdbcTemplate admin;
    private final String database;
    private final String url;
    private final String user;
    private final DruidDataSource source;

    O4MySqlDatabase() {
        String base = System.getProperty("qwen.o4.mysql.url");
        if (!Boolean.getBoolean("qwen.o4.required")) { Assumptions.assumeTrue(base != null, "O4 MySQL not configured"); }
        validateUrl(base);
        database = "qwen_o4_" + UUID.randomUUID().toString().replace("-", "");
        user = System.getProperty("qwen.o4.mysql.user", "root");
        String password = System.getenv().getOrDefault("QWEN_O4_MYSQL_PASSWORD", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(base, user, password));
        admin.execute("CREATE DATABASE `" + database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        url = databaseUrl(base, database);
        try {
            var config = new DruidDataSource();
            config.setUrl(url);
            config.setUsername(user);
            config.setPassword(password);
            config.setMaxActive(4);
            source = config;
        } catch (RuntimeException error) {
            try { admin.execute("DROP DATABASE `" + database + "`"); }
            catch (RuntimeException cleanup) { error.addSuppressed(cleanup); }
            throw error;
        }
    }

    static void validateUrl(String base) {
        URI uri;
        try {
            if (base == null || !base.startsWith("jdbc:mysql://")) { throw new IllegalArgumentException(); }
            uri = URI.create(base.substring(5));
        } catch (IllegalArgumentException error) { throw invalidUrl(); }
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                || uri.getPort() == 0 || uri.getPort() > 65535
                || uri.getRawPath() == null || !uri.getRawPath().matches("/qwen_o4_[a-zA-Z0-9_]+")) {
            throw invalidUrl();
        }
        if (uri.getRawQuery() != null) {
            var allowed = Set.of("allowPublicKeyRetrieval", "useSSL", "sslMode", "characterEncoding", "connectTimeout", "socketTimeout");
            for (String option : uri.getRawQuery().split("&", -1)) {
                String[] pair = option.split("=", 2);
                if (pair.length != 2 || !allowed.contains(pair[0]) || !pair[1].matches("[a-zA-Z0-9_.-]+")) {
                    throw invalidUrl();
                }
            }
        }
    }

    static String databaseUrl(String base, String database) {
        int query = base.indexOf('?');
        String address = query < 0 ? base : base.substring(0, query);
        return address.substring(0, address.lastIndexOf('/') + 1) + database + (query < 0 ? "" : base.substring(query));
    }

    private static IllegalArgumentException invalidUrl() {
        return new IllegalArgumentException("O4 requires a dedicated qwen_o4_ MySQL URL with only supported connection options");
    }

    DataSource source() { return source; }
    String url() { return url; }
    String user() { return user; }
    @Override public void close() {
        source.close();
        admin.execute("DROP DATABASE `" + database + "`");
    }
}
