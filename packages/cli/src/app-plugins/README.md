# App plugin contracts

Core owns the framework-independent contracts in `builtin-plugins/types.ts`,
exported as types from `@qwen-code/core`: `BuiltinPlugin`, its lifecycle
context, Hook contributions and runtime inputs, and Tool contributions. Skills
use `SkillDefinition` from `@qwen-code/resource`.

The application layer owns `AppPlugin extends BuiltinPlugin`, terminal commands,
and slash commands in this directory's `types.ts`. These are exported as types from
`@qwen-code/qwen-code`, without loading Core or the UI at runtime. Core never
imports CLI or React to describe a plugin.

The product supplies plugin instances through `AppFramework.createAppPlugins()`.
AppFramework owns one `AppPluginRegistry extends BuiltinPluginRegistry` and its
initialization/disposal through the `asyncInitAppPlugins` / `awaitInitAppPlugins`
and `asyncDisposeAppPlugins` / `awaitDisposeAppPlugins` methods. `getAppPlugins()`
returns that same Registry. TUI, headless, SDK, ACP, daemon, remote Worker, and
terminal command entry modes share this ownership model. Config borrows the Registry through
`BuiltinPluginContributions` (no wrapper or second Registry), reads contributions,
and subscribes independently. CLI keeps their command contributions:

- Terminal metadata is available before initialization so help can be assembled
  without authentication or resource initialization. Execution initializes the
  declared components and uses the existing cleanup path. Local management
  commands can request `local` to prepare the host without starting app plugins
  or background synchronization. A trusted product terminal declaration with
  the same primary name replaces the complete host command tree. Alias
  collisions and duplicate declarations from product plugins remain errors.
- `CliOptions.declarations` can supply lightweight `AppPlugin` instances before
  Framework creation. The host reads their terminal hooks without calling
  `initialize()`, so command discovery does not start runtime services.
- A static terminal contribution may return `{ command, hidden, startup }`.
  `startup: 'local'` preserves the ordinary host command lifecycle for actions
  that manage their own output and exit. Other product actions continue to use
  `runTerminalCommand`.
- `resolveTerminalCommands(context)` runs after startup Settings and `.env`
  loading, before argument dispatch. It receives frozen argv, reserved names
  and aliases, explicit headless state, and root value-option flags. Returned
  commands use the ordinary host lifecycle and cannot replace existing names
  or aliases. This does not initialize application plugins or a session.
- Slash commands are read after Core initialization, and reread for completion
  input and execution. They use native `SlashCommand` declarations and
  `action(context, args)` results. Plugin declaration getters must only read current state;
  they must not perform I/O or send refresh notifications.
- Loaders return raw declarations for their own source. `CommandService` alone
  merges current plugin commands, including for the fallback catalog.
- App plugin commands automatically replace same-named host builtins.
  Removing a declaration restores the original host command. Two app plugins
  declaring the same command conflict; dynamic commands never replace builtins.
- Command contributions are unavailable after disposal or failed initialization.
- Tools are contributed as ordinary Core tool instances, like terminal and
  slash commands: the plugin constructs the tool and Core registers it as-is.
  A contribution replaces a same-name Core tool outright, and runs through the
  standard validation, permission, and execution path.
- `notifyChanged()` notifies every live Config subscriber, which refreshes its
  own tools, Hooks and Skills. Disposing a Config removes only its subscription.
  Terminal command
  trees are assembled once at process startup.
- Plugins schedule background work from `initialize()` via `context.whenReady()`
  without blocking initialization. The entry grants this permission through the
  same Registry's `markHostReady()`; it does not imply authentication.

An AppPlugin is a trusted plugin bundled and assembled with the product and
managed by AppFramework. It is distinct from user-installed or marketplace
plugins and does not provide third-party extension isolation. Plugins can use Node.js and Core public services. The
context provides host lifecycle and runtime capabilities, not a security sandbox
or a business-specific service registry.

Command hook `env` accepts a static object. Trusted builtin command hooks can
also supply an `env()` function returning the complete hook environment,
including static values and execution-time credentials. No host context is passed;
the plugin resolves its own runtime values. Security reads the current process VPC
through the existing VPC accessor. The host calls the function before
every spawn; returned strings override inherited values (including case variants),
undefined values remove them, and omitted keys are preserved. Credentials are
therefore never frozen into the registered hook configuration. Registration
attributes such as Skill `source` and `isBuiltin` remain host-owned.

Interactive slash commands render with the CLI's own UI, imported from
`@qwen-code/qwen-code/ui` (Ink primitives, shared dialogs, text buffers, theme,
dialog action registration, clipboard, TUI state snapshot). Plugins keep that
import behind the dynamic import of their dialog module so terminal commands and
headless runs do not load the TUI. Slash actions receive the native CLI command
context; Core lifecycle contracts remain independent of the UI.

Build from the repository root with `npm run build`.
