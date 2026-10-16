package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiCreationContractFixture;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Base64;
import java.util.List;
import java.util.Map;

/** Synthetic inputs for data tests; never installation evidence. */
public final class WorkspaceCsiBirthTestInputs {
    private static final ObjectMapper JSON = new ObjectMapper();

    private WorkspaceCsiBirthTestInputs() {
    }

    public static WorkspaceCsiNodeSourceStore.BirthInputs reviewed() {
        return new WorkspaceCsiNodeSourceStore.BirthInputs(
                "3c252c467343eb5d93bb01780c1a6457642b5eb321f377e87b7cf22e2ef3791d", "a".repeat(64),
                "664c8a6e7ff3fab93690aa0291e35b7f49c9d584c00eb2a2ef50c0169d719654",
                Base64.getEncoder().encodeToString(CsiCreationContractFixture.bytes()));
    }

    static void mapOriginalScope(ObjectNode record, Map<Long, String> hashes) throws Exception {
        if (!record.has("birth")) {
            return;
        }
        var birth = (ObjectNode) record.path("birth");
        var scope = record.path("scope");
        for (String field : List.of("originalSpec", "consumedSpec")) {
            var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(birth.path(field).textValue()));
            var annotations = (ObjectNode) spec.path("annotations");
            annotations.put("io.kubernetes.cri.sandbox-uid", scope.path("podUid").textValue());
            annotations.put("io.kubernetes.cri.sandbox-name", scope.path("podName").textValue());
            annotations.put("io.kubernetes.cri.sandbox-namespace", scope.path("namespace").textValue());
            byte[] raw = JSON.writeValueAsBytes(spec);
            birth.put(field, Base64.getEncoder().encodeToString(raw));
            var object = (ObjectNode) birth.path("objects").get(field.equals("originalSpec") ? 3 : 0);
            object.put("bytes", raw.length).put("sha256", CsiNativeActivationProof.sha256(raw));
        }
        for (String field : List.of("prepared", "created", "startBegin")) {
            if (birth.has(field)) {
                ((ObjectNode) birth.path(field)).put("hash", hashes.get(birth.path(field).path("sequence").longValue()));
            }
        }
    }
}
