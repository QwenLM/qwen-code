# Native Android (`packages/mobile-shell/`) verification recipe

Read this before scoping a PR that touches `packages/mobile-shell/`. Every
fact below was measured in maintainer rounds on #12121, #12129 and #12130.
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
- **Building runs PR code.** Gradle executes `settings.gradle.kts`,
  `build.gradle.kts`, `gradle.properties` and the wrapper's distribution
  URL, and the PR can edit all of them. The skill's local-invocation
  isolation rule applies to the build. AGP 8.2 publishes its Linux `aapt2`
  as an x86-64 binary only; there is no `linux-aarch64` classifier. So an
  arm64 Linux host or container (Colima, an Orange Pi) cannot build this
  package without x86 emulation, while macOS arm64 builds natively. An
  x86-64 Linux VM with nested KVM could both build and run the emulator in
  isolation, but no such setup has been measured yet. If the
  maintainer decides to build on their own machine, record that decision in
  the methodology note. Also record that you read every changed build-script
  file before the first build.
- **The emulator and the APK.** The emulator needs hardware virtualization
  (HVF on macOS, KVM on Linux), so it cannot run in a container that has no
  `/dev/kvm`.
  Code inside an installed APK runs in the emulator's own app sandbox. The
  daemon the app talks to runs on the host, reached with
  `adb reverse tcp:<port> tcp:<port>`. The shell's network-security config
  allows cleartext only for loopback, so use `http://127.0.0.1:<port>`.

## Build

JDK 17 (`JAVA_HOME`), plus `ANDROID_HOME` pointing at an SDK that has
`platform-tools`, `emulator`, `platforms;android-34` and
`build-tools;34.0.0`. Verify the wrapper jar against its committed
`gradle-wrapper.jar.sha256` first, as the workflow does. Then, from
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
exercises the update-guidance path whatever its features are. The API 35 row is the only one where the "profiles
supported, clearing not supported" branch executes. CI's matrix (API 26 and
API 36) never reaches it.

## Isolate the rig from concurrent sessions

- Use a private adb server, and start the emulator against it with a port
  outside the default 5554–5585 scan range, so another session's `adb` does
  not pick up your device by default:
  `ANDROID_ADB_SERVER_PORT=<p> emulator -avd <name> -port <even-port> -no-snapshot -no-audio -no-boot-anim -gpu swiftshader_indirect -no-window`.
  Wrap `adb -P <p> -s emulator-<port>` in a small script. Wait for
  `getprop sys.boot_completed`, then set the three `*_animation_scale`
  global settings to 0. Stop the emulator with `adb emu kill` or by its PID,
  never by pattern.
- Run device tests with `adb install -r -t` (app APK and test APK), then
  `adb shell am instrument -w -r [-e requireProfileIsolation true] com.qwen.mobileshell.test/androidx.test.runner.AndroidJUnitRunner`.
  Do not use Gradle `connected*`: it installs on every visible device and
  uninstalls the app afterwards.
- Read the per-test status codes, not the summary line: `0` pass, `-2`
  failure, `-4` assumption skip. `OK (7 tests)` is printed even when one of
  the seven was skipped.

## Drive the app

- **Native UI.** Use `uiautomator dump` for bounds, then `input tap`.
  While a dialog is open, the dump contains only the dialog window. Match on
  widget class as well as text: a dialog's title and its confirm button can
  share the same label ("Reset connections"). `adb shell input text` drops
  shell metacharacters such as `(`. Under `swiftshader` a "System UI isn't
  responding" dialog can appear; tap Wait.
- **WebView.** Debug builds expose `@webview_devtools_remote_<pid>`. Run
  `adb forward tcp:<p> localabstract:webview_devtools_remote_<pid>`, read
  `/json/list`, and speak raw CDP to the page's `webSocketDebuggerUrl`. Node
  22+ has a global `WebSocket`. Playwright's `connectOverCDP` rejects
  WebView. Type with `Input.insertText`, because `adb input text` drops
  characters in the Web Shell composer.
- **State.** `run-as com.qwen.mobileshell` works on debug APKs.
  `run-as … tar -cf - app_webview` pulls all WebView storage. The default
  profile is `app_webview/Default`, and named profiles appear as
  `Profile <n>`. Scan for secrets in UTF-16LE as well as ASCII (see the
  persisted-state rule in SKILL.md).
- **Upgrade arm.** Install the base APK, seed its state (for example write
  the legacy `shared_prefs` file with `run-as … cp` and launch once), then
  `adb install -r` the head APK over it. `-r` keeps the app data.

## Mutation runs

Apply each mutant to a clean copy of the sources, and assert that the file
actually changed. Rebuild with `--no-daemon`, then run the JVM suite and
`am instrument` on every image in parallel. Include a pristine control row.
Cleaning up with `./gradlew --stop` would stop every daemon of that Gradle
version for the user, including other sessions' builds. One cycle (build,
JVM tests, three emulators) took 30–50 seconds on an M1 Max, because the
build directory rebuilds incrementally. The whole ten-row matrix, control
included, took under seven minutes. Record which image killed each mutant: a
kill that only happens on API 35 is a survivor as far as CI is concerned.
