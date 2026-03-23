commit efce83c9f6a085ba4defe4d356ca1ed8f386d6c8
Author: netbrah <162479981+netbrah@users.noreply.github.com>
Date:   Sat Mar 21 23:52:56 2026 -0400

    fix: review round 4 findings from Copilot
    
    Made-with: Cursor

diff --git a/packages/core/src/utils/tokenCalculation.ts b/packages/core/src/utils/tokenCalculation.ts
index 8504ae852..d29c5de53 100644
--- a/packages/core/src/utils/tokenCalculation.ts
+++ b/packages/core/src/utils/tokenCalculation.ts
@@ -56,7 +56,11 @@ function estimateFunctionResponseTokens(part: Part, depth: number): number {
   if (typeof response === 'string') {
     totalTokens += response.length / 4;
   } else if (response !== undefined && response !== null) {
-    totalTokens += JSON.stringify(response).length / 4;
+    try {
+      totalTokens += JSON.stringify(response).length / 4;
+    } catch {
+      totalTokens += String(response).length / 4;
+    }
   }
 
   const nestedParts = (fr as unknown as { parts?: Part[] }).parts;
@@ -86,7 +90,11 @@ export function estimateTokenCountSync(
       if (mediaEstimate !== undefined) {
         totalTokens += mediaEstimate;
       } else {
-        totalTokens += JSON.stringify(part).length / 4;
+        try {
+          totalTokens += JSON.stringify(part).length / 4;
+        } catch {
+          totalTokens += 100;
+        }
       }
     }
   }
