package com.alibaba.qwen.code.managedagent.config;

import java.time.Clock;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ExecutionConfiguration {
    @Bean
    public Clock managedAgentClock() {
        return Clock.systemUTC();
    }

    @Bean(destroyMethod = "close")
    public ExecutorService managedAgentExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}
