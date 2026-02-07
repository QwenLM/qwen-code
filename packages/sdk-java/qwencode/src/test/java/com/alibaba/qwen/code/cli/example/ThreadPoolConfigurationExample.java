package com.alibaba.qwen.code.cli.example;

import com.alibaba.qwen.code.cli.QwenCodeCli;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.utils.ThreadPoolConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public class ThreadPoolConfigurationExample {
    private static final Logger logger = LoggerFactory.getLogger(ThreadPoolConfigurationExample.class);

    public static void main(String[] args) {
        runModifyDefaultExample();
        runCustomSupplierExample();
    }

    /**
     * Example showing how to set a custom thread pool supplier
     */
    public static void runCustomSupplierExample() {
        // Set a custom thread pool supplier
        ThreadPoolConfig.setExecutorSupplier(() -> (ThreadPoolExecutor) Executors.newFixedThreadPool(20));
        logger.info("Custom thread pool supplier set");
    }

    /**
     * Example showing how to modify properties of the default thread pool
     */
    public static void runModifyDefaultExample() {
        // Get the default executor and modify its properties
        ThreadPoolExecutor executor = ThreadPoolConfig.getDefaultExecutor();

        // Modify the core pool size
        executor.setCorePoolSize(15);

        // Modify the maximum pool size
        executor.setMaximumPoolSize(40);

        // Modify the keep-alive time
        executor.setKeepAliveTime(120, TimeUnit.SECONDS);

        logger.info("Default thread pool properties modified");

        // The SDK will now use the modified executor for all operations
        Session session = QwenCodeCli.newSession();
    }
}
