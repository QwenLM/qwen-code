package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.preflight.ManagedAgentPreflight;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.util.Arrays;

@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class ManagedAgentServerApplication {
    public static void main(String[] args) {
        if (Arrays.asList(args).contains("--check")) {
            System.exit(ManagedAgentPreflight.run(args));
        }
        SpringApplication.run(ManagedAgentServerApplication.class, args);
    }
}
