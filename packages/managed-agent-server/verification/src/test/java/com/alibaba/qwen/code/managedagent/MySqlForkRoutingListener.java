package com.alibaba.qwen.code.managedagent;

import org.junit.platform.launcher.LauncherSession;
import org.junit.platform.launcher.LauncherSessionListener;

public final class MySqlForkRoutingListener implements LauncherSessionListener {
    @Override
    public void launcherSessionOpened(LauncherSession session) {
        int forks = Integer.parseInt(System.getProperty("qwen.mysql.forkCount", "1"));
        if (forks <= 1) {
            return;
        }
        int fork = Integer.parseInt(System.getProperty("qwen.mysql.forkNumber", "0"));
        if (fork < 1 || fork > forks) {
            throw new IllegalArgumentException("qwen.mysql.forkNumber must be between 1 and " + forks);
        }
        String property = "mysql.url." + fork;
        String url = System.getProperty(property);
        if (url == null || !url.startsWith("jdbc:mysql://")) {
            throw new IllegalArgumentException(property + " must identify a disposable MySQL database");
        }
        System.setProperty("mysql.url", url);
    }
}
