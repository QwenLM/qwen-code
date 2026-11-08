package com.alibaba.qwen.code.managedagent.persistence;

import org.h2.jdbcx.JdbcDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.util.UUID;

/** The explicit port enables task-local MySQL tests with a new owned database per test. */
final class ConsolidatedStoreFixture implements AutoCloseable {
    private final DataSource source;
    private final JdbcTemplate administrator;
    private final String database;

    private ConsolidatedStoreFixture(DataSource source, JdbcTemplate administrator, String database) {
        this.source = source;
        this.administrator = administrator;
        this.database = database;
    }

    static ConsolidatedStoreFixture open(String subsystem) {
        String name = "managed_schema_" + subsystem + "_" + UUID.randomUUID().toString().replace("-", "");
        String port = System.getProperty("managed.schema.mysql.port");
        if (port == null) {
            JdbcDataSource source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:" + name + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            return new ConsolidatedStoreFixture(source, null, null);
        }
        int number = Integer.parseInt(port);
        if (number < 1 || number > 65535 || number == 3306) {
            throw new IllegalArgumentException("An explicit isolated MySQL port is required");
        }
        String root = "jdbc:mysql://127.0.0.1:" + number + "/";
        String options = "?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC";
        JdbcTemplate administrator = new JdbcTemplate(new DriverManagerDataSource(root + options, "root", ""));
        administrator.execute("CREATE DATABASE " + name);
        DataSource source = new DriverManagerDataSource(root + name + options, "root", "");
        return new ConsolidatedStoreFixture(source, administrator, name);
    }

    DataSource source() {
        return source;
    }

    @Override
    public void close() {
        if (administrator != null) {
            administrator.execute("DROP DATABASE " + database);
        }
    }
}
