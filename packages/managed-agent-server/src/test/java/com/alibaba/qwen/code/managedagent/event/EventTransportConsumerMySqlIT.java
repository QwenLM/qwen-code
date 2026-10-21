package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterAll;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class EventTransportConsumerMySqlIT extends EventTransportConsumerSqlTest {
    private static IsolatedManagedSchemaMySqlTestDatabase database;

    @DynamicPropertySource
    static void nativeDatabase(DynamicPropertyRegistry registry) {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        var source = (DriverManagerDataSource) database.source();
        registry.add("spring.datasource.url", source::getUrl);
        registry.add("spring.datasource.username", source::getUsername);
        registry.add("spring.datasource.password", source::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "com.mysql.cj.jdbc.Driver");
    }

    @AfterAll
    static void removeOwnedDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
