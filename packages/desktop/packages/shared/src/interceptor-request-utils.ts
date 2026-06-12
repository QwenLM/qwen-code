/**
 * Resolve method/body/headers from fetch(input, init), including Request inputs.
 */
export async function resolveRequestContext(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ bodyStr?: string; normalizedInit: RequestInit }> {
  // Prefer explicit init body (already detached from Request stream)
  if (typeof init?.body === 'string') {
    return { bodyStr: init.body, normalizedInit: init };
  }

  // Fallback: parse Request body when caller used fetch(new Request(...))
  if (input instanceof Request) {
    try {
      const bodyStr = await input.clone().text();
      const normalizedInit: RequestInit = {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? bodyStr,
      };
      return { bodyStr, normalizedInit };
    } catch {
      // Ignore body read errors — interception will be skipped
    }
  }

  return { bodyStr: undefined, normalizedInit: init ?? {} };
}
