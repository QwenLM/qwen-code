package com.alibaba.qwen.code.managedagent;

import org.springframework.boot.test.context.SpringBootTest;

/**
 * The inherited-extension reads on real MySQL. #17261 was a committed-state predicate the record
 * reader restated in SQL, so the H2 arm alone cannot establish it: the kind column is VARBINARY and
 * the two engines do not compare it identically, which is exactly why the old SQL bound the kind
 * names as identities instead of literals. This run proves the coarse SQL filter plus the shared
 * Java predicate answer the same question on the production engine.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=${mysql.url}",
        "spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
        "spring.datasource.username=${mysql.user}",
        "spring.datasource.password=${mysql.password:}",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedInheritedExtensionConfigurationMySqlIT
        extends ManagedInheritedExtensionConfigurationTest {
}
