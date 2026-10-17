package com.alibaba.qwen.code.runtimebroker;

import java.nio.file.Path;
import java.util.List;

/** Test-jar-only synthetic boot transition; never shipped in the production artifact. */
public final class LocalRebootTestSupport {
    private LocalRebootTestSupport() { }

    public static LocalProcessRuntimeProvisioner provisioner(List<String> command, Path directory,
            HttpRuntimeTransport transport, boolean rebooted) {
        var current = "Linux".equals(System.getProperty("os.name")) ? LocalRuntimeStore.HostIdentity.linux()
                : DurableLocalProcessRuntimeProvisionerTest.HOST;
        var identity = rebooted ? new LocalRuntimeStore.HostIdentity(current.hostId(),
                current.bootId().equals("ffffffff-ffff-ffff-ffff-ffffffffffff")
                        ? "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" : "ffffffff-ffff-ffff-ffff-ffffffffffff",
                current.pidNamespace(), current.timeNamespace()) : current;
        return new LocalProcessRuntimeProvisioner(command, directory, transport, null,
                new LocalRuntimeStore(directory, identity), true);
    }
}
