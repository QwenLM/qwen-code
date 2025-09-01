# Custom Tools

Qwen Code can be extended with your own custom tools. By creating simple JavaScript files in a special directory, you can add new capabilities to the agent, which it can then use to help you with your tasks.

## Getting Started

1.  **Create the Tools Directory:** In your home directory, create a `.qwen` folder if it doesn't already exist, and inside that, create a `tools` folder.

    ```bash
    mkdir -p ~/.qwen/tools
    ```

2.  **Create a Tool File:** Inside `~/.qwen/tools/`, create a new JavaScript file (e.g., `my-tool.js`).

On startup, Qwen Code will automatically discover and load any `.js` or `.ts` files from this directory.

## Tool File Format

Each tool file must export a default object that defines the tool's structure and behavior. This object must conform to the following interface:

- `name` (string, required): The name of the tool that the agent will use to call it (e.g., `my_custom_tool`).
- `description` (string, required): A detailed description of what the tool does. This is crucial for the agent to understand when and how to use the tool.
- `parameterSchema` (object, optional): A JSON Schema object defining the parameters the tool accepts.
- `build` (function, required): A function that receives the parameters and returns an `Invocation` object.
- `displayName` (string, optional): A user-friendly name for the tool. Defaults to `name`.
- `kind` (string, optional): The kind of tool, used for categorization. Defaults to `'other'`.

### The Invocation Object

The `build` function must return an object (or a class instance) that has an `execute` method.

- `execute()`: This method contains the core logic of your tool. It should return a `Promise` that resolves to a `ToolResult` object.

### The ToolResult Object

The `ToolResult` object that your `execute` method returns should have the following properties:

- `llmContent` (string): The factual output of the tool. This is what the agent will see and use in its next reasoning step.
- `returnDisplay` (string): A user-friendly string to display in the UI after the tool is executed.
- `summary` (string, optional): A short, one-line summary of the tool's action (e.g., "Echoed a message.").

## Example: An Echo Tool

Here is a complete example of a simple tool that echoes back a message. You can use this as a template for your own tools.

**File:** `~/.qwen/tools/echo.js`

```javascript
// A simple invocation class for the echo tool.
class EchoInvocation {
  constructor(params) {
    this.params = params;
  }

  execute() {
    const result = {
      llmContent: `The tool echoed: ${this.params.message}`,
      returnDisplay: `Echo: ${this.params.message}`,
      summary: `Echoed a message.`,
    };
    return Promise.resolve(result);
  }
}

export default {
  name: 'custom_echo',
  displayName: 'Echo Tool',
  description: 'A custom tool that takes a message and echoes it back.',
  kind: 'other',
  isOutputMarkdown: false,
  canUpdateOutput: false,
  parameterSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to echo back.',
      },
    },
    required: ['message'],
  },
  build: (params) => {
    return new EchoInvocation(params);
  },
};
```

Once this file is in place, you can start Qwen Code and instruct the agent to use it:

`> Use the custom_echo tool to say "hello from my new tool"`
