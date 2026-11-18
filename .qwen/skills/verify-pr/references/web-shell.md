# Verifying Web Shell changes

Bind the development server to loopback and open the shell in a browser that can reach it. Use the same workspace configuration and browser steps on base and head.

## Exercise an older daemon's capability fallback

Run the scenario once with the daemon's advertised capabilities. For the second run, register a Playwright route for `/capabilities` before the page loads. Fetch the real response with `route.fetch()`, remove only the feature under test, then return the edited response with `route.fulfill()`. Record which capability you removed. In [the secondary-workspace status check](https://github.com/QwenLM/qwen-code/pull/12943#issuecomment-5988053379), removing `workspace_session_live_state` exercised the fallback while the real daemon handled the session. Describe this run as an emulation of the older capability set.

## Verify a partially applied settings change

Start with Live disabled and no stored key. Enter a disposable key, enable Live, and save. At the network boundary, let the real daemon persist the key and return an error for activation. Let the client's refresh reach the daemon and check that `keyConfigured` changed. Then inspect the form. In [the Live settings regression](https://github.com/QwenLM/qwen-code/pull/12943#issuecomment-5988053379), the base showed “Settings changed elsewhere” and disabled Save. The fix showed “Configured” and kept Save available.

## Create a channel session through its adapter

Follow the [example channel's quick start](../../../../packages/channels/plugin-example/README.md) to link the extension and start its mock messaging server. Set the channel's working directory to a registered, trusted test workspace. Start the daemon with `qwen serve --channel my-plugin-test` and send a uniquely identifiable message through the mock server. Check that the channel session appears in the intended workspace and that the reply reaches the sender. This exercises the daemon and its channel worker without an external messaging account. [Channel verification report](https://github.com/QwenLM/qwen-code/pull/12943#issuecomment-5988053379)

## Prove that a model turn completed

The prompt can appear in the user bubble, session title, and sidebar as soon as you send it. Capture the session ID and look for a backend completion event or a token-usage record for that session and model. In [the ordinary and Hosted session check](https://github.com/QwenLM/qwen-code/pull/13218#issuecomment-5970660737), all three Hosted turns completed and their session IDs matched usage records for `qwen3.8-max`.
