package com.alibaba.qwen.code.cli.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.alibaba.fastjson2.JSON;
import com.alibaba.qwen.code.cli.protocol.data.PermissionMode;
import com.alibaba.qwen.code.daemon.DaemonApprovalMode;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

public class PermissionModeTest {

    @Test
    public void shouldBeReturnQwenPermissionModeValue() {
        assertEquals("default", PermissionMode.DEFAULT.getValue());
        assertEquals("plan", PermissionMode.PLAN.getValue());
        assertEquals("auto-edit", PermissionMode.AUTO_EDIT.getValue());
        assertEquals("auto", PermissionMode.AUTO.getValue());
        assertEquals("yolo", PermissionMode.YOLO.getValue());
    }

    @Test
    public void permissionModesMatchCoreContract() throws IOException {
        Set<String> expected = readCoreContract();
        Set<String> cliModes = Arrays.stream(PermissionMode.values())
                .map(PermissionMode::getValue)
                .collect(Collectors.toSet());
        Set<String> daemonModes = Arrays.stream(DaemonApprovalMode.values())
                .map(DaemonApprovalMode::getWireValue)
                .collect(Collectors.toSet());

        assertEquals(expected, cliModes);
        assertEquals(expected, daemonModes);
    }

    private static Set<String> readCoreContract() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path contract = directory.resolve(
                    "packages/core/src/config/approval-modes.json");
            if (Files.exists(contract)) {
                return new HashSet<>(JSON.parseArray(
                        Files.readString(contract), String.class));
            }
            directory = directory.getParent();
        }
        throw new IOException("Cannot find approval-modes.json");
    }

}
