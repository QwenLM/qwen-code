import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const nativeRoot = process.env.QWEN_CUA_SDK_NATIVE_DIR
  ? path.resolve(process.env.QWEN_CUA_SDK_NATIVE_DIR)
  : fileURLToPath(new URL("../.native/darwin-universal/", import.meta.url))

test(
  "a missing macOS pasteboard does not prevent creation or recovery",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync(path.join(nativeRoot, "libcua_driver_sdk.dylib")),
  },
  () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "cua-pasteboard-test-"))
    try {
      const library = path.join(scratch, "nil-pasteboard.dylib")
      const compile = spawnSync(
        "clang",
        [
          "-dynamiclib", "-framework", "AppKit",
          fileURLToPath(new URL("./native-macos-pasteboard-fixture.m", import.meta.url)),
          "-o", library,
        ],
        { encoding: "utf8", timeout: 30_000 },
      )
      assert.equal(compile.status, 0, compile.stderr || compile.error?.message)

      const script = `
        import assert from "node:assert/strict";
        import { ComputerUse } from ${JSON.stringify(new URL("../computer-use/index.js", import.meta.url).href)};
        import { writeFileSync } from "node:fs";
        import { CuaDriver, StartSessionInput, ClipboardReadInput, ClipboardWriteInput } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        let computer = await ComputerUse.create();
        try {
          assert.equal(await computer.getPlatform(), "macos");
          assert.equal((await computer.reconnect()).connectionGeneration, 2);
        } finally { await computer.close(); }
        computer = await ComputerUse.create();
        await computer.close();

        const driver = CuaDriver.create(undefined);
        const session = "nullable-pasteboard-test";
        try {
          assert.equal((await driver.startSession(StartSessionInput.new({ session }))).active, true);
          for (const includeText of [false, true]) {
            const result = await driver.clipboardRead(ClipboardReadInput.new({ session, includeText }));
            assert.equal(result.isError, true);
            assert.match(result.text, /clipboard is unavailable/);
          }
          const deniedWrite = await driver.clipboardWrite(ClipboardWriteInput.new({ session, text: "nil test" }));
          assert.equal(deniedWrite.isError, true);
          assert.match(deniedWrite.text, /clipboard is unavailable/);
          process.env.CUA_TEST_NIL_PASTEBOARD = "0";
          // The fixture returns a private named pasteboard, never the user's.
          for (const includeText of [false, true]) {
            const result = await driver.clipboardRead(ClipboardReadInput.new({ session, includeText }));
            assert.equal(result.isError, false);
          }
          const text = "clipboard recovery 中文🙂";
          const textWrite = await driver.clipboardWrite(ClipboardWriteInput.new({ session, text }));
          assert.equal(textWrite.isError, false, textWrite.text);
          const textRead = await driver.clipboardRead(ClipboardReadInput.new({ session, includeText: true }));
          assert.equal(JSON.parse(textRead.structuredJson).text, text);
          const png = ${JSON.stringify(path.join(scratch, "fixture.png"))};
          writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==", "base64"));
          for (const [field, type] of [["imagePath", "public.png"], ["filePath", "public.file-url"]]) {
            const written = await driver.clipboardWrite(ClipboardWriteInput.new({ session, [field]: png }));
            assert.equal(written.isError, false, written.text);
            assert.ok(JSON.parse(written.structuredJson).types.includes(type));
          }
        } finally {
          await driver.shutdown();
          driver.uniffiDestroy();
        }
      `
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          QWEN_CUA_SDK_NATIVE_DIR: nativeRoot,
          DYLD_INSERT_LIBRARIES: library,
          CUA_TEST_NIL_PASTEBOARD: "1",
        },
      })
      assert.equal(child.status, 0, child.stderr || child.error?.message)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  },
)
