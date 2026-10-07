# K2 native JSON transaction digest compatibility

[English](2026-10-08-k2-native-json-digest.md) | [简体中文](2026-10-08-k2-native-json-digest.zh-CN.md)

Status: implemented prerequisite with local component verification; full K2
and cloud qualification remain incomplete. Maintainer review is still required.
Date: 2026-10-08. Refs #12380, #13395, Draft PR #13526.

## 1. Problem and current state

The native TypeScript producer accepts arbitrary finite binary64 numbers inside
JSON event data. It hashes recursively concatenated JSON, sorts every object key
by UTF-16 code units, preserves array order, and uses `JSON.stringify` for scalar
leaves. At baseline `6fbdab868624e361257317ff8e50607366f77320`, Java's
`CsiNativeActivationProof` matched the key and string rules, but sent every numeric
leaf through the structural nonnegative integer parser. It refused valid signed,
fractional, very small, or very large event data. This prerequisite replaces that
numeric conversion without opening a native-history semantic consumer.

Current SQL admission remains deliberately narrow: genesis, original activation,
renewal, and the single initial checkpoint. A correct generic content digest does
not authorize an event, grant, worker, or SQL transition.

## 2. Proposed changes and consumers

Keep the recursive canonicalizer private in `CsiNativeActivationProof`. Replace
only its numeric leaf conversion with finite binary64 serialization matching the
existing native producer. Do not add a dependency or a reusable JSON framework.

Explicitly parse the marker's `firstSequence`, `lastSequence`, and `eventCount`
with the existing structural `number` function before canonical comparisons.
Previously these raw marker fields relied indirectly on the integer-only
canonicalizer. Also require operation/contentDigest/eventsDigest to be strings
and previousCommitDigest to be null or a string, so generic numbers do not expand
the marker type boundary. Keep metadata, event version/sequence, activation, time, resource
reference, and checkpoint structural checks unchanged, including the existing
maximum `9_007_199_254_740_990`.

Consumers are `transaction` (marker equality, marker hash, complete event-array
hash), `activation` (original install reference equality and event-array hash),
and `initialCheckpoint` (event-array hash). `JdbcCsiActivationAdmission` uses these
for fresh commit acceptance and historical replay; both still run the existing
closed semantic admission checks. No route, field, caller, schema, database
migration, boot envelope, or execution admission is added.

## 3. Number and byte decisions

Convert numeric leaves to Java `double`, reject non-finite results, and encode
both signed zeros as `0`. This matches the producer's finite JavaScript Number
model; even a large integral JSON literal uses binary64 semantics for this
content digest. Structural integer fields retain their separate parser.

Java 21's `Double.toString` selects a closest shortest decimal when the minimum
precision is at least two digits. For one-digit values it may instead select a
two-digit decimal, such as `4.9E-324`. Use its stripped `BigDecimal.valueOf`
representation directly unless its precision is two. For that case, round the
exact positive binary64 value (`new BigDecimal(double)`) down and up to one
significant digit. Keep only candidates that round-trip to the same binary64
value; choose the closest exact decimal, with an even significand on ties. If
neither candidate round-trips, keep the Java decimal. This is a design inference
from the [Java 21 conversion contract](<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Double.html#toString(double)>)
and the [ECMAScript Number conversion rules](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-tostring),
checked locally against the actual Node producer as described below. The sampled
verification does not prove agreement over every finite binary64 value.

Format the selected decimal in plain form for decimal exponent `-6..20`,
otherwise use lowercase `e`, an explicit positive exponent sign, and no trailing
fractional zeros. Preserve negative values. The algorithm has at most two
one-digit candidate checks; it does not search all possible precisions or invoke
a JavaScript engine in production. Runtime Broker already requires Java 21.

Object keys continue to sort lexically by UTF-16 code units, including
integer-looking keys. Do not rebuild sorted objects and invoke a serializer,
which can reorder such keys in JavaScript. Strings retain the existing escaping
of lone surrogates and controls, with valid surrogate pairs unchanged. Arrays,
booleans, and null keep their original representations.

Only event/marker content is canonicalized. `payloadJson` strings remain strings;
resource contents, checkpoint bytes, and record-byte digests stay bound to their
original UTF-8 bytes. Their hashes must never be replaced by reserialization.

## 4. Files and scope

Change the Java proof and its collocated test. Add a small test-only Node generator
and a frozen producer-derived transaction fixture under Runtime Broker test
resources. The generator imports the actual built `parseManagedSessionEvent`,
`managedSessionEventsDigest`, and `describeTransaction`; it does not implement a
second canonicalizer. Test envelopes are explicitly synthetic. Use a valid
`cancel.requested.target` JSON value to cover generic leaves without relaxing the
native event parser. Preserve the existing activation fixture unchanged.

No change to TypeScript production behavior or public configuration is required.
Private file history/schema-2, complete SQL batch membership, trusted worker
readback, preparation/execution/publication, consumed receipts, aggregate
DRAINED/RELEASED, physical writer termination, NodeUnpublish, safe volume reuse,
and public Hosted/Spring selection remain outside this prerequisite. No cloud
resources or new authority are needed for its local checks.

## 5. Validation and acceptance

Dry-run the global `qwen` CLI first. It has no Java proof entrypoint; record that
limit and use the actual compiled proof plus actual built TypeScript producer as
the test-script fallback. Before editing, show that valid producer bytes with
signed/fractional leaves are refused, while original activation/renewal pass.

After editing, require complete Java transaction verification of unchanged Node
producer bytes, including the marker and event-array hashes. Cover signed zero,
minimum subnormals, maximum finite values, decimal-format thresholds, large
integral leaves, closest/tie cases, UTF-16 key order, numeric-looking keys, control
escapes, lone surrogates, valid pairs, and raw JSON strings. Add a bounded seeded
binary64 differential corpus through the same actual producer; it is sampled
evidence, not a proof over every finite value.

Reject marker and event structural floats/exponents, negative or oversized
counters, changed hashes/parents/scope, duplicate JSON keys, trailing JSON,
invalid UTF-8, and numeric overflow. Existing activation, initial checkpoint,
resource-byte, fresh SQL admission, and historical replay refusal tests must
remain green. A matching generic transaction must still be rejected by the
private activation/checkpoint semantic gate.

Run root build, typecheck, and bundle before Java checks that load built modules;
run focused Core producer and Runtime Broker proof/SQL tests, Checkstyle and
SpotBugs. Independent test-engineer observes only and owns its temporary files
and processes. Preserve failed attempts; count repeated corpora once. Audit the
full diff twice and attempt the repository native review through its real
workflow. Keep Draft and report any unavailable review; no manual substitute
constitutes approval.

Local candidate results: root build, typecheck and bundle passed; 221 focused
Core tests and 225 Java tests passed with no skips, along with scoped ESLint,
Prettier, Checkstyle and SpotBugs. The independent baseline reproduced five valid
numeric rejections. Independent post-change verification accepted those original
inputs and completed 12,206 expected observations with no unexpected failures:
12,000 separately seeded numeric transactions, 98 curated numeric transactions,
and 108 controls covering the frozen fixture, baseline, structural/hash/encoding
refusals, and closed semantic/resource boundaries. The generated 35,381-byte
fixture was byte-identical (SHA-256
`48da8ddf981bbbf564941dd0060db8a4d9b85d3aa6ab248035f9638962384d5b`).
These observation counts are separate from the 446 focused tests. Evidence inputs
were checked for drift and owned temporary files/processes were cleaned up. No
model, DB server, CSI mount, cloud run or full K2 acceptance was exercised.

## 6. Risks and remaining questions

The small numeric correction depends on Java 21's documented conversion contract.
Fixtures must come from actual Node production functions and be regenerated
byte-for-byte; Java-generated expected hashes would hide incompatibility. Generic
JSON data must not bypass structural integer gates or closed semantic admission.

There are no product options to choose in this prerequisite. Exact performance
and cross-language agreement are verification tasks. Any observed mismatch
requires revisiting the algorithm before shipping; successful local samples do
not qualify full K2 or a new cloud run.
