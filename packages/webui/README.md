# @qwen-code/webui

A shared React component library for Qwen Code applications, providing cross-platform UI components with consistent styling and behavior.

## Features

- **Cross-platform support**: Components work seamlessly across VS Code extension, web, and other platforms
- **Platform Context**: Abstraction layer for platform-specific capabilities
- **Tailwind CSS**: Shared styling preset for consistent design
- **TypeScript**: Full type definitions for all components
- **Storybook**: Interactive component documentation and development
- **Multiple Build Formats**: Supports ESM, CJS, and UMD formats for different environments
- **CDN Usage**: Can be loaded directly in browsers via CDN

## Installation

```bash
npm install @qwen-code/webui
```

## CDN Usage

You can also use this library directly in the browser via CDN:

### Option 1: With JSX Support (using Babel)

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Load React -->
    <script
      crossorigin
      src="https://unpkg.com/react@18/umd/react.production.min.js"
    ></script>
    <script
      crossorigin
      src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"
    ></script>

    <!-- Load Babel Standalone for JSX processing -->
    <script src="https://unpkg.com/@babel/standalone@7.23.6/babel.min.js"></script>

    <!-- Manually create the jsxRuntime object to satisfy the dependency -->
    <script>
      // Provide a minimal JSX runtime for builds that expect react/jsx-runtime globals.
      const withKey = (props, key) =>
        key == null ? props : Object.assign({}, props, { key });
      const jsx = (type, props, key) =>
        React.createElement(type, withKey(props, key));
      const jsxRuntime = {
        Fragment: React.Fragment,
        jsx,
        jsxs: jsx,
        jsxDEV: jsx,
      };

      window.ReactJSXRuntime = jsxRuntime;
      window['react/jsx-runtime'] = jsxRuntime;
      window['react/jsx-dev-runtime'] = jsxRuntime;
    </script>

    <!-- Load the webui library -->
    <script src="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/index.umd.js"></script>

    <!-- Load the CSS -->
    <link
      rel="stylesheet"
      href="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/styles.css"
    />
  </head>
  <body>
    <div id="root"></div>

    <script type="text/babel">
      // Access components from the global QwenCodeWebUI object
      const { ChatViewer } = QwenCodeWebUI;

      // Use the components with JSX support
      const App = () => (
        <ChatViewer messages={/* your messages */} />
      );

      ReactDOM.render(<App />, document.getElementById('root'));
    </script>
  </body>
</html>
```

### Option 2: Without JSX (using React.createElement directly)

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Load React -->
    <script
      crossorigin
      src="https://unpkg.com/react@18/umd/react.production.min.js"
    ></script>
    <script
      crossorigin
      src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"
    ></script>

    <!-- Manually create the jsxRuntime object to satisfy the dependency -->
    <script>
      // Provide a minimal JSX runtime for builds that expect react/jsx-runtime globals.
      const withKey = (props, key) =>
        key == null ? props : Object.assign({}, props, { key });
      const jsx = (type, props, key) =>
        React.createElement(type, withKey(props, key));
      const jsxRuntime = {
        Fragment: React.Fragment,
        jsx,
        jsxs: jsx,
        jsxDEV: jsx,
      };

      window.ReactJSXRuntime = jsxRuntime;
      window['react/jsx-runtime'] = jsxRuntime;
      window['react/jsx-dev-runtime'] = jsxRuntime;
    </script>

    <!-- Load the webui library -->
    <script src="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/index.umd.js"></script>

    <!-- Load the CSS -->
    <link
      rel="stylesheet"
      href="https://unpkg.com/@qwen-code/webui@0.1.0-beta.2/dist/styles.css"
    />
  </head>
  <body>
    <div id="root"></div>

    <script>
      // Access components from the global QwenCodeWebUI object
      const { ChatViewer } = QwenCodeWebUI;

      // Use the components with React.createElement (no JSX)
      const App = React.createElement(ChatViewer, {
        messages: [
          /* your messages */
        ],
      });

      ReactDOM.render(App, document.getElementById('root'));
    </script>
  </body>
</html>
```

For a complete working example, see [examples/cdn-usage-demo.html](./examples/cdn-usage-demo.html).

## Quick Start

```tsx
import { Button, Input, Tooltip } from '@qwen-code/webui';
import { PlatformProvider } from '@qwen-code/webui/context';

function App() {
  return (
    <PlatformProvider value={platformContext}>
      <Button variant="primary" onClick={handleClick}>
        Click me
      </Button>
    </PlatformProvider>
  );
}
```

## Components

### UI Components

#### Button

```tsx
import { Button } from '@qwen-code/webui';

<Button variant="primary" size="md" loading={false}>
  Submit
</Button>;
```

**Props:**

- `variant`: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline'
- `size`: 'sm' | 'md' | 'lg'
- `loading`: boolean
- `leftIcon`: ReactNode
- `rightIcon`: ReactNode
- `fullWidth`: boolean

#### Input

```tsx
import { Input } from '@qwen-code/webui';

<Input
  label="Email"
  placeholder="Enter email"
  error={hasError}
  errorMessage="Invalid email"
/>;
```

**Props:**

- `size`: 'sm' | 'md' | 'lg'
- `error`: boolean
- `errorMessage`: string
- `label`: string
- `helperText`: string
- `leftElement`: ReactNode
- `rightElement`: ReactNode

#### Tooltip

```tsx
import { Tooltip } from '@qwen-code/webui';

<Tooltip content="Helpful tip">
  <span>Hover me</span>
</Tooltip>;
```

### Icons

```tsx
import { FileIcon, FolderIcon, CheckIcon } from '@qwen-code/webui/icons';

<FileIcon size={16} className="text-gray-500" />;
```

Available icon categories:

- **FileIcons**: FileIcon, FolderIcon, SaveDocumentIcon
- **StatusIcons**: CheckIcon, ErrorIcon, WarningIcon, LoadingIcon
- **NavigationIcons**: ArrowLeftIcon, ArrowRightIcon, ChevronIcon
- **EditIcons**: EditIcon, DeleteIcon, CopyIcon
- **SpecialIcons**: SendIcon, StopIcon, CloseIcon

### Layout Components

- `Container`: Main layout wrapper
- `Header`: Application header
- `Footer`: Application footer
- `Sidebar`: Side navigation
- `Main`: Main content area

### Message Components

- `Message`: Chat message display
- `MessageList`: List of messages
- `MessageInput`: Message input field
- `WaitingMessage`: Loading/waiting state
- `InterruptedMessage`: Interrupted state display

## Platform Context

The Platform Context provides an abstraction layer for platform-specific capabilities:

```tsx
import { PlatformProvider, usePlatform } from '@qwen-code/webui/context';

const platformContext = {
  postMessage: (message) => vscode.postMessage(message),
  onMessage: (handler) => {
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  },
  openFile: (path) => {
    /* platform-specific */
  },
  platform: 'vscode',
};

function App() {
  return (
    <PlatformProvider value={platformContext}>
      <YourApp />
    </PlatformProvider>
  );
}

function Component() {
  const { postMessage, platform } = usePlatform();
  // Use platform capabilities
}
```

## Tailwind Preset

Use the shared Tailwind preset for consistent styling:

```js
// tailwind.config.js
module.exports = {
  presets: [require('@qwen-code/webui/tailwind.preset.cjs')],
  // your customizations
};
```

## Development

### Running Storybook

```bash
cd packages/webui
npm run storybook
```

### Building

```bash
npm run build
```

### Type Checking

```bash
npm run typecheck
```

## Project Structure

```
packages/webui/
├── src/
│   ├── components/
│   │   ├── icons/          # Icon components
│   │   ├── layout/         # Layout components
│   │   ├── messages/       # Message components
│   │   └── ui/             # UI primitives
│   ├── context/            # Platform context
│   ├── hooks/              # Custom hooks
│   └── types/              # Type definitions
├── .storybook/             # Storybook config
├── tailwind.preset.cjs     # Shared Tailwind preset
└── vite.config.ts          # Build configuration
```

## License

Apache-2.0
