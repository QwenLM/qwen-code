package com.alibaba.qwen.code.cli.utils;

import java.util.concurrent.TimeUnit;

import org.apache.commons.lang3.Validate;

/**
 * Represents a timeout value with a time unit.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class Timeout {
    /**
     * The timeout value.
     */
    private final Long value;
    /**
     * The time unit.
     */
    private final TimeUnit unit;

    /**
     * Creates a new Timeout instance.
     *
     * @param value The timeout value
     * @param unit The time unit
     */
    public Timeout(Long value, TimeUnit unit) {
        Validate.notNull(value, "value can not be null");
        Validate.notNull(unit, "unit can not be null");
        this.value = value;
        this.unit = unit;
    }

    /**
     * Gets the timeout value.
     *
     * @return The timeout value
     */
    public Long getValue() {
        return value;
    }

    /**
     * Gets the time unit.
     *
     * @return The time unit
     */
    public TimeUnit getUnit() {
        return unit;
    }

    /**
     * A timeout of 60 seconds.
     */
    public static final Timeout TIMEOUT_60_SECONDS = new Timeout(60L, TimeUnit.SECONDS);

    /**
     * A timeout of 180 seconds.
     */
    public static final Timeout TIMEOUT_180_SECONDS = new Timeout(180L, TimeUnit.SECONDS);

    /**
     * A timeout of 30 minutes.
     */
    public static final Timeout TIMEOUT_30_MINUTES = new Timeout(60L, TimeUnit.MINUTES);
}
