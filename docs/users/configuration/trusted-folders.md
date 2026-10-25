# Trusted Folders

The Trusted Folders feature is a security setting that gives you control over which projects can use the full capabilities of the Qwen Code. It prevents potentially malicious code from running by asking you to approve a folder before the CLI loads any project-specific configurations from it.

## Enabling the Feature

The Trusted Folders feature is **disabled by default**. To use it, you must first enable it in your settings.

Add the following to your user `settings.json` file:

```json
{
  "security": {
    "folderTrust": {
      "enabled": true
    }
  }
}
```

## How It Works: The Trust Dialog

Once the feature is enabled, the first time you run the Qwen Code from a folder, a dialog will automatically appear, prompting you to make a choice:

- **Trust folder**: Grants full trust to the current folder (e.g. `my-project`).
- **Trust parent folder**: Grants trust to the parent directory (e.g. `safe-projects`), which automatically trusts all of its subdirectories as well. This is useful if you keep all your safe projects in one place.
- **Don't trust**: Marks the folder as untrusted. The CLI will operate in a restricted "safe mode."

Your choice is saved in a central file (`~/.qwen/trustedFolders.json`), so you will only be asked once per folder.

The feature fails closed: until you make a choice, a folder counts as **untrusted**, not as trusted-by-default. If that file is missing — a new machine, a restored home directory, a synced dotfiles setup — every folder that no higher-priority signal decides (see "The Trust Check Process (Advanced)" below) starts untrusted, including folders you trusted before. When a trust check reaches the file rules, an unreadable file, invalid JSONC syntax, or a non-object document is a hard configuration error. A failed cached load makes the CLI stop with "Please fix the configuration file and try again." and the daemon's v1 trust checks answer `500 trusted_folders_invalid`; a prior IDE trust decision can bypass these file-based checks. The grant writer still validates the file before persisting a rule. Repair or remove the file by hand, then restart the daemon to clear the failed load. Comments and trailing commas are accepted. Invalid trust-level values are detected by the grant writer and v2 policy reader, but are not validated by the legacy v1 reader; v2 reports policy errors as `200` with `configured.state: "error"`. A file that becomes invalid after the cached load can instead fail during the grant write with `500 internal_error`, or during post-write policy verification with `409 trust_grant_ineffective`.

## Why Trust Matters: The Impact of an Untrusted Workspace

When a folder is **untrusted**, the Qwen Code runs in a restricted "safe mode" to protect you. In this mode, the following features are disabled:

1.  **Workspace Settings are Ignored**: The CLI will **not** load the `.qwen/settings.json` file from the project. This prevents the loading of custom tools and other potentially dangerous configurations.

2.  **Environment Variables are Ignored**: The CLI will **not** load any `.env` files from the project.

3.  **Extension Management is Restricted**: You **cannot install, update, or uninstall** extensions.

4.  **Tool Auto-Acceptance is Disabled**: You will always be prompted before any tool is run, even if you have auto-acceptance enabled globally.

5.  **Automatic Memory Loading is Disabled**: The CLI will not automatically load files into context from directories specified in local settings.

Granting trust to a folder unlocks the full functionality of the Qwen Code for that workspace.

## Managing Your Trust Settings

If you need to change a decision or see all your settings, you have a couple of options:

- **Change the Current Folder's Trust**: Run the `/permissions` command from within the CLI. This will bring up the same interactive dialog, allowing you to change the trust level for the current folder.

- **Trust a Workspace From the Web Shell**: Open the workspaces overview and use the **Trust** action on an untrusted workspace. This records the same decision without needing a terminal, which is the way back if every workspace came up untrusted because no rule decided them. The action appears only when the connected daemon advertises `workspace_trust_grant`, which it does only where trust hot-reload applies the decision to the running runtime — a daemon that serves the grant routes without hot-reload hides the action. There, a grant recorded through that daemon's own API updates the trust file and v1 trust status immediately, but startup-bound runtime gates require a restart. A decision recorded by a separate terminal process or a file edit is not immediately visible to the daemon's cached v1 status; restart the daemon to load it. Where the action is available, the workspace finishes becoming trusted once the daemon has rebuilt its runtime, which takes a moment.

- **View All Trust Rules**: To see a complete list of all your trusted and untrusted folder rules, you can inspect the contents of the `~/.qwen/trustedFolders.json` file in your home directory.

## The Trust Check Process (Advanced)

For advanced users, it's helpful to know the exact order of operations for how trust is determined:

1.  **IDE Trust Signal**: If you are using the [IDE Integration](../ide-integration/ide-integration), the CLI first asks the IDE if the workspace is trusted. The IDE's response takes highest priority.

2.  **Local Trust File**: If the IDE is not connected, the CLI checks the central `~/.qwen/trustedFolders.json` file.
