package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CsiCreationContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(strings = {"worker", "sandbox"})
    void consumesFixedSyntheticExpectationsAndKeepsBothOriginalBytes(String role) throws Exception {
        byte[] contract = CsiCreationContractFixture.bytes();
        var birth = birth(role);
        byte[] raw = Base64.getDecoder().decode(birth.path("originalSpec").textValue());
        byte[] before = raw.clone();
        CsiCreationContract.requireMatch(contract, raw, birth.path("id").textValue());
        assertArrayEquals(before, raw);
        assertArrayEquals(CsiCreationContractFixture.bytes(), contract);
    }

    @ParameterizedTest
    @ValueSource(strings = {"args", "env", "cwd", "mounts", "devices", "deviceCgroupRules", "seccomp", "maskedPaths", "readonlyPaths"})
    void refusesChangedActualInputsInsteadOfDerivingNewExpectations(String field) throws Exception {
        var birth = birth("worker");
        var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(birth.path("originalSpec").textValue()));
        var process = (ObjectNode) spec.path("process");
        var linux = (ObjectNode) spec.path("linux");
        switch (field) {
            case "args" -> process.putArray("args").add("/unreviewed-command");
            case "env" -> process.putArray("env").add("NODE_OPTIONS=--unreviewed");
            case "cwd" -> process.put("cwd", "/unreviewed");
            case "mounts" -> spec.putArray("mounts").addObject().put("type", "bind").put("source", "/unreviewed")
                    .put("destination", "/unreviewed").putArray("options").add("rw");
            case "devices" -> linux.putArray("devices").addObject().put("path", "/dev/unreviewed").put("type", "c").put("major", 1).put("minor", 3);
            case "deviceCgroupRules" -> linux.putObject("resources").putArray("devices").addObject().put("allow", true).put("type", "c").put("access", "rwm");
            case "seccomp" -> ((ObjectNode) linux.path("seccomp")).putArray("syscalls").addObject().put("action", "SCMP_ACT_ALLOW").putArray("names").add("mount");
            case "maskedPaths", "readonlyPaths" -> linux.putArray(field).add("/unreviewed");
            default -> throw new AssertionError(field);
        }
        byte[] raw = JSON.writeValueAsBytes(spec);
        assertThrows(IllegalArgumentException.class, () -> CsiCreationContract.requireMatch(CsiCreationContractFixture.bytes(), raw, birth.path("id").textValue()));
    }

    @ParameterizedTest
    @ValueSource(strings = {"unknown", "missing", "null", "unbounded", "macro", "glob", "alias"})
    void refusesUnsupportedContractInputs(String fault) throws Exception {
        var document = (ObjectNode) JSON.readTree(CsiCreationContractFixture.bytes());
        var worker = (ObjectNode) document.path("worker");
        switch (fault) {
            case "unknown" -> document.put("qualified", true);
            case "missing" -> worker.remove("deviceCgroupRules");
            case "null" -> worker.putNull("mounts");
            case "unbounded" -> worker.put("cwd", "/" + "x".repeat(1024));
            case "alias" -> worker.set("Args", worker.remove("args"));
            case "macro", "glob" -> worker.putArray("mounts").addObject().put("destination", "/input").put("type", "bind")
                    .put("source", fault.equals("macro") ? "/input/${OTHER}" : "/input/**");
            default -> throw new AssertionError(fault);
        }
        byte[] raw = JSON.writeValueAsBytes(document);
        assertThrows(IllegalArgumentException.class, () -> CsiCreationContract.validate(raw));
    }

    @Test
    void expandsOnlyOriginalIdentitiesInMountSources() throws Exception {
        var birth = birth("worker");
        var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(birth.path("originalSpec").textValue()));
        var document = (ObjectNode) JSON.readTree(CsiCreationContractFixture.bytes());
        var expected = ((ObjectNode) document.path("worker")).putArray("mounts").addObject()
                .put("destination", "/input").put("type", "bind")
                .put("source", "/input/${POD_UID}/${CONTAINER_ID}/${SANDBOX_ID}/${POD_UID_SYSTEMD}");
        var actual = expected.deepCopy();
        String uid = spec.path("annotations").path("io.kubernetes.cri.sandbox-uid").textValue();
        actual.put("source", "/input/" + uid + "/" + birth.path("id").textValue() + "/"
                + birth.path("sandboxId").textValue() + "/" + uid.replace('-', '_'));
        spec.putArray("mounts").add(actual);
        byte[] raw = JSON.writeValueAsBytes(spec), contract = JSON.writeValueAsBytes(document);
        CsiCreationContract.requireMatch(contract, raw, birth.path("id").textValue());
        assertThrows(IllegalArgumentException.class, () -> CsiCreationContract.requireMatch(contract, raw, "f".repeat(64)));
    }

    private static ObjectNode birth(String role) throws Exception {
        try (var input = CsiCreationContractTest.class.getResourceAsStream("/contracts/k2-node-source-v7.fixture.json")) {
            var fixture = JSON.readTree(input);
            var evidence = CsiNodeSourceJournal.verify(Base64.getDecoder().decode(fixture.path("bytesBase64").textValue()),
                    new CsiNodeSourceJournal.Cursor(fixture.path("head").path("sequence").longValue(), fixture.path("head").path("hash").textValue()));
            var born = evidence.stream().observations().getFirst().births().stream()
                    .filter(value -> value.role().equals(role.equals("worker") ? "container" : role)).findFirst().orElseThrow();
            return (ObjectNode) evidence.record(born.prepared()).path("birth");
        }
    }
}
