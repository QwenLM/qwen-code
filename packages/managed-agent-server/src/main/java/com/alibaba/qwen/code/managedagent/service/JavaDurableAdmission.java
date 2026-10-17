package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;

import java.util.Locale;

/**
 * D7-3: the java_durable view of a Turn input or cancel admission. Since D7-1
 * every such admission saves its submit_input or cancel operation in the
 * transaction that admits it, and D7-2 reconciles one whose acceptance is
 * unknown, so the admission can name that operation, its admission stage and
 * its delivery state: 202 then means saved, and responsible for delivery.
 *
 * <p>This is not a component. Only JavaDurableAdmissionConfiguration creates
 * it, when the deployment enables the profile.
 */
public class JavaDurableAdmission {
    public static final String HARNESS_CONFIRMED = "harness_confirmed";
    public static final String JAVA_DURABLE = "java_durable";

    private final AgentStateStore store;

    public JavaDurableAdmission(AgentStateStore store) {
        this.store = store;
    }

    /** The operation an admission saved, as the response reports it. */
    public record Operation(String operationId, String admissionStage,
            String deliveryState) {
    }

    /**
     * The admission's operation with its latest durable stage and state, or
     * null for a command recorded before D7-1 saved operations, whose replay
     * keeps the legacy response.
     */
    public Operation operation(String tenantId, Admission admission) {
        if (admission.operationId() == null) {
            return null;
        }
        OperationRecord operation = store.findOperation(tenantId,
                admission.sessionId(), admission.operationId()).orElse(null);
        if (operation == null) {
            return null;
        }
        return new Operation(operation.operationId(),
                lower(operation.admissionStage()),
                lower(operation.deliveryState()));
    }

    private static String lower(String value) {
        return value == null ? null : value.toLowerCase(Locale.ROOT);
    }
}
