package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.util.ArrayList;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

@Tag("fault-gate")
class LocalRebootFaultGateTest {
    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void aRealEscapedWriterPreventsReuseAfterWorkerOnlyDeath(FaultGateRig.Placement placement) throws Exception {
        var descendants = new ArrayList<ProcessHandle>();
        try (var rig = FaultGateRig.open(placement)) {
            var first = rig.broker("original", rig.proxy(), FaultGateRig.Provisioner.TRUSTED_LOCAL_PROCESS);
            first.acquire(FaultGateRig.HARNESS, FaultGateRig.SESSION).requireOk();
            String child = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('escaped-marker','x'),50)";
            String parent = "const c=require('node:child_process').spawn(process.execPath,[\"-e\","
                    + com.alibaba.fastjson2.JSON.toJSONString(child) + "],{detached:true,stdio:'ignore'});"
                    + "require('node:fs').writeFileSync('escaped-pid',String(c.pid));c.unref();setInterval(()=>{},1000)";
            String command = "node -e '" + parent.replace("'", "'\"'\"'") + "'";
            String call = first.create(FaultGateRig.HARNESS, FaultGateRig.SESSION, "escape",
                    FaultGateRig.shell("escape", command)).object().getString("executionCallId");
            var directory = rig.directory;
            FaultGateRig.await(() -> Files.exists(directory.resolve("escaped-pid")), Boolean.TRUE::equals, "escaped writer pid");
            var escaped = ProcessHandle.of(Long.parseLong(Files.readString(directory.resolve("escaped-pid")))).orElseThrow();
            descendants.add(escaped);
            var worker = first.workers().getFirst();
            descendants.addAll(worker.descendants().toList());
            FaultGateRig.await(() -> Files.exists(directory.resolve("escaped-marker")), Boolean.TRUE::equals, "escaped writer output");
            worker.destroyForcibly();
            worker.onExit().get(5, TimeUnit.SECONDS);
            rig.killBroker(first);
            var restored = rig.broker("restored", rig.proxy(), FaultGateRig.Provisioner.TRUSTED_LOCAL_PROCESS);
            assertEquals("runtime_broker_runtime_lost", restored.warm(FaultGateRig.HARNESS).code());
            assertEquals(ToolExecutionRecord.State.ABANDONED, rig.execution(call).getState());
            assertNull(rig.activeBinding().getStopEvidence());
            assertTrue(restored.workers().isEmpty());
            assertTrue(escaped.isAlive());
            long before = Files.size(directory.resolve("escaped-marker"));
            FaultGateRig.await(() -> directory.resolve("escaped-marker").toFile().length(), size -> size > before,
                    "escaped writer continues after loss; the physical pin must remain");
        } finally {
            for (ProcessHandle process : descendants) {
                process.destroyForcibly();
            }
            for (ProcessHandle process : descendants) {
                process.onExit().get(5, TimeUnit.SECONDS);
            }
        }
    }
}
