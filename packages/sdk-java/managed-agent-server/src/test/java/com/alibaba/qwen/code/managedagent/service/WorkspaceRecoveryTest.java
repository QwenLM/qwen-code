package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-recovery;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class WorkspaceRecoveryTest {
    @Autowired private DataSource source;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ManagedAgentStore store;
    @Autowired private WorkspaceExecutionStore authority;

    @Test
    void cleanupUsesOriginalPhysicalOwnershipAndFencesLateAcquisition() throws Exception {
        WorkspaceRecoveryContract.verify(source, jdbc, store, authority);
    }
}
