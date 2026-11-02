package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.SshConnections;
import org.springframework.boot.SpringApplication;

import java.util.Arrays;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.TreeSet;

/** Loaded from a single copied class, with dependencies supplied only by the tested executable. */
public final class RuntimeArtifactProbe {
    private RuntimeArtifactProbe() {
    }

    public static void main(String[] args) throws Exception {
        var factories = Map.of(
                "external", "external.ExternalRuntimeProviderFactory",
                "kubernetes", "kubernetes.KubernetesRuntimeProviderFactory",
                "local", "local.LocalRuntimeProviderFactory",
                "ssh", "ssh.SshRuntimeProviderFactory",
                "static", "staticruntime.StaticRuntimeProviderFactory");
        var expected = new TreeSet<>(Arrays.asList(args[0].split(",")));
        var actual = new TreeSet<String>();
        for (var factory : ServiceLoader.load(RuntimeProviderFactory.class)) {
            String name = factory.getClass().getName();
            String backend = factories.entrySet().stream()
                    .filter(entry -> name.equals("com.alibaba.qwen.code.runtimebroker.provisioning." + entry.getValue()))
                    .map(Map.Entry::getKey).findFirst().orElseThrow();
            if (!actual.add(backend) || factory.kinds().isEmpty()) {
                throw new IllegalStateException("Invalid provider registration: " + name);
            }
        }
        if (!actual.equals(expected)) {
            throw new IllegalStateException("Unexpected providers: " + actual);
        }
        for (int index = 1; index < args.length; index++) {
            try {
                Class.forName(args[index], false, Thread.currentThread().getContextClassLoader());
                throw new IllegalStateException("Excluded implementation is loadable: " + args[index]);
            } catch (ClassNotFoundException expectedAbsence) {
                // Service absence alone would not prove implementation absence.
            }
        }
        System.out.println("Runtime providers: " + String.join(",", actual));
        try (var context = SpringApplication.run(ManagedAgentServerApplication.class,
                "--server.port=0", "--server.address=127.0.0.1",
                "--spring.profiles.active=runtime-artifact-test",
                "--spring.datasource.url=jdbc:h2:mem:runtime-artifact;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
                "--spring.datasource.driver-class-name=org.h2.Driver",
                "--spring.datasource.username=sa", "--spring.datasource.password=",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.harness.workspace-files-enabled=false",
                "--qwen.managed-agent.harness.workspace-shell-enabled=false",
                "--qwen.managed-agent.session-store.enabled=false",
                "--qwen.managed-agent.runtime-broker.enabled=false",
                "--qwen.managed-agent.runtime-broker.ssh.enabled=false",
                "--qwen.managed-agent.tool-publication.enabled=false")) {
            if (!context.getBeansOfType(EmbeddedRuntimeBroker.class).isEmpty()
                    || !context.getBeansOfType(SshConnections.class).isEmpty()
                    || context.getBean(SshWorkspaceService.class).configured()) {
                throw new IllegalStateException("Disabled Broker initialized Runtime resources");
            }
            System.out.println("Disabled Runtime application started");
        }
    }
}
