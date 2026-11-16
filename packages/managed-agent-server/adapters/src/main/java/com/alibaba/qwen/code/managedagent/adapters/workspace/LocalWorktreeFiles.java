package com.alibaba.qwen.code.managedagent.adapters.workspace;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;

import java.nio.file.Path;
public final class LocalWorktreeFiles implements WorktreeFiles {
    public String verify(Plan plan, String savedIdentity) { return SessionWorktreeGit.verify(plan, savedIdentity); }
    public void requireRoot(Plan plan) { SessionWorktreeGit.requireRoot(plan); }
    public String currentBranch(String verifiedIdentity) { return SessionWorktreeGit.currentBranch(verifiedIdentity); }
    public String identity(Path path) { return SessionWorktreeGit.identity(path); }
}
