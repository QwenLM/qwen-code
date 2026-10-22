import manifest from './interface.json' with { type: 'json' };

const platformGuidance = {
  darwin: 'macOS: use application names, bundle IDs or absolute application paths.',
  win32: 'Windows: use an exact application name or executable path. Input delivery is managed by the driver.',
  linux: 'Linux: only X11 applications are supported. The server must inherit DISPLAY, XAUTHORITY and desktop accessibility bus variables.',
};

export function documentation(platform = process.platform) {
  return [
    'Computer Use JavaScript runtime',
    'Global cua is already loaded. Reuse handles and bindings across calls; use assignment, var or block scope to avoid redeclaring const/let.',
    'Use await for every operation. Calls finish with a terminal result; timeout_ms defaults to 30000. Timeout may leave external effects; observe before retrying. js_reset discards the session.',
    'After context compaction, call cua.rewriteDocumentation() before continuing.',
    platformGuidance[platform] ?? 'This platform has no native Computer Use backend.',
    'Start with var app = await cua.getApp("Application"); it displays full AX state without a screenshot. cua.getState() displays application and window inventory.',
    'app.getAXState(options?) returns and automatically displays AX text. Subsequent observations use diff; forceFull:true requests a full tree.',
    'app.getScreenshot(options?) displays the current window image. app.getAXStateAndScreenshot(options?) displays both AX and image. Observation methods return strings; emit:false suppresses automatic output.',
    'Use the short numeric element IDs from the latest observation of this window. Coordinates {x,y} are window screenshot pixels and require a current screenshot.',
    'Actions: await app.click(idOrPoint), doubleClick(idOrPoint), rightClick(idOrPoint), scroll(idOrPoint,{direction,amount}), drag({fromX,fromY,toX,toY}), setValue(id,value), typeText(text), pressKey(key), hotkey(keys). Actions return void. Confirm with an observation in the same call.',
    'For an explicit desktop task, await cua.desktop.getScreenshot() then use cua.desktop.click({x,y}), doubleClick, rightClick, scroll({x,y},{direction,amount}) or drag({fromX,fromY,toX,toY}). Coordinates are pixels in the latest primary-display image. Desktop input operates the visible foreground desktop and can move the real pointer.',
    'Desktop keyboard: typeText(text), pressKey(key), hotkey(keys). To hold a key use try { await cua.desktop.keyDown("shift"); await cua.desktop.click({x,y}); } finally { await cua.desktop.keyUp("shift"); }. Held keys belong to this session; use keyDown/keyUp for chords while holding keys. Release them before text, normal chords, explicit click modifiers or app input. Session end/reset releases owned keys.',
    'Browser: var browser = await cua.getBrowser("Chrome") selects an exact browser ID or name and displays its documentation and tabs. var tab = await cua.getTab(tabId,{browser:"Chrome"}) or cua.getTab({url},{browser:"Chrome"}) selects one tab and displays its DOM snapshot. cua.createBrowserTab("Chrome",url) opens a tab and displays its state. These return the repository browser-use SDK handles unchanged: use browser.tabs/user and tab.playwright/cua/dom_cua. Read the selected browser documentation before acting. Browser selection requires the existing Qwen browser extension connection.',
    ...manifest.tools.map((tool) => `${['getState', 'getApp'].includes(tool.method) || tool.method.startsWith('desktop.') ? 'cua' : 'app'}.${tool.method}: ${tool.description}`),
    'Do not wrap observations in nodeRepl.write or emitImage: they display themselves. For other output use nodeRepl.write(value) and await nodeRepl.emitImage(bytesOrDataUrl). Plain expressions produce no output.',
    'Imports use await import(); Node modules run with the server permissions. nodeRepl.cwd, homeDir, tmpDir and signal are available. A timeout stops JS continuation; actions already dispatched are never automatically replayed.',
    'Once the requested result is visible, stop and report it.',
  ].join('\n');
}
