# Extension conditional rules

[English](extension-conditional-rules.md) | [简体中文](extension-conditional-rules.zh-CN.md)

## Status and problem

Draft implementation for #12030, part of #12028. Rule discovery, migration
documentation and per-extension reporting are implemented; complete runtime
acceptance remains outstanding. The proposed trust and conditional-only
semantics still require maintainer review before landing.

Active extension context files are concatenated into the resident context.
Moving scenario instructions out of those files should reuse existing
path-triggered rules, not introduce a second memory-file matcher or truncate
instructions. Existing context files remain compatible; installing this change
alone does not shrink them.

## Scope and decisions

- Discover `rules/**/*.md` under each enabled extension's effective root,
  including extensions without a context file. Resolve the root from extension
  metadata, never from the parent of a context file.
- Apply the existing workspace folder-trust gate. Untrusted workspaces load
  neither project nor extension rules; global user rules keep existing behavior.
- Accept only rules with nonempty `paths:`. Skip unconditional extension rules
  with a debug warning naming the file. Always-on facts remain in the extension
  context file.
- Reuse the existing parser, exclusions, glob matching, project-root semantics,
  symlink-aware matching, and once-per-session consumption. Patterns match
  workspace files, not the extension installation directory.
- Preserve safe and bare modes, which currently skip rule discovery. Use the
  same discovery path on startup and memory refresh. Disabled extensions must
  not contribute new rules after refresh. Already injected conversation text
  is not retroactively removed.
- Document project rules and extension migration together. Group extension
  memory costs in `/context detail` after #12119, without changing prompt text
  merely to attach reporting metadata.

Absolute warning thresholds belong to #12029. Saved workflows remain tracked
by #11631. Neither is silently considered complete by this change.

## Implementation path

The production core caller is `Config.refreshHierarchicalMemory`, which calls
`loadServerHierarchicalMemory`. AppContainer's manual refresh calls the CLI
wrapper separately. Directory-add refresh calls the core loader directly. All
three callers populate enabled extension roots and bare-mode options; the CLI
wrapper forwards those options.
Thread enabled extension roots through the memory-loading options into
`loadRules`. Do not add an option without populating its production caller.
Audit extension enable/disable and refresh consumers before implementation is
considered complete. Reuse `ConditionalRulesRegistry` for activation.

## Validation and acceptance

### Attribution implementation

Preserve source metadata at the existing memory assembly step, alongside the
exact text actually attached, rather than rereading files for reporting. Use
top-level extension context-file identities, not display paths, to establish
ownership. Imported content belongs to the top-level contributor that inlined
it; repeated inlining is repeated content, not a source-path deduplication case.

Keep metadata paired with its memory snapshot. Generic memory replacement must
invalidate old attribution; startup, manual refresh and directory-add refresh
must populate the same metadata. Direct SDK memory without provenance remains
unknown. Do not infer ownership from nested or forged prompt markers.

Aggregate existing memory detail rows by confirmed extension, replacing those
rows rather than adding another content category. Reuse `{path, tokens}` across
text, Ink, OpenTUI, ACP and Web Shell; preserve the memory subtotal. Loaded
conditional rules remain history content and are not counted again as resident
memory. When the aggregate warning fires, name the largest confirmed extension
contributors from the same snapshot. Warning estimates include different
wrappers than detail rows; do not claim provider-exact billing or equality.

Tests cover imports, duplicate inlining, linked roots, metadata invalidation,
unknown content, and subtotal preservation. Runtime acceptance remains before
the overall work item can be considered complete.

#### Concrete attribution data flow

The loader returns memory sources alongside `memoryContent`: each attached
top-level file contributes its absolute file path, processed/trimmed body and
optional confirmed extension name. Imports stay inside that body. Baseline
rules contribute a separate unowned source; conditional rules do not. Keep
prompt assembly byte-identical, including existing wrappers and separators.
File-source bodies include the existing newline before the closing wrapper,
matching the old detail estimator's convention. A rule-only source has no
invented file path: its text is the actual assembled baseline-rule block.

Pass enabled extensions' names and declared context-file paths through the
existing loader options at all three callers. Resolve canonical identities for
ownership matching, separately from display-path formatting. A file claimed by
more than one extension, or without a resolvable identity, remains unowned.
The output-language file is not owned merely because it shares the extension
context-path input. Do not infer ownership from directory containment.

`setUserMemory` accepts the paired optional sources and clears them when omitted.
Store a defensive snapshot so later mutations of loader results cannot change
attribution. Existing SDK constructor input without sources stays unowned.
No extra serialization or session-record schema is needed: restored sessions
load their current context through the existing discovery path.

For known sources, `/context` derives detail rows directly from source bodies,
not by reparsing nested markers. Existing unknown text retains a conservative
unowned representation. Scale individual rows using the accounting algorithm,
then group rows with the same confirmed owner. Preserve the sum of those rows
exactly during grouping, including fractional-rounding effects. Labels must
sanitize extension names and must not merge an unowned filename with an
identically spelled extension label.

Subtotal preservation compares grouped and ungrouped rows from the same source
snapshot. It does not preserve omissions in the old marker parser: that parser
can omit baseline rules when context-file markers are also present, and nested
markers can cut a body short. Tests must distinguish fixing that missing
coverage from the grouping operation; neither is an input-token reduction.

The current worktree predates #12119. An isolated integration worktree at its
exact `7e7b0bd0` head applies grouping after that PR's existing detail scaling;
all 41 context-command tests pass, including a grouped-versus-ungrouped scaled
subtotal control. Do not introduce a second normalization algorithm when the
branches are combined. The integration worktree's whole build is not evidence:
its 0.24.0 sources were paired with this checkout's 0.24.1 dependencies and the
browser-use declaration build rejected that mismatch before reaching this code.
The absolute warning threshold remains owned by #12029, with contributor names
added here without changing its threshold or truncating memory.

### Existing rule-discovery acceptance

1. Pre-change baseline: the released build does not discover a rule in an
   extension. A matching project rule provides the positive control.
2. Enabled, trusted extension: a matching file operation injects the rule once;
   an unrelated path does not. No rule body appears in the initial prompt.
3. Disabled extension, untrusted workspace, safe mode, and bare mode: no
   extension rule is loaded. Refresh respects the current enabled set.
4. Missing or empty `paths:`, malformed frontmatter, empty files, exclusions,
   nested rule directories, and symlink path boundaries follow the documented
   parser and trust behavior. Unconditional extension rules never become
   baseline rules.
5. Extension with no context file still works; existing global/project rules
   retain their ordering and behavior. Extension discovery is deterministic.
6. Migration example retains always-needed facts and moves only scenario
   instructions. Compare actual assembled payloads before and after migration,
   both before activation and after activation, with pinned configuration.
7. Build, typecheck, focused tests, runtime/script evidence, and two clean
   full-diff audits precede completion. Provider-token savings and task quality
   require separate controlled runs; character differences are not token counts.

## Risks and remaining questions

Conditional instructions arrive only after a matching file operation; they
cannot replace rules needed before any operation. Loaded text can remain in
conversation history and still costs input tokens later. Refresh may reset
consumption according to existing registry lifecycle; test this explicitly
rather than promise stronger deduplication. Confirm effective extension-root
handling for supported manifest formats and linked installations. Do not
introduce a new manifest feature without checking those consumers.

The existing tool scheduler skips local path activation when an execution
environment is configured. Preserve that boundary: this change does not claim
remote-filesystem rule activation. Migration documentation must disclose it.
