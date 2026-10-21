package com.alibaba.qwen.code.managedagent;

import org.springframework.test.context.TestPropertySource;

/**
 * D7-3: the whole contract suite again with the java_durable admission
 * profile enabled, on its own database. Every default admission must answer
 * exactly as with the profile off, and the profile's own case runs here.
 */
@TestPropertySource(properties = {
        "qwen.managed-agent.java-durable-admission.enabled=true",
        "spring.datasource.url=jdbc:h2:mem:managed-agent-contract-durable;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
})
class JavaDurableAdmissionContractTest extends ManagedAgentApiContractTest {
}
