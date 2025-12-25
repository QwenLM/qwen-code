# Exit Plan Mode Tool (`exit_plan_mode`)

This document describes the `exit_plan_mode` tool for Qwen Code.

## Description

Use `exit_plan_mode` when you are in plan mode and have finished presenting your implementation plan. This tool prompts the user to approve or reject the plan and transitions from planning mode to implementation mode.

The tool is specifically designed for tasks that require planning implementation steps before writing code. It should NOT be used for research or information-gathering tasks.

### Arguments

`exit_plan_mode` takes one argument:

- `plan` (string, required): The implementation plan you want to present to the user for approval. This should be a concise, markdown-formatted plan describing the implementation steps.

## How to use `exit_plan_mode` with Qwen Code

The Exit Plan Mode tool is part of Qwen Code's planning workflow. When you're in plan mode (typically after exploring a codebase and designing an implementation approach), you use this tool to:

1. Present your implementation plan to the user
2. Request approval to proceed with implementation
3. Transition from plan mode to implementation mode based on user response

The tool will prompt the user with your plan and provide options to:

- **Proceed Once**: Approve the plan for this session only
- **Proceed Always**: Approve the plan and enable auto-approval for future edit operations
- **Cancel**: Reject the plan and remain in planning mode

Usage:

```
exit_plan_mode(plan="Your detailed implementation plan here...")
```

## When to Use This Tool

Use `exit_plan_mode` when:

1. **Implementation tasks**: You are planning the implementation steps for a coding task
2. **Plan completion**: You have finished exploring and designing your implementation approach
3. **User approval needed**: You need user confirmation before proceeding with code changes
4. **Code writing tasks**: The task involves writing, modifying, or refactoring code

### Examples of appropriate usage:

- "Help me implement user authentication" → Use after planning the auth system implementation
- "Add a new API endpoint for user management" → Use after designing the endpoint structure
- "Refactor the database layer to use TypeORM" → Use after planning the refactoring approach

## When NOT to Use This Tool

Do NOT use `exit_plan_mode` for:

1. **Research tasks**: Tasks focused on understanding or exploring existing code
2. **Information gathering**: When you're searching, reading, or analyzing without implementing
3. **Documentation tasks**: When creating documentation without code changes
4. **Analysis tasks**: When providing explanations or reviews without implementation

### Examples of inappropriate usage:

- "Search for and understand the implementation of vim mode in the codebase" → Don't use (research task)
- "Explain how the authentication system works" → Don't use (analysis task)
- "Find all TODO comments in the project" → Don't use (information gathering)

## `exit_plan_mode` examples

### Implementation planning example

```
exit_plan_mode(plan="## Implementation Plan for User Dashboard

### 1. Create Dashboard Components
- Create `UserDashboard.tsx` with main dashboard layout
- Add `DashboardStats.tsx` for displaying user statistics
- Implement `ActivityFeed.tsx` for recent user activities

### 2. Add API Integration
- Create `dashboardApi.ts` for dashboard data fetching
- Add endpoints for user stats and activity data
- Implement error handling and loading states

### 3. Update Routing
- Add dashboard route in `App.tsx`
- Update navigation component with dashboard link
- Add route protection for authenticated users

### 4. Testing and Documentation
- Write unit tests for dashboard components
- Add integration tests for API calls
- Update user documentation with dashboard features

This implementation will take approximately 4-6 hours and requires changes to 8-10 files.")
```

### Refactoring plan example

```
exit_plan_mode(plan="## Database Layer Refactoring Plan

### Phase 1: Setup and Configuration
- Install and configure TypeORM dependencies
- Create database connection configuration
- Set up entity definitions for existing models

### Phase 2: Migration
- Create migration scripts for existing data
- Implement new repository pattern using TypeORM
- Replace raw SQL queries with TypeORM query builder

### Phase 3: Testing and Validation
- Update all database tests to use TypeORM
- Validate data integrity after migration
- Performance testing to ensure no regressions

This refactoring will modernize our database layer while maintaining backward compatibility.")
```

## User Response Handling

After calling `exit_plan_mode`, the user can respond in several ways:

- **Proceed Once**: The plan is approved for immediate implementation with default confirmation settings
- **Proceed Always**: The plan is approved and auto-approval is enabled for subsequent edit operations
- **Cancel**: The plan is rejected, and the system remains in plan mode for further planning

The tool automatically adjusts the approval mode based on the user's choice, streamlining the implementation process according to user preferences.

## Important Notes

- **Plan mode only**: This tool should only be used when you are currently in plan mode
- **Implementation focus**: Only use for tasks that involve writing or modifying code
- **Concise plans**: Keep plans focused and concise - aim for clarity over exhaustive detail
- **Markdown support**: Plans support markdown formatting for better readability
- **Single use**: The tool should be used once per planning session when ready to proceed
- **User control**: The final decision to proceed always rests with the user

## Integration with Planning Workflow

The Exit Plan Mode tool is part of a larger planning workflow:

1. **Enter Plan Mode**: User requests or system determines planning is needed
2. **Exploration Phase**: Analyze codebase, understand requirements, explore options
3. **Plan Design**: Create implementation strategy based on exploration
4. **Plan Presentation**: Use `exit_plan_mode` to present plan to user
5. **Implementation Phase**: Upon approval, proceed with planned implementation

This workflow ensures thoughtful implementation approaches and gives users control over significant code changes.
