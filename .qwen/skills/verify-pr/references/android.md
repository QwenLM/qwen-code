# Native Android (`packages/mobile-shell/`) verification recipe

Read this before scoping a PR that touches `packages/mobile-shell/` or the
daemon-served Web Shell and routes it consumes. The
measured observations below come from maintainer rounds on #12121, #12129
and #12130.
Re-measure anything your round depends on, because image contents and tool
versions drift.

## Where each step can run

- **CI verify lane.** The `node:22-bookworm` image has no `java` and no
  `sdkmanager`/`adb`, and the job does not pass `/dev/kvm` into the
  container. Installing a JDK and the SDK there has not been measured
  against the lane budget. Before planning, check with
  `command -v java`, `ls /dev/kvm` and `uname -m`. At best the lane can build
  the package and run the JVM tests. Device and WebView claims go under
  _Not covered_.
- **Android device-test CI.** This is a separate job from the verify lane:
  `.github/workflows/mobile-shell.yml` owns the `device-tests` matrix and its
  trigger filters. Read that workflow in the reviewed checkout before making
  a claim about current CI coverage.
- **Building runs PR code.** The PR can edit the `gradlew` / `gradlew.bat`
  launchers, wrapper jar, `gradle/wrapper/gradle-wrapper.properties`
  (distribution URL and checksum), `settings.gradle.kts`, `build.gradle.kts`
  and `gradle.properties`. The skill's local-invocation
  isolation rule applies to the build. AGP 8.2 publishes its Linux `aapt2`
  as an x86-64 binary only; there is no `linux-aarch64` classifier. So an
  arm64 Linux host or container (Colima, an Orange Pi) cannot build this
  package without x86 emulation, while macOS arm64 builds natively. An
  x86-64 Linux VM with nested KVM could both build and run the emulator in
  isolation, but no such setup has been measured yet. If isolation is
  unavailable, follow SKILL.md: ask the maintainer to trigger the sandboxed
  `@qwen-code /verify` lane and record device claims it cannot run as
  _Not covered_. Reading changed launchers and build scripts or checking
  hashes does not replace isolation.
- **The emulator and the APK.** The emulator needs hardware virtualization
  (HVF on macOS, KVM on Linux), so it cannot run in a container that has no
  `/dev/kvm`.
  Code inside an installed APK runs in the emulator's own app sandbox. The
  daemon the app talks to must also run inside the credential-free isolation
  boundary: a disposable daemon with its own token, scratch `QWEN_HOME`
  and scratch workspace. A scratch directory alone does not sandbox its
  tools. Never forward the APK to a daemon owning real sessions or a working
  checkout. Reach the isolated daemon with
  `adb reverse tcp:<daemon-port> tcp:<daemon-port>`. The shell's
  network-security config allows cleartext only for loopback, so use
  `http://127.0.0.1:<daemon-port>`.

## Build

JDK 17 (`JAVA_HOME`), plus `ANDROID_HOME` pointing at an SDK with command-line
tools (`sdkmanager` and `avdmanager`), `platform-tools`, `emulator`,
`platforms;android-34` and
`build-tools;34.0.0`. Compare the wrapper jar's SHA-256 with
`gradle-wrapper.jar.sha256`: use `sha256sum` on Linux or `shasum -a 256` on
macOS, comparing only the digest with the whitespace-trimmed checksum file.
Both files are PR-controlled, so this detects corruption, not substitution.
For provenance, compare against the trusted base checksum or the official
Gradle checksum for the declared wrapper version; explain intentional
upgrades separately. Then, from
`packages/mobile-shell/`:

```bash
./gradlew --no-daemon :app:assembleDebug :app:assembleRelease \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest
```

This took 2 m 53 s on an M1 Max with a warm Gradle dependency cache. JVM
results are in `app/build/test-results/testDebugUnitTest/*.xml`, and the lint
issue list is in `app/build/reports/lint-results-debug.xml`. A large
`sdkmanager` package can fail with "Unexpected end of ZLIB input stream";
retry that one package.

## Pick emulator images by WebView capability

Install each required system image, then create a uniquely named AVD. For
example, with the SDK command-line tools on a macOS arm64 host:

```bash
sdkmanager "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n verify-api35 -k "system-images;android-35;google_apis;arm64-v8a"
emulator -list-avds
```

Review and accept the SDK license prompts (or use `sdkmanager --licenses`)
and answer the AVD hardware-profile prompt. Repeat with API 26 and API 36
and distinct names for the three-image rig. Use the created name, or an
existing name from `emulator -list-avds`, as `<name>` below. Choose an ABI
supported by your host; this arm64 example does not describe CI's x86/x86_64
images. Command syntax: [sdkmanager](https://developer.android.com/tools/sdkmanager)
and [avdmanager](https://developer.android.com/tools/avdmanager).

The shell's guards depend on WebView features, not on the API level. On
Google APIs images the WebView version is fixed at image build time, with no
Play Store updates. Measured on `google_apis;arm64-v8a` images; read the
version with `adb shell dumpsys webviewupdate`:

| Image  | WebView        | `MULTI_PROFILE` | `DELETE_BROWSING_DATA` |
| :----- | :------------- | :-------------- | :--------------------- |
| API 26 | 58.0.3029.125  | no              | —                      |
| API 35 | 124.0.6367.219 | yes             | no                     |
| API 36 | 133.0.6943.137 | yes             | yes                    |

The feature columns come from which capability-gated device tests ran and
which were skipped. API 26 sits below the shell's WebView 111 floor, so it
can reach the update-guidance path by manually connecting; the committed device
tests do not assert that below-floor path. Do not credit the API 26 CI lane
with that UI coverage. The API 35 row is the only one where the "profiles
supported, clearing not supported" branch executed in that round. For current
CI coverage, use the `device-tests` matrix in `.github/workflows/mobile-shell.yml`:
read its `api-level:`, `arch:` and `require-profiles:` entries, then confirm
the actual WebView capabilities and per-test statuses in each executed lane.
An API level alone does not establish coverage, including for a newly added
matrix row. Without run evidence, label the coverage assessment as inferred.

## Isolate the rig from concurrent sessions

- Use a private adb server, and start the emulator against it with a port
  outside the default 5554–5585 scan range, so another session's `adb` does
  not pick up your device by default:
  `ANDROID_ADB_SERVER_PORT=<adb-server-port> emulator -avd <name> -port <even-port> -no-snapshot -no-audio -no-boot-anim -gpu swiftshader_indirect -no-window`.
  Every `adb` command in this recipe means
  `adb -P <adb-server-port> -s emulator-<even-port>`; use that wrapper for
  installs, reverse/forward mappings, shell, exec-out and shutdown. Keep
  `<adb-server-port>`, `<even-port>`, `<daemon-port>` and `<cdp-port>` distinct.
  Wait for
  `getprop sys.boot_completed`, then set `window_animation_scale`,
  `transition_animation_scale` and `animator_duration_scale` to 0 with
  `adb shell settings put global <setting> 0`. The device-test CI action
  already does this through `disable-animations: true`.
  Stop the emulator with `adb emu kill` or by its PID,
  never by pattern.
- Run device tests with `adb install -r -t` for
  `app/build/outputs/apk/debug/app-debug.apk` and
  `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`, then
  `adb shell am instrument -w -r com.qwen.mobileshell.test/androidx.test.runner.AndroidJUnitRunner`.
  Add `-e requireProfileIsolation true` before the runner component only on
  an image whose WebView reports both `MULTI_PROFILE` and `DELETE_BROWSING_DATA`.
  In the measured table this is API 36 only. On other images omit it: the
  literal string `true` converts capability skips into hard assertion failures.
  Re-read the workflow's `require-profiles:` mapping when reproducing CI.
  Do not use Gradle `connected*`: it installs on every visible device and
  uninstalls the app afterwards. Device and upgrade arms use debug APKs;
  the unsigned release artifact is a build check, not an install target.
- Read the per-test status codes, not the summary line: `0` pass, `-2`
  failure, `-4` assumption skip. `OK (7 tests)` is printed even when one of
  the seven was skipped. Also distinguish `1` started (not a result) and
  `-3` ignored (disabled, not a capability skip). A newly ignored test loses
  coverage. Runner 1.5.2 reports thrown JUnit4 failures as `-2`, not the
  deprecated `-1` code.

## Drive the app

- **Native UI.** Use `uiautomator dump` for bounds, then `input tap`.
  While a dialog is open, the dump contains only the dialog window. Match on
  widget class as well as text: a dialog's title and its confirm button can
  share the same label ("Reset connections"). `adb shell input text` drops
  shell metacharacters such as `(`. Under `swiftshader` a "System UI isn't
  responding" dialog can appear; tap Wait.
- **WebView.** Check that `@webview_devtools_remote_<pid>` and a page actually
  exist before claiming CDP evidence. This app does not call
  `setWebContentsDebuggingEnabled`; automatic debug-app support requires
  WebView 113 or later. The app's connection gates can still prevent page
  creation: in the measured table, only API 36 opens a new or migrated
  profile. On the other rows record the blocking gate and use native UI
  evidence; do not silently enable debugging in the reviewed build. Run
  `adb forward tcp:<cdp-port> localabstract:webview_devtools_remote_<pid>`, read
  `/json/list`, and speak raw CDP to the page's `webSocketDebuggerUrl`. Node
  22+ has a global `WebSocket`. Playwright's `connectOverCDP` rejects
  WebView. Type with `Input.insertText`, because `adb input text` drops
  characters in the Web Shell composer.
- **State.** `run-as com.qwen.mobileshell` works on debug APKs.
  Stop the app before collecting a consistent snapshot. Use the selected
  device's `adb exec-out run-as com.qwen.mobileshell tar -cf - app_webview`
  and binary-safe host redirection to a private scratch file outside the
  artifact directory; extract it before scanning individual stores.
  The default profile is `app_webview/Default`; named profiles appear as
  `Profile <n>`. Read the provider's `pref_store` when present (the default
  Chromium 133 location is `app_webview/pref_store`, included in that tar).
  Its profile-list `name` / `path` entries map `qwen-<browserId>` to those
  directories. Record the mapping before upgrade/reset, and do not attribute
  an unmapped hit to a particular connection profile.
  Search raw bytes with `buf.indexOf(Buffer.from(secret, 'utf16le'))` for
  UTF-16LE, including strings at an odd offset; reporting and redaction follow the
  **Migration and persisted-state PRs** rule in SKILL.md.
- **Upgrade arm.** Start on a dedicated fresh AVD or run
  `adb uninstall com.qwen.mobileshell` on the selected disposable device
  before installing base; confirm no prior app state was restored.
  `-no-snapshot` does not clear the AVD's userdata. Install the base debug
  APK, seed its state (for example write
  the legacy `shared_prefs` file with `run-as … cp` and launch once), then
  `adb install -r` the head APK over it. `-r` keeps the app data.

## Mutation runs

Reuse one dedicated scratch checkout for incremental builds. Before each row,
restore the preceding mutation to the pinned head and require
`git status --porcelain` to be empty. Apply exactly one mutant, then inspect
`git diff` and status to confirm only that mutation remains; keep logs outside
the checkout. Rebuild with `--no-daemon`, then run the JVM suite and
`am instrument` on every image in parallel. Include a pristine control row.
Before interpreting a survivor, require a positive control in the mutated
file on each image. If capability gates skip all relevant tests, record that
image as _Not covered_ for the row, not as an adjudicated survivor. Keep that
missing coverage visible when assessing the CI matrix.
Keep the capability argument appropriate to each image; a red pristine control
is not a mutant kill. If `requireProfileIsolation` fails in the control too,
correct the rig before interpreting mutation results.
Cleaning up with `./gradlew --stop` would stop every daemon of that Gradle
version for the user, including other sessions' builds. One cycle (build,
JVM tests, three emulators) took 30–50 seconds on an M1 Max, because the
build directory rebuilds incrementally. The whole ten-row matrix, control
included, took under seven minutes. Record which image killed each mutant.
Compare with the current workflow and executed capability gates above before
calling a kill outside those environments a survivor for CI; the historical
API 35-only kill does not establish today's coverage.
