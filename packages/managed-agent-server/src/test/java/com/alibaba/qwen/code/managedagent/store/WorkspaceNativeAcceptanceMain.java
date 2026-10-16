package com.alibaba.qwen.code.managedagent.store;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Runs the existing native fixtures outside Maven; the operator supplies a private database and timeout. */
public final class WorkspaceNativeAcceptanceMain {
    private WorkspaceNativeAcceptanceMain() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !List.of("concurrency", "storage", "all").contains(args[0])
                || !"Linux".equals(System.getProperty("os.name"))) {
            throw new IllegalArgumentException("concurrency|storage|all <task-directory> on Linux");
        }
        Path directory = Path.of(args[1]).toRealPath();
        if (!"storage".equals(args[0])) {
            var fixture = new HostedWorkspaceConcurrencyIT();
            fixture.temporary = Files.createTempDirectory(directory, "concurrency-");
            fixture.twoBrokerProcessesSerializeFenceClaimDispatchAndStaleCleanup();
            System.out.println("{\"fixture\":\"HostedWorkspaceConcurrencyIT\",\"passed\":true}");
        }
        if (!"concurrency".equals(args[0])) {
            var fixture = new HostedWorkspaceStorageGuardMySqlIT();
            fixture.temporary = Files.createTempDirectory(directory, "storage-");
            fixture.linuxRegistrationSurvivesProcessRestartAndMysqlClientsSerializeMaintenance();
            System.out.println("{\"fixture\":\"HostedWorkspaceStorageGuardMySqlIT\",\"passed\":true}");
        }
    }
}
