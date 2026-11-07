package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.AfterEach;

import javax.sql.DataSource;

import java.util.ArrayList;
import java.util.List;

class SharedLocalProjectsMySqlIT extends SharedLocalProjectsTest {
    private final List<IsolatedManagedSchemaMySqlTestDatabase> databases = new ArrayList<>();

    @Override
    protected DataSource dataSource() {
        var database = new IsolatedManagedSchemaMySqlTestDatabase();
        databases.add(database);
        return database.source();
    }

    @AfterEach
    void closeDatabases() {
        databases.forEach(IsolatedManagedSchemaMySqlTestDatabase::close);
    }
}
