package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.*;

import java.nio.file.Path;

public final class VerificationFixtures {
    private VerificationFixtures() { }

    public static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder authenticated(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder builder,
            String actor) {
        return builder.with(request -> {
            // The wrapper is authoritative: spring-test applies the
            // builder's principal before post-processors run, so an
            // only-if-absent install left `authenticated(auth(…, "other"),
            // "owner")` silently running as "other" (R2-5).
            String tenant = request.getHeader(com.alibaba.qwen.code.managedagent.api.TenantContextFilter.HEADER);
            if (tenant != null && actor != null) {
                request.setUserPrincipal(new com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor() {
                    @Override
                    public String tenantId() {
                        return tenant;
                    }

                    @Override
                    public String actorId() {
                        return actor;
                    }

                    @Override
                    public String getName() {
                        return actor;
                    }
                });
            }
            return request;
        });
    }

    public static Path moduleRoot() {
        return Path.of(System.getProperty("managed.module.root", "..")).toAbsolutePath().normalize();
    }

    public static Path repositoryRoot() {
        return moduleRoot().resolve("../..").normalize();
    }

    public static ManagedAgentStore managedAgentStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            com.fasterxml.jackson.databind.ObjectMapper json, java.time.Clock clock,
            com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher publisher,
            ManagedWorkspaceRegistry workspaces,
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties,
            com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules) {
        return managedAgentStore(jdbc, json, clock, publisher, workspaces, properties, harnessRules, null, null);
    }

    public static ManagedAgentStore managedAgentStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            com.fasterxml.jackson.databind.ObjectMapper json, java.time.Clock clock,
            com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher publisher,
            ManagedWorkspaceRegistry workspaces,
            com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties,
            com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules,
            ManagedAgentDefinitionStore definitions, WorkspaceLifecycleStore lifecycle) {
        return new ManagedAgentStore(jdbc, json, clock, publisher, workspaces, properties, harnessRules,
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(),
                new ManagedSessionSkills(jdbc, json, new com.alibaba.qwen.code.managedagent.model.RequestDigests(), null),
                null, lifecycle, definitions, null, null, null);
    }

    public static ManagedSessionStore configure(ManagedSessionStore store) {
        store.configureHarnessRules(
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        store.configureReaderVersion(
                new com.alibaba.qwen.code.managedagent.config.ManagedSessionReaderVersion());
        return store;
    }

    public static SessionWorktreeStore configure(SessionWorktreeStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static WorkspaceFileStore configure(WorkspaceFileStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        store.configureLocalFiles(
                new com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess());
        return store;
    }

    public static WorkspaceFileUploadStore configure(WorkspaceFileUploadStore store) {
        store.configureLocalFiles(
                new com.alibaba.qwen.code.runtimebroker.provisioning.WorkspaceFileProcess());
        return store;
    }

    public static ManagedUserMessageStore configure(ManagedUserMessageStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static WorkspaceExecutionStore configure(WorkspaceExecutionStore store) {
        store.configureWorktreeFiles(
                new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles());
        return store;
    }

    public static com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService configure(com.alibaba.qwen.code.managedagent.workspace.SessionWorktreeService service) {
        service.configureWorktreeFiles(new com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles(),
                (git, timeout) -> new com.alibaba.qwen.code.managedagent.adapters.workspace.SessionWorktreeGit(new com.alibaba.qwen.code.managedagent.adapters.workspace.ChildWorktreeGit(git, timeout)));
        return service;
    }
}
