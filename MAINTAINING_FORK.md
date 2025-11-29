# Maintaining Your Fork: Syncing Upstream Changes

This guide explains how to pull updates from the original Qwen Code repository while keeping your offline/air-gapped modifications.

## Initial Setup

### 1. Add Upstream Remote

First, add the original repository as an upstream remote:

```bash
# Check current remotes
git remote -v

# Add upstream remote
git remote add upstream https://github.com/QwenLM/qwen-code.git

# Verify it was added
git remote -v
```

You should see:

```
origin    <your-fork-url> (fetch)
origin    <your-fork-url> (push)
upstream  https://github.com/QwenLM/qwen-code.git (fetch)
upstream  https://github.com/QwenLM/qwen-code.git (push)
```

## Syncing Process

### Step 1: Fetch Latest Changes

```bash
# Fetch all branches and commits from upstream
git fetch upstream
```

### Step 2: Check Your Current Branch

```bash
# Make sure you're on your main branch (or the branch you want to update)
git branch

# If not on main, switch to it
git checkout main
```

### Step 3: Merge Upstream Changes

There are two main strategies:

#### Option A: Merge (Preserves History)

```bash
# Merge upstream/main into your main branch
git merge upstream/main
```

**Pros:**

- Preserves full history
- Shows when upstream changes were merged
- Easier to track what came from upstream

**Cons:**

- Creates merge commits
- History can get cluttered

#### Option B: Rebase (Cleaner History)

```bash
# Rebase your changes on top of upstream
git rebase upstream/main
```

**Pros:**

- Cleaner, linear history
- Your commits appear after upstream commits

**Cons:**

- Rewrites commit history
- Can be more complex if conflicts occur
- **Don't rebase if you've already pushed to a shared branch**

### Step 4: Handle Merge Conflicts

If there are conflicts, Git will pause and show you which files have conflicts:

```bash
# Check which files have conflicts
git status

# Open conflicted files and resolve manually
# Look for conflict markers:
# <<<<<<< HEAD
# Your changes
# =======
# Upstream changes
# >>>>>>> upstream/main
```

After resolving conflicts:

```bash
# Mark conflicts as resolved
git add <resolved-file>

# Continue the merge/rebase
git merge --continue
# OR if rebasing:
git rebase --continue
```

## Important: Protecting Your Changes

### Files to Watch for Conflicts

Your fork modifies these files, so watch for conflicts:

1. **Telemetry Files** (Always keep your version):
   - `packages/core/src/telemetry/sdk.ts`
   - `packages/core/src/telemetry/qwen-logger/qwen-logger.ts`
   - `packages/core/src/telemetry/clearcut-logger/clearcut-logger.ts`
   - `packages/core/src/config/config.ts` (telemetry methods)

2. **Ollama Support** (Keep your additions):
   - `packages/core/src/core/openaiContentGenerator/provider/ollama.ts`
   - `packages/core/src/core/openaiContentGenerator/index.ts`
   - `packages/core/src/core/openaiContentGenerator/constants.ts`

3. **Package Metadata** (Keep your fork name):
   - `package.json` (name field)

4. **Documentation** (Keep your additions):
   - `README.md`
   - `OLLAMA_README.md`
   - `OLLAMA_SETUP.md`
   - `FORK_SUMMARY.md`
   - `TELEMETRY_REMOVAL.md`
   - `MAINTAINING_FORK.md` (this file)

### Strategy for Handling Conflicts

#### For Telemetry Files:

**Always keep your version** - upstream will try to re-enable telemetry, but you want it removed.

```bash
# If there's a conflict in telemetry files, use your version:
git checkout --ours packages/core/src/telemetry/sdk.ts
git add packages/core/src/telemetry/sdk.ts
```

#### For Ollama Files:

**Keep your additions** - upstream won't have Ollama support, so merge carefully.

```bash
# If upstream adds something that conflicts with Ollama provider:
# 1. Manually merge, keeping your Ollama code
# 2. Ensure Ollama provider is still exported and used
```

#### For Config Files:

**Merge carefully** - upstream may add new config options you want, but keep your telemetry disabling.

```bash
# Manually resolve, keeping:
# - Your telemetry disabling code
# - Any new config options from upstream
```

## Automated Sync Script

Create a script to help with syncing:

```bash
#!/bin/bash
# save as: sync-upstream.sh

set -e

echo "🔄 Syncing with upstream Qwen Code repository..."

# Fetch latest changes
echo "📥 Fetching upstream changes..."
git fetch upstream

# Check current branch
CURRENT_BRANCH=$(git branch --show-current)
echo "📍 Current branch: $CURRENT_BRANCH"

# Merge upstream
echo "🔀 Merging upstream/main..."
git merge upstream/main || {
    echo "⚠️  Merge conflicts detected!"
    echo "📝 Please resolve conflicts manually, then run:"
    echo "   git add <resolved-files>"
    echo "   git merge --continue"
    exit 1
}

echo "✅ Successfully synced with upstream!"
echo "🧪 Remember to test your changes:"
echo "   npm install"
echo "   npm run build"
echo "   npm test"
```

Make it executable:

```bash
chmod +x sync-upstream.sh
./sync-upstream.sh
```

## Testing After Sync

After syncing, always test:

```bash
# Install any new dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Test with Ollama
export OPENAI_API_KEY="ollama"
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="qwen3-coder"
npm run start
```

## Creating a Sync Branch (Recommended)

For safer syncing, create a separate branch:

```bash
# Create a sync branch from your main
git checkout -b sync-upstream

# Merge upstream
git merge upstream/main

# Resolve conflicts here
# Test thoroughly

# If everything works, merge back to main
git checkout main
git merge sync-upstream

# Delete sync branch
git branch -d sync-upstream
```

## Handling Major Upstream Changes

### If Upstream Restructures Code

If upstream significantly changes the codebase:

1. **Check the changelog/release notes** for breaking changes
2. **Review the diff** before merging:
   ```bash
   git diff main upstream/main
   ```
3. **Merge in smaller chunks** if possible:
   ```bash
   # Merge specific commits
   git cherry-pick <commit-hash>
   ```

### If Upstream Adds New Features You Want

You can selectively merge features:

```bash
# See what changed
git log upstream/main --oneline

# Cherry-pick specific commits
git cherry-pick <commit-hash>
```

## Keeping Track of Your Changes

### Tag Your Fork Versions

```bash
# Tag your fork version
git tag -a v0.3.0-ollama-1 -m "Ollama fork v1 based on upstream v0.3.0"

# Push tags
git push origin --tags
```

### Document Upstream Version

Keep track of which upstream version you're based on:

```bash
# After syncing, note the upstream commit
git log upstream/main -1 --oneline > UPSTREAM_VERSION.txt
```

## Troubleshooting

### "Upstream remote doesn't exist"

```bash
# Re-add it
git remote add upstream https://github.com/QwenLM/qwen-code.git
```

### "Merge conflicts in many files"

```bash
# Abort the merge and try a different strategy
git merge --abort

# Or use a merge tool
git mergetool
```

### "Rebase conflicts"

```bash
# If rebase gets messy, abort it
git rebase --abort

# Use merge instead
git merge upstream/main
```

### "Lost my changes after merge"

```bash
# Find your commits
git reflog

# Recover them
git cherry-pick <commit-hash>
```

## Best Practices

1. **Sync Regularly**: Don't let too many changes accumulate
2. **Test After Every Sync**: Make sure everything still works
3. **Commit Before Syncing**: Have a clean working directory
4. **Use Branches**: Test syncs in a separate branch first
5. **Document Changes**: Keep notes on what you modified and why
6. **Backup First**: Tag or branch before major syncs

## Quick Reference

```bash
# Setup (one time)
git remote add upstream https://github.com/QwenLM/qwen-code.git

# Regular sync workflow
git fetch upstream
git checkout main
git merge upstream/main
# Resolve conflicts if any
npm install && npm run build && npm test

# Push to your fork
git push origin main
```

## Alternative: Using GitHub's Interface

You can also use GitHub's web interface:

1. Go to your fork on GitHub
2. Click "Sync fork" button (if available)
3. Click "Update branch" to merge upstream changes
4. Resolve conflicts on GitHub or locally
5. Pull changes to your local repository

However, **manual merging is recommended** for better control over conflict resolution.
