# Native runtime notice

`@qwen-code/cua-sdk` downloads `cua_driver_node_runtime.node` and the matching
Cua Driver SDK library from the same-version Qwen CUA Driver GitHub Release.

`cua_driver_node_runtime.node` is a compatibility build derived from the N-API
runtime in `uniffi-bindgen-react-native` 0.31.0-3, copyright its contributors
and licensed under the Mozilla Public License 2.0. Its corresponding source is
the pinned development dependency plus the deterministic transformations in
`packages/cua-driver/scripts/build-node-runtime.mjs` at the matching release
tag.

<https://www.mozilla.org/MPL/2.0/>
