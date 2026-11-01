package com.alibaba.qwen.code.managedagent.contracts.workspace;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;

import java.nio.file.Path;
public interface WorktreeFiles {
    public String verify(Plan plan, String savedIdentity);
    public void requireRoot(Plan plan);
    public String currentBranch(String verifiedIdentity);
    public String identity(Path path);
}
