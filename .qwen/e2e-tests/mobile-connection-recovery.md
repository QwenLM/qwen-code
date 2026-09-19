# Android connection recovery E2E plan

## Method and baseline

This is a native Android Activity feature. The global Qwen CLI and `node dist/cli.js` cannot exercise it. Use the installed debug APK and AndroidJUnitRunner; do not describe CLI execution as native verification. Baseline: profile foundation `a765ac1ecf`; combined baseline `de5a05426a` on upstream `009aab05b2`. Baseline recreation is expected to return to Connections and renderer Retry to load `/`.

## Independent lanes

The test-engineer owns modern API 36 (`qwen_guard_api36`, port 5560) and legacy API 26 (`qwen_phase2_api26`, port 5558). Do not run concurrent instrumentation or installs on one device. Use synthetic loopback profiles and unique identifiers, clean only test-created profiles, and never wipe emulator/user data. Evidence directory: `audit-qwen-11722/phase2-completion-20260919` outside the repository.

## Commands

From `packages/mobile-shell` with Java 17 and the Android SDK configured:

```text
gradlew.bat --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:assembleDebugAndroidTest :app:lintDebug
adb -s emulator-5560 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5560 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5560 shell am instrument -w -r -e requireProfileIsolation true -e class com.qwen.mobileshell.ConnectionRecoveryDeviceTest com.qwen.mobileshell.test/androidx.test.runner.AndroidJUnitRunner
```

Run the complete native suite on modern and legacy providers as regression coverage. Count assumption skips separately from passes. On the unsupported provider, verify connection fails closed rather than claiming session restoration passed.

## Behavioral groups

1. Connect a synthetic authenticated profile, navigate through `history.replaceState` to a session/workspace route, call actual `ActivityScenario.recreate()`, and verify a fresh WebView uses the same named profile, route and vault credential. Repeat with same-origin profiles to check isolation. Rotation alone is insufficient.
2. Validate snapshot serialization and rejected URLs/IDs: no raw URL, bearer, fragment, daemon override or unknown query survives. Reject malformed and foreign-origin routes; accept only canonical session/workspace/context identifiers.
3. Between snapshot and recreation, rename, remove or rotate the profile in the vault. A rename restores; deletion and rotation return to Connections without connecting to another target.
4. Terminate the actual WebView renderer, confirm explicit Retry, recreate the Activity while Retry is shown, then retry and verify the route. Confirm Connections cancels recovery.
5. Combined acceptance: run profiles, initialization, picker, microphone, accessibility and downloads suites together; test actual document Open/Save after microphone authorization. Record the existing background teardown limitation; never silently bypass it.

Android process-kill/relaunch and physical-device/TalkBack checks are distinct from Activity recreation and must be reported separately if not run. No real voice-provider success is inferred from a local microphone fixture.

## Results

Independent native baseline reproduction: actual Activity recreation on combined `de5a05426a` lost the connected profile/session and returned to Connections. After implementation, the full focused native suite passed on API36/WebView134: **14 passed, 1 assumption skip**, including all **8 recovery tests**. API26/WebView69: **4 passed, 11 capability skips**, not supported-profile acceptance. Modern required profile isolation. Actual renderer termination and Activity recreation were exercised; process-kill/relaunch and physical devices were not.

Java17/Gradle8.2.1 debug, unsigned release, instrumentation APK, 25 JVM tests and lint passed (0 errors; 6 existing dependency notices). Desktop-isolation check passed. Native recovery changes do not modify CLI or H5 code; CLI bundling is not an Android recovery test.

The first device run exposed a test fixture error: the test reinserted a retired browser ID after deletion. Deletion and origin-change tests were split into fresh independent fixtures. The one resulting synthetic vault overlap was removed by a guarded test-only repair, with encrypted backup and all other profiles preserved; final results above are from the corrected tests. Initial logs are retained. No product behavior was changed to conceal the fixture failure.

Combined baseline suites at `de5a05426a`: API36 38 passed/1 skip, API26 34 passed/5 skips. Real microphone consent followed by track stop and system Open reproduces the documented microphone-background teardown limitation. It remains separate from recovery correctness.
