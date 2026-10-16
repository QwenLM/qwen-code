package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.util.List;
import java.util.UUID;

/** Original source protocol linkage only; deployment qualification and release are separate. */
final class WorkspaceCsiPhysicalSource {
    private WorkspaceCsiPhysicalSource() {
    }

    static CsiNodeSourceJournal.Observation validate(WorkspaceCsiNodeSourceStore.Association original,
            String retirement, String planSha256, CsiNodeSourceJournal.Evidence evidence) {
        WorkspaceCsiNodeSourceStore.validate(original);
        require("PUBLISHED".equals(original.phase()) && retirement != null
                && UUID.fromString(retirement).toString().equals(retirement)
                && planSha256 != null && planSha256.matches("[0-9a-f]{64}")
                && evidence != null && evidence.bytes().length <= WorkspaceCsiNodeSourceStore.EVIDENCE_LIMIT);
        evidence.requireExtends(original.publication());
        var published = WorkspaceCsiNodeSourceStore.validateEvidence(original.configuration(),
                original.publication(), "PUBLISHED", original.podUid());
        var scope = published.scope();
        var expected = new CsiNodeSourceJournal.Scope(scope.armId(), scope.namespace(), scope.podName(), scope.podUid(),
                scope.containerId(), scope.driver(), scope.volumeId(), scope.pvUid(), scope.pvcUid(), scope.target(), scope.bindingId(), retirement);
        var matches = evidence.stream().observations().stream().filter(value -> value.scope().armId().equals(scope.armId())).toList();
        require(matches.size() == 1);
        var result = matches.getFirst();
        require(expected.equals(result.scope()) && List.of("STOP_INTENT", "STOPPED", "UNPUBLISHED").contains(result.state())
                && published.arm().equals(result.arm()) && published.bound().equals(result.bound())
                && published.custody().equals(result.custody()) && published.publish().equals(result.publish())
                && result.intent() != null && planSha256.equals(evidence.record(result.intent()).path("intentHash").textValue()));
        WorkspaceCsiNodeSourceStore.validateBirths(original.configuration(), evidence, result, false);
        return result;
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new RuntimeBrokerException(409, "csi_physical_source_unavailable",
                    "The original CSI physical source linkage is unavailable.", false);
        }
    }
}
