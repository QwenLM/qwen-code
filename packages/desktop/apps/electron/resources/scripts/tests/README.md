# Document Tool Smoke Tests

This folder contains smoke tests for bundled CLI tools under `apps/electron/resources/scripts/`.

## Run all tool smoke tests

From repo root:

```bash
python3 -m unittest \
  apps.electron.resources.scripts.tests.test_pdf_tool_smoke \
  apps.electron.resources.scripts.tests.test_xlsx_tool_smoke \
  apps.electron.resources.scripts.tests.test_docx_tool_smoke \
  apps.electron.resources.scripts.tests.test_pptx_tool_smoke \
  apps.electron.resources.scripts.tests.test_img_tool_smoke \
  apps.electron.resources.scripts.tests.test_ical_tool_smoke \
  apps.electron.resources.scripts.tests.test_doc_diff_smoke \
  apps.electron.resources.scripts.tests.test_markitdown_smoke
```

Or use the root script:

```bash
bun run test:doc-tools
```

## Run a single suite

```bash
python3 -m unittest apps.electron.resources.scripts.tests.test_xlsx_tool_smoke
```

## Notes

- Tests execute the **wrapper binaries** in `resources/bin/*` (not scripts directly).
- The shared harness configures `CRAFT_UV`, `CRAFT_SCRIPTS`, and `PATH`.
- If bundled `uv` is missing for your platform, harness falls back to `uv` on PATH.
- Tests create temporary fixtures at runtime and clean them up automatically.

## Contributor expectation

If you modify any script in `apps/electron/resources/scripts/` or wrapper in `apps/electron/resources/bin/`, update/add relevant smoke tests in this folder.
