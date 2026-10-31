package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestContext;
import org.springframework.test.context.TestExecutionListeners;
import org.springframework.test.context.support.AbstractTestExecutionListener;
import org.springframework.test.context.support.DirtiesContextTestExecutionListener;

@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@TestExecutionListeners(listeners = EventTransportConsumerMySqlIT.OwnedDatabaseCleanup.class,
        mergeMode = TestExecutionListeners.MergeMode.MERGE_WITH_DEFAULTS)
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

    static class OwnedDatabaseCleanup extends AbstractTestExecutionListener {
        @Override
        public int getOrder() {
            // After-class listeners run in reverse order: stop Spring before dropping its database.
            return DirtiesContextTestExecutionListener.ORDER - 1;
        }

        @Override
        public void afterTestClass(TestContext testContext) {
            if (database != null) {
                database.close();
            }
        }
    }
}
