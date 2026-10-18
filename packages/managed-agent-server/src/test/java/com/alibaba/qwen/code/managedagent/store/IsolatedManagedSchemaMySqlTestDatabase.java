package com.alibaba.qwen.code.managedagent.store;

import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.sql.SQLException;
import java.util.UUID;

/** Each test owns one database; no existing test or application tables are cleared. */
public final class IsolatedManagedSchemaMySqlTestDatabase implements AutoCloseable {
    private final DriverManagerDataSource admin;
    private final String name;
    private final String url;
    private final DataSource source;

    public IsolatedManagedSchemaMySqlTestDatabase() {
        String url = System.getProperty("mysql.url");
        String user = System.getProperty("mysql.user");
        if (url == null || user == null || !url.startsWith("jdbc:mysql://")) {
            throw new IllegalStateException("mysql.url and mysql.user are required for the isolated MySQL test");
        }
        String password = System.getProperty("mysql.password", "");
        int query = url.indexOf('?');
        String location = query < 0 ? url : url.substring(0, query);
        String options = query < 0 ? "" : url.substring(query);
        name = "schema32_case_" + UUID.randomUUID().toString().replace("-", "");
        admin = new DriverManagerDataSource(url, user, password);
        this.url = location.substring(0, location.lastIndexOf('/') + 1) + name + options;
        source = new DriverManagerDataSource(this.url, user, password);
        try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        } catch (SQLException error) {
            throw new IllegalStateException("Cannot create isolated MySQL test database", error);
        }
    }

    public DataSource source() {
        return source;
    }

    /** The JDBC URL of the owned database, for a process that opens its own pool. */
    public String url() {
        return url;
    }

    @Override
    public void close() {
        try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
            statement.execute("DROP DATABASE `" + name + "`");
        } catch (SQLException error) {
            throw new IllegalStateException("Cannot remove owned MySQL test database", error);
        }
    }
}
