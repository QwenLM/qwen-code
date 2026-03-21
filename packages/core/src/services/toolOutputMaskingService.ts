commit efce83c9f6a085ba4defe4d356ca1ed8f386d6c8
Author: netbrah <162479981+netbrah@users.noreply.github.com>
Date:   Sat Mar 21 23:52:56 2026 -0400

    fix: review round 4 findings from Copilot
    
    Made-with: Cursor

diff --git a/packages/core/src/services/toolOutputMaskingService.ts b/packages/core/src/services/toolOutputMaskingService.ts
index 27ee911b6..0fa182233 100644
--- a/packages/core/src/services/toolOutputMaskingService.ts
+++ b/packages/core/src/services/toolOutputMaskingService.ts
@@ -121,16 +121,22 @@ export class ToolOutputMaskingService {
 
     const newHistory = [...history];
     let actualTokensSaved = 0;
-    let toolOutputsDir = path.join(
-      config.storage.getProjectTempDir(),
-      TOOL_OUTPUTS_DIR,
-    );
-    const sessionId = config.getSessionId();
-    if (sessionId) {
-      const safeSessionId = sanitizeFilenamePart(sessionId);
-      toolOutputsDir = path.join(toolOutputsDir, `session-${safeSessionId}`);
+    let toolOutputsDir: string;
+    try {
+      toolOutputsDir = path.join(
+        config.storage.getProjectTempDir(),
+        TOOL_OUTPUTS_DIR,
+      );
+      const sessionId = config.getSessionId();
+      if (sessionId) {
+        const safeSessionId = sanitizeFilenamePart(sessionId);
+        toolOutputsDir = path.join(toolOutputsDir, `session-${safeSessionId}`);
+      }
+      await fsPromises.mkdir(toolOutputsDir, { recursive: true });
+    } catch (fsErr) {
+      debugLogger.warn(`[ToolOutputMasking] FS setup failed, skipping: ${fsErr}`);
+      return { newHistory: history, maskedCount: 0, tokensSaved: 0 };
     }
-    await fsPromises.mkdir(toolOutputsDir, { recursive: true });
 
     for (const item of prunableParts) {
       const { contentIndex, partIndex, content, tokens } = item;
@@ -148,7 +154,12 @@ export class ToolOutputMaskingService {
         .substring(7)}.txt`;
       const filePath = path.join(toolOutputsDir, fileName);
 
-      await fsPromises.writeFile(filePath, content, 'utf-8');
+      try {
+        await fsPromises.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
+      } catch {
+        debugLogger.warn(`[ToolOutputMasking] Failed to write ${filePath}, skipping`);
+        continue;
+      }
 
       const originalResponse =
         (part.functionResponse.response as Record<string, unknown>) || {};
@@ -218,9 +229,11 @@ export class ToolOutputMaskingService {
     const response = part.functionResponse.response as Record<string, unknown>;
     if (!response) return null;
 
-    const content = JSON.stringify(response, null, 2);
-
-    return content;
+    try {
+      return JSON.stringify(response, null, 2);
+    } catch {
+      return String(response);
+    }
   }
 
   private isAlreadyMasked(content: string): boolean {
