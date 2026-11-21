package com.alibaba.qwen.code.managedagent;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

class ManagedSessionModelConfigMySqlIT extends ManagedSessionModelConfigTest {
    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.startsWith("jdbc:mysql://")) {
            throw new IllegalArgumentException("A disposable MySQL test database URL is required");
        }
        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> System.getProperty("mysql.user", "root"));
        registry.add("spring.datasource.password", () -> System.getProperty("mysql.password", ""));
        registry.add("spring.datasource.driver-class-name", () -> "com.mysql.cj.jdbc.Driver");
    }
}
