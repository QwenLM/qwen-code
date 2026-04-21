package com.alibaba.qwen.code.cli.protocol.data;

/**
 * Represents different permission modes for the CLI.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public enum PermissionMode {
    /**
     * Default permission mode.
     */
    DEFAULT("default"),
    /**
     * Plan permission mode.
     */
    PLAN("plan"),
    /**
     * Auto-edit permission mode.
     */
    AUTO_EDIT("auto-edit"),
    /**
     * YOLO permission mode.
     */
    YOLO("yolo");

    private final String value;

    PermissionMode(String value) {
        this.value = value;
    }

    /**
     * Gets the string value of the permission mode.
     *
     * @return The string value of the permission mode
     */
    public String getValue() {
        return value;
    }

    /**
     * Gets the permission mode from its string value.
     *
     * @param value The string value
     * @return The corresponding permission mode
     */
    public static PermissionMode fromValue(String value) {
        for (PermissionMode mode : PermissionMode.values()) {
            if (mode.value.equals(value)) {
                return mode;
            }
        }
        throw new IllegalArgumentException("Unknown permission mode: " + value);
    }
}
