package com.alibaba.qwen.code.managedagent;

import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {
        "spring.datasource.url=${mysql.url}",
        "spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
        "spring.datasource.username=${mysql.user}",
        "spring.datasource.password=${mysql.password:}",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedApprovalChangeMySqlIT extends ManagedApprovalChangeTest {
}
