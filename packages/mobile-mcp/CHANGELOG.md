## [0.0.61](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.61) (2026-07-02)
* Fix: Catch system signals for clean v8 exit ([#366](https://github.com/mobile-next/mobile-mcp/pull/366))
* Fix: Detect go-ios installed via npm (bare semver version) ([#355](https://github.com/mobile-next/mobile-mcp/pull/355)), thanks to [@ravijagga](https://github.com/ravijagga)
* Docs: Added CONTRIBUTING.md ([#365](https://github.com/mobile-next/mobile-mcp/pull/365))
* Chore: Updated hono packages for security ([#367](https://github.com/mobile-next/mobile-mcp/pull/367))

## [0.0.60](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.60) (2026-06-15)
* Chore: Updated mobilewright SDK version ([#361](https://github.com/mobile-next/mobile-mcp/pull/361))

## [0.0.59](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.59) (2026-06-09)
* Chore: Updated hono packages for security ([#349](https://github.com/mobile-next/mobile-mcp/pull/349))
* Chore: Updated mobilewright SDK version ([#350](https://github.com/mobile-next/mobile-mcp/pull/350))

## [0.0.58](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.58) (2026-06-02)
* Fix: Understand getRobot device types and platforms ([#346](https://github.com/mobile-next/mobile-mcp/pull/346))
* Chore: Moved tests from mocha/nyc to playwright to reduce dependency vulnerabilities ([#347](https://github.com/mobile-next/mobile-mcp/pull/347))

## [0.0.57](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.57) (2026-05-28)
* Chore: Update mobilewright to 0.0.41 ([#341](https://github.com/mobile-next/mobile-mcp/pull/341))

## [0.0.56](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.56) (2026-05-17)
* Chore: Update mobilewright to 0.0.38 ([#338](https://github.com/mobile-next/mobile-mcp/pull/338))
* Fix: Restore mcp-publisher functionality ([#337](https://github.com/mobile-next/mobile-mcp/pull/337))

## [0.0.55](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.55) (2026-05-16)
* General: Replace mobilecli with mobilewright SDK ([#334](https://github.com/mobile-next/mobile-mcp/pull/334))
* General: Bump fast-xml-parser to 5.8.0 to fix security vulnerability ([#335](https://github.com/mobile-next/mobile-mcp/pull/335))

## [0.0.54](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.54) (2026-05-04)
* Server: Update mobilecli to 0.3.70
* iOS: Fixed cases where testmanagerd would get Device Kit stuck in a black screen of death
* iOS: Added 'placeholder' to view tree response

## [0.0.53](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.53) (2026-05-01)
* Server: Add `mobile_list_crashes` tool to list crash reports on a device
* Server: Add `mobile_get_crash` tool to retrieve full crash report content
* Server: Upgrade mobilecli from 0.2.0 to 0.3.68
* iOS: Replaced use of WebdriverAgent with iOS Device Kit (open source, apache license)
* CI: Restrict `contents` permission to `read`
* CI: Remove Java setup step from build workflow

## [0.0.52](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.52) (2026-04-13)
* Server: Block cross-origin requests on SSE transport ([#311](https://github.com/mobile-next/mobile-mcp/pull/311))
* Server: Warn when SSE server starts without `MOBILEMCP_AUTH` set ([#311](https://github.com/mobile-next/mobile-mcp/pull/311))
* Server: Reject concurrent SSE connections instead of silently replacing them ([#311](https://github.com/mobile-next/mobile-mcp/pull/311))
* Server: Clear SSE transport on connection close to allow reconnection ([#311](https://github.com/mobile-next/mobile-mcp/pull/311))
* Server: Update mobilecli dependency from @mobilenext/mobilecli to mobilecli 0.2.0 ([#316](https://github.com/mobile-next/mobile-mcp/pull/316))
* CI: Fix script injection by passing `github.ref_name` through env vars ([#314](https://github.com/mobile-next/mobile-mcp/pull/314))
* CI: Use `npm ci` instead of `npm install` for reproducible builds ([#314](https://github.com/mobile-next/mobile-mcp/pull/314))
* CI: Pin mcp-publisher to version 1.5.0 ([#314](https://github.com/mobile-next/mobile-mcp/pull/314))
* CI: Remove `npm update` from tag release to preserve lockfile integrity ([#314](https://github.com/mobile-next/mobile-mcp/pull/314))

## [0.0.51](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.51) (2026-04-03)
* Server: Replace `--port` with `--listen` flag accepting `[host:]port` format, default to localhost ([#306](https://github.com/mobile-next/mobile-mcp/pull/306))
* Server: Add optional Bearer token auth via `MOBILEMCP_AUTH` env variable ([#306](https://github.com/mobile-next/mobile-mcp/pull/306))
* Server: Add `MOBILEMCP_DISABLE_TELEMETRY` env variable to opt out of anonymous telemetry ([#305](https://github.com/mobile-next/mobile-mcp/pull/305))
* Server: Security update for path-to-regexp package ([#307](https://github.com/mobile-next/mobile-mcp/pull/307))

## [0.0.50](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.50) (2026-03-27)
* Server: Restrict open_url tool to http/https schemes unless `MOBILEMCP_ALLOW_UNSAFE_URLS=1` is set ([#299](https://github.com/mobile-next/mobile-mcp/pull/299)) thanks to [@manthanghasadiya](https://github.com/manthanghasadiya) for reporting this.

## [0.0.49](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.49) (2026-03-24)
* Server: Fix path traversal in save screenshot and record video ([#296](https://github.com/mobile-next/mobile-mcp/pull/296)) thanks to [@AbhiTheModder](https://github.com/AbhiTheModder) for reporting this.

## [0.0.48](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.48) (2026-03-20)
* Server: Security updates for fast-xml-parser ([#292](https://github.com/mobile-next/mobile-mcp/pull/292))
* Server: Fix handling errors in getDeviceType to prevent empty device list ([#286](https://github.com/mobile-next/mobile-mcp/pull/286)) thanks to [@ls-andy](https://github.com/ls-andy)

## [0.0.47](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.47) (2026-03-09)
* Server: Use zod coerce to fix number parameter parsing ([#284](https://github.com/mobile-next/mobile-mcp/pull/284))
* Server: Updated packages for security ([#285](https://github.com/mobile-next/mobile-mcp/pull/285))
* iOS: Support locales when launching apps ([#283](https://github.com/mobile-next/mobile-mcp/pull/283))
* Android: Support locales when launching apps ([#283](https://github.com/mobile-next/mobile-mcp/pull/283))

## [0.0.46](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.46) (2026-03-03)
* Server: Improved tool description for listing devices, easier on prompting ([#282](https://github.com/mobile-next/mobile-mcp/pull/282))
* iOS: Added support for screen recording for both real devices and simulators ([#282](https://github.com/mobile-next/mobile-mcp/pull/282))
* Android: Added support for screen recording for both real devices and emulators ([#282](https://github.com/mobile-next/mobile-mcp/pull/282))

## [0.0.45](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.45) (2026-03-02)
* Server: Updated fast-xml-parser package for security ([#281](https://github.com/mobile-next/mobile-mcp/pull/281))
* Server: Fix noParams issue that started annoying Claude Code recently ([#280](https://github.com/mobile-next/mobile-mcp/pull/280))
* Android: Fix shell escaping through launchApp ([#279](https://github.com/mobile-next/mobile-mcp/pull/279)) thanks to [@yuhanghuang](https://github.com/yuhanghuang)
* Android: Escape url when calling openUrl ([#278](https://github.com/mobile-next/mobile-mcp/pull/278)) thanks to [yuhanghuang](https://github.com/yuhanghuang)

## [0.0.44](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.44) (2026-02-25)
* General: Rolling out support for remote devices, allocate Android and iOS devices on Mobile Fleet ([#273](https://github.com/mobile-next/mobile-mcp/pull/273))

## [0.0.43](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.43) (2026-02-24)
* General: Increase buffers used for screenshots, fixes bugs where screenshot was >4MB ([#270](https://github.com/mobile-next/mobile-mcp/pull/270))
* General: Upgraded several npm packages for security ([#272](https://github.com/mobile-next/mobile-mcp/pull/272))

## [0.0.42](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.42) (2026-02-03)
* General: Upgraded mobilecli to 0.0.54, [see changes](https://github.com/mobile-next/mobilecli/releases) ([ba3ec1b](https://github.com/mobile-next/mobile-mcp/commit/ba3ec1b9251487ad8444eb22fa3312c7b79d7787))
* General: Updated fast-xml-parser package for security ([#261](https://github.com/mobile-next/mobile-mcp/pull/261))

## [0.0.41](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.41) (2026-01-27)
* General: upgraded mobilecli to 0.0.52, [see changes](https://github.com/mobile-next/mobilecli/releases) ([d7e25f3](https://github.com/mobile-next/mobile-mcp/commit/d7e25f3543e87a436572c29f2b1766bd276a4d68))
* Android: fix: include elements with resource-id or checkable attributes ([#254](https://github.com/mobile-next/mobile-mcp/pull/254)) by [@singhsume123](https://github.com/singhsume123)

## [0.0.40](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.40) (2026-01-15)
* Server: bump @modelcontextprotocol/sdk from 1.24.2 to 1.25.2 for security ([#252](https://github.com/mobile-next/mobile-mcp/pull/252))

## [0.0.39](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.39) (2026-01-01)
* Server: added tool annotations for improved LLM tool understanding ([#246](https://github.com/mobile-next/mobile-mcp/pull/246))
* iOS: added 'duration' parameter to longpress for custom press durations ([#247](https://github.com/mobile-next/mobile-mcp/pull/247))
* Android: added 'duration' parameter to longpress for custom press durations ([#247](https://github.com/mobile-next/mobile-mcp/pull/247))

## [0.0.38](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.38) (2025-12-09)
* iOS: migrated iPhone Simulator calls to use mobilecli binary for improved performance ([#241](https://github.com/mobile-next/mobile-mcp/pull/241))
* iOS: automatically downloading and installing Webdriver Agent on simulator, get started in iOS development in seconds ([#241](https://github.com/mobile-next/mobile-mcp/pull/241))

## [0.0.37](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.37) (2025-12-08)
* Server: migrated to new mcp sdk tool registration API ([#239](https://github.com/mobile-next/mobile-mcp/pull/239))
* Server: updated to @modelcontextprotocol/sdk 1.24.2 and other dependencies for security ([#239](https://github.com/mobile-next/mobile-mcp/pull/239))

## [0.0.36](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.36) (2025-11-19)
* Server: upgraded libraries (glob, js-yaml) and mobilecli ([#234](https://github.com/mobile-next/mobile-mcp/pull/234))

## [0.0.35](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.35) (2025-11-14)
* Server: added list of available MCP tools to README for better discoverability ([043cf3d](https://github.com/mobile-next/mobile-mcp/commit/043cf3d))
* Android: fixed adb path resolution on Windows by always using .exe extension ([178b2fb](https://github.com/mobile-next/mobile-mcp/commit/178b2fb)) by [@mattheww-skyward](https://github.com/mattheww-skyward)

## [0.0.34](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.34) (2025-11-01)
* Server: dry-run release for benchmarking how mobilecli detects devices ([#226](https://github.com/mobile-next/mobile-mcp/pull/226))

## [0.0.33](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.33) (2025-10-20)
* Server: added debug information for understanding screenshot issues on old devices ([#213](https://github.com/mobile-next/mobile-mcp/pull/213))

## [0.0.32](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.32) (2025-10-08)
* Server: fixed wrong separator when listing iOS simulators ([#208](https://github.com/mobile-next/mobile-mcp/pull/208))
* iOS: double tap at screen location ([#207](https://github.com/mobile-next/mobile-mcp/pull/207))
* Android: reduce stdout pollution by adb shell monkey ([#211](https://github.com/mobile-next/mobile-mcp/pull/211))
* Android: fix mobile_take_screenshot on very old android devices ([#204](https://github.com/mobile-next/mobile-mcp/pull/204)) by [@boulaycote](https://github.com/boulaycote)
* Android: double tap at screen location ([#194](https://github.com/mobile-next/mobile-mcp/pull/194)) by [@SakshamSahgal](https://github.com/SakshamSahgal)

## [0.0.31](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.31) (2025-10-07)
* Server: resolve mobilecli libc issues on very old linux distros ([#206](https://github.com/mobile-next/mobile-mcp/pull/206))
* Server: identify mcp-client for compatiblity patches ([#205](https://github.com/mobile-next/mobile-mcp/pull/205))

## [0.0.30](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.30) (2025-10-06)
* Server: introduction of mobilecli tool, will replace imagemagick, sips, go-ios and adb in the future ([#196](https://github.com/mobile-next/mobile-mcp/pull/196))
* iOS: app installation and uninstallation ([#202](https://github.com/mobile-next/mobile-mcp/pull/202))
* Android: app installation and uninstallation ([#202](https://github.com/mobile-next/mobile-mcp/pull/202))

## [0.0.29](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.29) (2025-09-26)
* Server: bumped mcp sdk to latest version ([#199](https://github.com/mobile-next/mobile-mcp/pull/199))
* Server: locked production npm packages to specific version ([#199](https://github.com/mobile-next/mobile-mcp/pull/199))
* Server: renamed tool 'swipe_on_screen' to 'mobile_swipe_on_screen' ([#197](https://github.com/mobile-next/mobile-mcp/pull/197))

## [0.0.28](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.28) (2025-09-15)
* Server: added 'device' parameter to all tools ([#181](https://github.com/mobile-next/mobile-mcp/pull/181))
* Server: enable agents to access multiple devices at once (eg, 'explain what's on screen on all devices connected')
  ([#181](https://github.com/mobile-next/mobile-mcp/pull/181))

## [0.0.27](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.27) (2025-09-10)
* Server: use 'sips' image scaling on mac if found, removes requirement to install ImageMagick for image scaling ([#188](https://github.com/mobile-next/mobile-mcp/pull/188))

## [0.0.26](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.26) (2025-09-09)
* Server: support listing of mobile-mcp in github's mcp registry ([e96404e](https://github.com/mobile-next/mobile-mcp/commit/e96404e0e513e48ebcfe7956800203cc0f363526))

## [0.0.25](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.25) (2025-09-08)
* Server: install mobile-mcp in vscode with a single-click in README ([#173](https://github.com/mobile-next/mobile-mcp/pull/173))
* Android: try finding 'adb' under $HOME/Library/Android if $ANDROID_HOME is not defined ([#183](https://github.com/mobile-next/mobile-mcp/pull/183))
* Android: better escaping of text input, for improved security ([#182](https://github.com/mobile-next/mobile-mcp/pull/183))

## [0.0.24](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.24) (2025-08-24)
* iOS: new tool for long press ([#143](https://github.com/mobile-next/mobile-mcp/pull/143))
* Android: new tool for long press ([#143](https://github.com/mobile-next/mobile-mcp/pull/143))
* Android: fixed screenshot from devices with multiple devices (foldables) again ([#171](https://github.com/mobile-next/mobile-mcp/pull/171))

## [0.0.23](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.23) (2025-07-31)
* Android: fixed a bug where devices with multiple screens (such as foldables) failed to take and save screenshot ([#159](https://github.com/mobile-next/mobile-mcp/pull/159))

## [0.0.22](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.22) (2025-07-17)
* iOS: fixed detection of go-ios installation ([#132](https://github.com/mobile-next/mobile-mcp/pull/132) by [@codeaholicguy](https://github.com/codeaholicguy)

## [0.0.21](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.21) (2025-06-27)
* Server: use node: prefixed modules (like node:fs) ([449c498](https://github.com/mobile-next/mobile-mcp/commit/449c498e6e9a3e68aab55ea82f15c296171fc05e))
* iOS: automatically start WebDriverAgent on simulator if already installed ([#126](https://github.com/mobile-next/mobile-mcp/pull/126))
* Android: fixed detection of com.mobilenext.devicekit when running mcp on windows ([c11c642](https://github.com/mobile-next/mobile-mcp/commit/c11c6427c71cb7cef6ce87005047df977f6bea8a))

## [0.0.20](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.20) (2025-06-23)
* Server: new tool `save_screenshot` which saves the screenshot to disk, to be used by other mcp servers ([#112](https://github.com/mobile-next/mobile-mcp/pull/112))
* Server: new tool `use_default_device` which picks the only device that is connected, to speed up use ([#112](https://github.com/mobile-next/mobile-mcp/pull/112))
* iOS: Use wda to grab screenshots for both real devices and simulators ([#115](https://github.com/mobile-next/mobile-mcp/pull/115))
* Android: Support for utf-8 text in sendKeys, see [wiki page]() for getting started ([#117](https://github.com/mobile-next/mobile-mcp/pull/117))

## [0.0.19](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.19) (2025-06-16)
* Server: Fixed support for Windsurf, where some tools caused a -32602 error ([#101](https://github.com/mobile-next/mobile-mcp/pull/101)) by [@amebahead](https://github.com/amebahead)
* iOS: Support for swipe left and right. Support x,y,direction,duration for custom swipes ([#92](https://github.com/mobile-next/mobile-mcp/pull/92/)) by [@benlmyers](https://github.com/benlmyers)
* Android: Support for swipe left and right. Support x,y,direction,duration for custom swipes ([#92](https://github.com/mobile-next/mobile-mcp/pull/92/)) by [@benlmyers](https://github.com/benlmyers)
* Android: Fix for get elements on screen, where uiautomator prints out warnings before the actual xml ([#86](https://github.com/mobile-next/mobile-mcp/pull/86)) by [@wenerme](https://github.com/wenerme)

## [0.0.18](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.18) (2025-06-12)
* Server: New support for SSE (Server-Sent-Events) transport, [see wiki for more information](https://github.com/mobile-next/mobile-mcp/wiki/Using-SSE-Transport) ([1b70d40](https://github.com/mobile-next/mobile-mcp/commit/1b70d403cd562a97a0723464f2b286f2fd6eee0a))
* iOS: Using plutil for `simctl listapps` parsing, might probably fix some parsing issues ([cfba3aa](https://github.com/mobile-next/mobile-mcp/commit/cfba3aaac5beb66d08d1138fe42c924309ede303))
* Other: We have a new Slack server, join us at http://mobilenexthq.com/join-slack

## [0.0.17](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.17) (2025-05-16)
* iOS: Fixed parsing of simctl listapps where CFBundleDisplayName contains non-alphanumerical characters ([#59](https://github.com/mobile-next/mobile-mcp/issues/59)) ([bf19771d](https://github.com/mobile-next/mobile-mcp/pull/63/commits/bf19771dcd49444ba4841ec649e3a72a03b54c74))

## [0.0.16](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.16) (2025-05-10)
* Server: Detect if there is a new version of the mcp and notify user ([14b015f](https://github.com/mobile-next/mobile-mcp/commit/14b015f29ab47aa1f3ae122a670a58eb7ef51fd8))
* Server: Instead of returning x,y for tap, return [top,left,width,height] of elements on screen ([3169d2f](https://github.com/mobile-next/mobile-mcp/commit/3169d2f46f0c789e4c3188e137ac645d6f6eb27c))
* iOS: Fixed coordinates location for iOS with retina display after image scaledown ([3169d2f](https://github.com/mobile-next/mobile-mcp/commit/3169d2f46f0c789e4c3188e137ac645d6f6eb27c))
* iOS: Added detection of StaticText and Image in mobile_list_elements_on_screen ([debe75b](https://github.com/mobile-next/mobile-mcp/commit/debe75b5c8afcafcef8328201e9886bffdd1f128))

## [0.0.15](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.15) (2025-05-04)
* Android: Fixed broken Android screenshots on Windows because of crlf ([#53](https://github.com/mobile-next/mobile-mcp/pull/53/files) by [@hanyuan97](https://github.com/hanyuan97))

## [0.0.14](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.14) (2025-05-02)
* Server: Fix a bug where xcrun was required, now works on Linux as well ([7fddba7](https://github.com/mobile-next/mobile-mcp/commit/7fddba71af51690cfa76f81154f72c3120ab7f07))
* Server: Removed dependency on sharp which was causing issues during installation, now ImageMagick is an optional dependency
* Android: Try uiautomator-dump multiple times, in case ui hierarchy is not stable
* Android: Return more information about elements on screen for better element detection
* Android: Support for Android TV using dpad for navigation ([399443d](https://github.com/mobile-next/mobile-mcp/commit/399443d519284a54b670a1598689a73d178db2ec) by [@surajsau](https://github.com/surajsau))

## [0.0.13](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.13) (2025-04-17)
* Server: Fix a bug where 'adb' is required to even work with iOS-only ([#30](https://github.com/mobile-next/mobile-mcp/issues/30)) ([867f662](https://github.com/mobile-next/mobile-mcp/pull/35/commits/867f662ac2edc68d542519bd72d1762d3dbca18d))
* iOS: Support for orientation changes ([844dc0e](https://github.com/mobile-next/mobile-mcp/pull/28/commits/844dc0eb953169871b4cdd2a57735bf50abe721a))
* Android: Support for orientation changes (eg 'change device to landscape') ([844dc0e](https://github.com/mobile-next/mobile-mcp/pull/28/commits/844dc0eb953169871b4cdd2a57735bf50abe721a))
* Android: Improve element detection by using element name if label not found ([8e8aadf](https://github.com/mobile-next/mobile-mcp/pull/33/commits/8e8aadfd7f300ff5b7f0a7857a99d1103cd9e941) by [@tomoya0x00](https://github.com/tomoya0x00))

## [0.0.12](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.12) (2025-04-12)
* Server: If hitting an error with tunnel, forward proxy, wda, descriptive error and link to documentation will be returned
* iOS: go-ios path can be set in env GO_IOS_PATH
* iOS: Support go-ios that was built locally (no version)
* iOS: Return bundle display name for apps for better app launch
* iOS: Fixed finding element coordinates on retina displays
* iOS: Saving temporary screenshots onto temporary directory ([#19](https://github.com/mobile-next/mobile-mcp/issues/19))
* iOS: Find elements better by removing off-screen and hidden elements
* Android: Support for 'adb' under ANDROID_HOME
* Android: Find elements better using accessibility hints and class names

## [0.0.11](https://github.com/mobile-next/mobile-mcp/releases/tag/0.0.11) (2025-04-06)
* Server: Support submit after sending text (\n)
* Server: Added support for multiple devices at the same time
* iOS: Support for iOS physical devices using go-ios ([see wiki](https://github.com/mobile-next/mobile-mcp/wiki/Getting-Started-with-iOS-Physical-Device))
* iOS: Added support for icons, search fields, and switches when getting elements on screen
