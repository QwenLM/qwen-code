package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.*;

import java.nio.file.Path;

public final class VerificationFixtures {
    private VerificationFixtures() { }

    public static com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor actor(String tenant, String user) {
        return actor(com.alibaba.qwen.code.managedagent.model.SessionPrincipal.ofUser(tenant, user));
    }

    public static com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor actor(
            com.alibaba.qwen.code.managedagent.model.SessionPrincipal principal) {
        return new com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor() {
            public String tenantId() { return principal.tenantId(); }
            public String actorId() { return principal.userId(); }
            public String actorSubjectId() { return principal.actorSubjectId(); }
            public String getName() { return principal.userId(); }
        };
    }

    public static void ownUnboundSession(org.springframework.jdbc.core.JdbcTemplate jdbc, String session,
            com.alibaba.qwen.code.managedagent.model.SessionPrincipal principal) {
        org.assertj.core.api.Assertions.assertThat(jdbc.update("INSERT INTO ma_session_principal"
                + " (tenant_id,session_id,version,user_id,actor_present,actor_subject_id,gmt_create)"
                + " SELECT tenant_id,session_id,1,?,?,?,gmt_create FROM ma_session"
                + " WHERE tenant_id=? AND session_id=? AND workspace_id IS NULL",
                principal.userId(), principal.actorPresent(), principal.actorSubjectId(),
                principal.tenantId(), session)).isEqualTo(1);
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

    public static ManagedSessionStore managedSessionStore(org.springframework.jdbc.core.JdbcTemplate jdbc) {
        return managedSessionStore(jdbc, new ManagedExtensionRecordStore(jdbc), null);
    }

    public static ManagedSessionStore managedSessionStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            ManagedExtensionRecordStore records) {
        return managedSessionStore(jdbc, records, null);
    }

    public static ManagedSessionStore managedSessionStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy credentials) {
        return managedSessionStore(jdbc, new ManagedExtensionRecordStore(jdbc), null,
                null, null, null, null, null, credentials, null);
    }

    public static ManagedSessionStore managedSessionStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            ManagedExtensionRecordStore records, ManagedActionStore actions) {
        return managedSessionStore(jdbc, records, actions, null, null, null, null, null,
                com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy.unbound(), null);
    }

    public static ManagedSessionStore managedSessionStore(org.springframework.jdbc.core.JdbcTemplate jdbc,
            ManagedExtensionRecordStore records, ManagedActionStore actions,
            WorkspaceExecutionStore execution,
            com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore sessions,
            com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore objects,
            ManagedToolResultStore results,
            com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport transport,
            com.alibaba.qwen.code.managedagent.contracts.security.WriterCredentialPolicy credentials,
            com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository bindings) {
        return new ManagedSessionStore(jdbc, records, actions,
                new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules(),
                new com.alibaba.qwen.code.managedagent.config.ManagedSessionReaderVersion(),
                execution, sessions, objects, results, transport, credentials, bindings);
    }

    public static java.util.List<Object> agentStoreOwners(Object store, String name) {
        var owners = java.util.Arrays.stream(store.getClass().getDeclaredFields())
                .filter(field -> field.getType().getSimpleName().startsWith("Agent"))
                .map(field -> org.springframework.test.util.ReflectionTestUtils.getField(store, field.getName()))
                .filter(owner -> org.springframework.util.ReflectionUtils.findField(owner.getClass(), name) != null)
                .toList();
        if (owners.isEmpty()) {
            throw new IllegalArgumentException("No Agent collaborator owns " + name);
        }
        return owners;
    }

    public static Object agentStoreField(Object store, String name) {
        var owners = agentStoreOwners(store, name);
        Object value = org.springframework.test.util.ReflectionTestUtils.getField(owners.getFirst(), name);
        for (Object owner : owners) {
            org.assertj.core.api.Assertions.assertThat(org.springframework.test.util.ReflectionTestUtils.getField(owner, name))
                    .as(name).isSameAs(value);
        }
        return value;
    }

    public static void setAgentStoreField(Object store, String name, Object value) {
        for (Object owner : agentStoreOwners(store, name)) {
            org.springframework.test.util.ReflectionTestUtils.setField(owner, name, value);
        }
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
                new com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess());
        return store;
    }

    public static WorkspaceFileUploadStore configure(WorkspaceFileUploadStore store) {
        store.configureLocalFiles(
                new com.alibaba.qwen.code.runtimebroker.host.WorkspaceFileProcess());
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
