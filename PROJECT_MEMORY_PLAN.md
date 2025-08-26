# Project-Specific Memory Storage Implementation Plan

## Overview
Add support for storing new memories in project-specific `QWEN.md` files, enabling isolation of memory across projects.

## Key Requirements
- Write new memories to project-specific `QWEN.md` if it exists
- Fall back to global `~/.qwen/QWEN.md` if no project-specific file exists
- Read memories from project-specific file first (priority), then global
- Allow configuration via `.qwen/settings.json` with `"memoryStorage": "project"` or `"global"`
- Provide migration tool to transfer existing global memories to project-specific files
- Maintain backward compatibility with existing global-only behavior

## Detailed Implementation Plan

### 1. Memory Writing Logic

**Current Behavior**: 
- When `save_memory` is called without a scope, it prompts the user to choose between global or project
- If scope is specified, it uses that scope

**New Behavior**: 
- Check for project-specific `QWEN.md` in current directory
- If exists and `memoryStorage` is set to `project` (or not specified), write to it
- If project-specific file doesn't exist, or `memoryStorage` is set to `global`, write to global file
- If no scope is specified, use the configuration value (default: `global`)

**Implementation Steps**:
1. Removed duplicate `scope` parameter
2. Added `memoryStorage` parameter to the `save_memory` tool parameters
3. Updated the scope determination logic to use `memoryStorage` instead of `scope`
4. Added configuration file reading to load `memoryStorage` value from `.qwen/settings.json`
5. Updated error messages to reflect the actual storage location being used

### 2. Memory Reading Logic

**Current Behavior**: 
- Reads from the memory file at the determined path

**New Behavior**: 
- Read from project-specific file first (if exists)
- Then read from global file as fallback
- Project-specific memories take precedence

**Implementation Steps**:
1. Modified the `readMemoryFileContent` function to check for project-specific file first
2. If project-specific file exists, read from it
3. If not, read from global file
4. Combined the content from both files (with project-specific taking precedence)

### 3. Configuration Management

**New Configuration Option**:
- Added `memoryStorage` to `.qwen/settings.json` with values:
  - "project": Saves to current project's QWEN.md (project-specific)
  - "global": Saves to user-level ~/.qwen/QWEN.md (shared across all projects)
- Default value: "global" for backward compatibility

**Implementation Steps**:
1. Added the configuration to the `memoryToolSchemaData` in `memoryTool.ts`
2. Added the configuration to the `.qwen/settings.json` file
3. Implemented proper reading of the configuration file using `loadMemoryStorageConfig()`
4. Used the configuration value when available, falling back to default

### 4. Migration Tool

**Purpose**: 
- Copy existing global memories to project-specific `QWEN.md`
- Helps users transition from global to project-specific storage

**Features**: 
- Reads from global `~/.qwen/QWEN.md`
- Writes to project-specific `./QWEN.md`
- Preserves all existing memories
- Optional: prompt user to choose between selective and full migration
- Optional: dry run mode to preview what would be migrated
- Proper error handling for file access and I/O operations

**Implementation Steps**:
1. Created a new migration script `migrate-memory.ts`
2. Implemented the migration logic to copy memories from global to project
3. Added selective migration option (only migrate if project-specific file doesn't exist)
4. Added dry run mode to preview what would be migrated
5. Added proper error handling for file access and I/O operations

### 5. Backward Compatibility

**Key Points**: 
- Existing behavior (global-only writing) remains unchanged
- No changes to memory reading logic for context
- The change only affects writing behavior
- Users can continue to use the existing `save_memory` tool with no changes

**Implementation Steps**:
1. Ensured the default scope is `global` when no configuration exists
2. Kept the existing prompt behavior when no scope is specified
3. Tested with existing workflows to ensure no breaking changes

### 6. Testing

**Test Cases**:

| Test Case | Description | Expected Result |
|---------|-------------|-----------------|
| Project-specific file exists | Project-specific `QWEN.md` exists in current directory | Write to project-specific file |
| Project-specific file doesn't exist | No project-specific `QWEN.md` in current directory | Write to global file |
| Configuration set to project | `.qwen/settings.json` has `"memoryStorage": "project"` | Write to project-specific file |
| Configuration set to global | `.qwen/settings.json` has `"memoryStorage": "global"` | Write to global file |
| No configuration | No `memoryStorage` in settings | Write to global file (default) |
| Reading from project-specific | Project-specific file exists | Read from project-specific file first |
| Reading from global | Project-specific file doesn't exist | Read from global file |
| Migration tool | Run migration tool | Copy memories from global to project-specific |
| Migration tool - selective | Run migration with selective=true | Only migrate if project-specific file doesn't exist |
| Migration tool - dry run | Run migration with dryRun=true | Preview what would be migrated without actually migrating |

### 7. Documentation

**Files to Update**:
- `docs/tools/memory.md`: Update documentation to include new configuration options and behavior
- `PROJECT_MEMORY_PLAN.md`: Update with current plan
- `README.md`: Add note about project-specific memory storage

### 8. Code Structure

**Files to Modify**:
- `packages/core/src/tools/memoryTool.ts`: Core memory logic
- `.qwen/settings.json`: Configuration file
- `migrate-memory.ts`: New migration tool

## Implementation Timeline

1. **Phase 1 (Day 1)**: Analyze current code and create detailed plan
2. **Phase 2 (Day 2)**: Implement configuration option and update memory writing logic
3. **Phase 3 (Day 3)**: Implement memory reading logic with precedence
4. **Phase 4 (Day 4)**: Implement migration tool
5. **Phase 5 (Day 5)**: Write tests and verify functionality
6. **Phase 6 (Day 6)**: Update documentation
7. **Phase 7 (Day 7)**: Final review and prepare for commit

## Risk Assessment

| Risk | Mitigation Strategy |
|------|---------------------|
| Breaking existing workflows | Maintain backward compatibility by defaulting to global storage |
| Configuration conflicts | Add clear documentation and validation in the tool |
| Migration issues | Provide clear instructions and optional prompt for migration |
| Performance impact | The changes are minimal and only affect file I/O operations |

## Success Criteria

- All test cases pass
- Backward compatibility is maintained
- Users can easily switch between global and project-specific storage
- Migration tool works correctly with all options
- Documentation is clear and complete

## Dependencies

- Existing `save_memory` tool functionality
- Project-specific file system access
- Configuration file parsing
- File I/O operations

## Status
- Plan complete
- All changes implemented
- Code verified and tested
- Documentation updated