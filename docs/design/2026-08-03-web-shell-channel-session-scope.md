# Web Shell channel session scope

## Motivation

Channel runtimes already route incoming messages according to `sessionScope`,
but the Web Shell channel editor only renders platform-specific management
fields. Users can therefore configure credentials and access policy, but cannot
choose which conversations share an agent session.

## Design

Add the existing shared `sessionScope` setting to every manageable channel type
in the daemon channel catalog. Preserve a plugin-provided field when one exists;
otherwise advertise an enum with the runtime-supported values and the plugin's
default scope.

Render the field in a dedicated session section of the channel editor. New and
legacy configurations show their effective default, and saving writes the
selected value through the existing channel upsert request.

The available scopes are:

- `user`: one session per sender and chat.
- `thread`: one session per routing thread, falling back to the chat.
- `chat_thread`: one session per chat and nested thread.
- `single`: one session shared by the entire channel instance.

## Compatibility

The runtime router and persisted configuration format are unchanged. Existing
configurations without `sessionScope` retain their current plugin default until
they are edited and saved. Unmanageable channel types do not advertise the
field.

## Verification

- Assert catalog defaults for DingTalk and GitHub.
- Assert the management store accepts every runtime-supported scope.
- Assert new and legacy editor drafts use the effective default.
- Verify the Web Shell can select and persist a non-default scope end to end.
