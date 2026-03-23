commit efce83c9f6a085ba4defe4d356ca1ed8f386d6c8
Author: netbrah <162479981+netbrah@users.noreply.github.com>
Date:   Sat Mar 21 23:52:56 2026 -0400

    fix: review round 4 findings from Copilot
    
    Made-with: Cursor

diff --git a/packages/core/src/tools/mcp-client.ts b/packages/core/src/tools/mcp-client.ts
index b86197bbf..355f73f90 100644
--- a/packages/core/src/tools/mcp-client.ts
+++ b/packages/core/src/tools/mcp-client.ts
@@ -30,6 +30,10 @@ import { GoogleCredentialProvider } from '../mcp/google-auth-provider.js';
 import { ServiceAccountImpersonationProvider } from '../mcp/sa-impersonation-provider.js';
 import { DiscoveredMCPTool } from './mcp-tool.js';
 import type { McpToolAnnotations } from './mcp-tool.js';
+import { SdkControlClientTransport } from './sdk-control-client-transport.js';
+
+import type { FunctionDeclaration } from '@google/genai';
+import { mcpToTool } from '@google/genai';
 
 function resolvedMcpToolAnnotations(
   mcpServerConfig: MCPServerConfig,
@@ -43,10 +47,6 @@ function resolvedMcpToolAnnotations(
   }
   return { ...fromListTools, readOnlyHint: true };
 }
-import { SdkControlClientTransport } from './sdk-control-client-transport.js';
-
-import type { FunctionDeclaration } from '@google/genai';
-import { mcpToTool } from '@google/genai';
 import { basename } from 'node:path';
 import { pathToFileURL } from 'node:url';
 import { MCPOAuthProvider } from '../mcp/oauth-provider.js';
