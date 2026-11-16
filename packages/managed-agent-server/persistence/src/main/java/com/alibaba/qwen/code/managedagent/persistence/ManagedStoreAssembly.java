package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.event.CommittedEventPublisher;
import com.alibaba.qwen.code.managedagent.contracts.event.JournalEventTransport;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Locale;

/**
 * The collaborator assembly of the Managed Agent facade: the construction
 * order and catalog validation ManagedAgentStore's autowired constructor ran
 * inline, moved verbatim so the facade stays under the class-size ratchet.
 * An ordinary immutable object — Spring wiring stays on the facade.
 */
final class ManagedStoreAssembly {
    private final AgentEventJournal eventJournal;
    private final AgentSessionQueries sessionQueries;
    private final AgentMessageProjection messageProjection;
    private final AgentSessionPolicies sessionPolicies;
    private final AgentSessionCommands sessionCommands;
    private final AgentLifecycleOperations lifecycleOperations;
    private final AgentSessionAdmissions sessionAdmissions;
    private final AgentTurnExecution turnExecution;
    private final AgentExecutionOperations executionOperations;

    ManagedStoreAssembly(JdbcTemplate jdbc, ObjectMapper objectMapper,
            Clock clock, CommittedEventPublisher eventPublisher,
            JdbcManagedWorkspaceRegistry workspaces, ManagedAgentSettings properties, HarnessRules harnessRules,
            com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles worktreeFiles,
            JdbcManagedSessionSkills creationSkills,
            com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages extensionPackages,
            JdbcWorkspaceLifecycleStore lifecycle, JdbcManagedAgentDefinitionStore definitions,
            JdbcSessionWorktreeStore sessionWorktrees, JournalEventTransport journalEventTransport,
            JdbcManagedExtensionRecordStore configRecords, ManagedSessionModelConfigs modelConfigs,
            JdbcJournalPacks journalPacks) {
        String approvalMode =
                properties.getHarness().getApprovalMode().toLowerCase(Locale.ROOT);
        String agentRevision = properties.getAgentRevision();
        List<String> definitionToolProfiles = properties.getDefinitionToolProfiles();
        List<String> definitionModels = properties.getDefinitionModels();
        List<WebShellModelOption> modelCatalog = ManagedSessionModelConfigs.catalog(properties);
        boolean journalEventTransportEnabled = properties.getEventTransport().isEnabled();
        boolean workspaceFilesEnabled = properties.getHarness().isWorkspaceFilesEnabled();
        boolean workspaceShellEnabled = properties.getHarness().isWorkspaceShellEnabled();
        boolean workspaceChildAgentsEnabled = properties.admitsPublicChildAgents();
        boolean managedExtensionExecutionEnabled = properties.getExtensions().isEnabled() && properties.getManagedExtensions().isEnabled();
        long lifecycleHandoffMillis = properties.getSessionStore().getWriterLeaseDuration().toMillis();
        List<? extends ManagedAgentSettings.RuntimeBroker.WorkspaceMount> workspaceMounts = properties.getRuntimeBroker().getWorkspaceMounts();
        ResidentWorkspaces residentWorkspaces = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
        WorkspaceCreationRoots createdRoots = new WorkspaceCreationRoots(jdbc, properties);
        if (StringUtils.isBlank(agentRevision)
                || agentRevision.length() > 128) {
            throw new IllegalArgumentException(
                    "qwen.managed-agent.agent-revision must contain 1-128"
                            + " characters");
        }

        AgentStoreRows storeRows = new AgentStoreRows(harnessRules, jdbc, objectMapper);
        this.eventJournal = new AgentEventJournal(storeRows, jdbc, clock, eventPublisher);
        this.sessionQueries = new AgentSessionQueries(storeRows, worktreeFiles, jdbc, modelCatalog);
        this.messageProjection = new AgentMessageProjection(eventJournal, storeRows, jdbc, objectMapper, clock);
        this.sessionPolicies = new AgentSessionPolicies(eventJournal, sessionQueries, storeRows, worktreeFiles, harnessRules, configRecords, jdbc, objectMapper, clock, approvalMode, workspaces, agentRevision, definitionToolProfiles, definitionModels, modelCatalog, definitions, creationSkills, workspaceFilesEnabled, workspaceShellEnabled, residentWorkspaces);
        this.sessionCommands = new AgentSessionCommands(eventJournal, sessionPolicies, storeRows, worktreeFiles, jdbc, clock, workspaces, workspaceFilesEnabled, workspaceShellEnabled);
        this.lifecycleOperations = new AgentLifecycleOperations(eventJournal, sessionCommands, sessionPolicies, sessionQueries, storeRows, jdbc, lifecycle, objectMapper, clock, workspaces, workspaceFilesEnabled, lifecycleHandoffMillis);
        this.sessionAdmissions = new AgentSessionAdmissions(eventJournal, sessionCommands, sessionPolicies, storeRows, configRecords, jdbc, clock, approvalMode, workspaces, agentRevision, modelCatalog, definitions, creationSkills, sessionWorktrees, extensionPackages, workspaceFilesEnabled, workspaceShellEnabled, workspaceChildAgentsEnabled, managedExtensionExecutionEnabled, workspaceMounts, residentWorkspaces, createdRoots, journalEventTransport, journalEventTransportEnabled, modelConfigs);
        this.turnExecution = new AgentTurnExecution(eventJournal, messageProjection, sessionCommands, storeRows, jdbc, objectMapper, clock, journalPacks);
        this.executionOperations = new AgentExecutionOperations(eventJournal, lifecycleOperations, sessionPolicies, sessionQueries, storeRows, worktreeFiles, jdbc, clock, workspaces, workspaceFilesEnabled, journalPacks);
    }

    AgentEventJournal eventJournal() {
        return eventJournal;
    }

    AgentSessionQueries sessionQueries() {
        return sessionQueries;
    }

    AgentMessageProjection messageProjection() {
        return messageProjection;
    }

    AgentSessionPolicies sessionPolicies() {
        return sessionPolicies;
    }

    AgentSessionCommands sessionCommands() {
        return sessionCommands;
    }

    AgentLifecycleOperations lifecycleOperations() {
        return lifecycleOperations;
    }

    AgentSessionAdmissions sessionAdmissions() {
        return sessionAdmissions;
    }

    AgentTurnExecution turnExecution() {
        return turnExecution;
    }

    AgentExecutionOperations executionOperations() {
        return executionOperations;
    }
}
