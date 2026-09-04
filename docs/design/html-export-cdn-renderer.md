# HTML export CDN renderer

HTML exports keep transcript data, CSS, and the CSP nonce inline, but load the renderer and React runtime from exact-version jsDelivr URLs. The renderer is built with the Web Shell transcript component and published as `export-transcript-document.js` in the existing `@qwen-code/qwen-code` npm package.

This keeps each export small while binding its schema to a content-derived renderer identity from the same CLI release. Opening an export requires network access to jsDelivr; an unavailable or stale renderer fails closed, and the browser gate fulfills it with a locally bundled React runtime so CI remains independent of CDN availability.
