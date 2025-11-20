# Multi-Agent Team Collaboration System

This system enables built-in agents to work together effectively across multiple phases of a software project. The implementation orchestrates all built-in agents in a coordinated workflow.

## Agent Roles

The system leverages these built-in agents in a coordinated manner:

- **general-purpose** - General research and multi-step tasks to critical thinking, supervise and overall control
- **deep-web-search** - Web research and information gathering
- **project-manager** - Manage resources, targets and project-tasks
- **deep-planner** - Planning master plan
- **deep-researcher** - Investigation of technical solutions
- **software-architecture** - Design system architecture
- **software-engineer** - Implement solution based on design
- **software-tester** - Validate implementation

## Workflow Phases

The complete workflow orchestrates all agents through these phases:

### 1. Project Phase

- Uses `project-manager` agent to establish project scope, timeline, resources, and constraints

### 2. Planning Phase

- Uses `deep-planner` agent to create a detailed technical architecture plan

### 3. Research Phase

- Uses `deep-researcher` agent for in-depth investigation of solutions
- Uses `deep-web-search` agent for web-based research and information gathering

### 4. Design Phase

- Uses `software-architecture` agent to design the system architecture

### 5. Implementation Phase

- Uses `software-engineer` agent to implement the solution based on design

### 6. Testing Phase

- Uses `software-tester` agent to validate the implementation

### 7. Review Phase

- Uses `general-purpose` agent as supervisor for final review and assessment

## Usage

### Simple Usage

```typescript
import { createAndExecuteProjectWorkflow } from '@qwen-code/core/agent-collaboration';

const projectOptions = {
  projectName: 'ecommerce-platform',
  projectGoal: 'Build a scalable e-commerce platform...',
  timeline: '3 months',
  stakeholders: ['Product Manager', 'Development Team'],
  constraints: ['Budget', 'Timeline', 'Security Requirements'],
};

const results = await createAndExecuteProjectWorkflow(config, projectOptions);
```

### Advanced Usage

```typescript
import { ProjectWorkflowOrchestrator } from '@qwen-code/core/agent-collaboration';

const orchestrator = new ProjectWorkflowOrchestrator(config, projectOptions);

// Create workflow steps
const steps = await orchestrator.createProjectWorkflow();

// Execute as orchestrated workflow
const result = await orchestrator.executeAsWorkflow();
```

## Key Features

1. **Shared Memory System**: All agents coordinate through shared memory to exchange information and context
2. **Dependency Management**: Each phase properly depends on the completion of previous phases
3. **Error Handling**: Each phase has proper error handling and reporting
4. **Audit Trail**: All agent actions are logged and traceable
5. **Flexible Configuration**: Project-specific options and constraints

## Benefits

- **Complete Automation**: From project conception to testing, all handled by specialized agents
- **Quality Assurance**: Each phase is validated before moving to the next
- **Expertise Distribution**: Each agent applies its specialized knowledge to its respective phase
- **Coordination**: All agents work together through shared context and communication
- **Scalability**: Can be adapted to projects of various sizes and complexity

This system enables built-in agents to work smarter together as a team by providing a structured approach to collaboration across all phases of a software project.
