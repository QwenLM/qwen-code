import { expect, test } from '@playwright/test';

// Full Chromium includes the PDF viewer; headless-shell does not.
test.use({ channel: 'chromium' });

test.describe('PDF attachment framing', () => {
  test('@smoke permits PDF blob frames under the development CSP', async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) {
        violations.push(message.text());
      }
    });
    const response = await page.goto('/e2e/composer-layout-harness.html');
    expect(response?.headers()['content-security-policy']).toContain(
      'frame-src http: https: blob:;',
    );
    await page.setContent('<iframe title="PDF attachment"></iframe>');
    const url = await page.locator('iframe').evaluate((frame, base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], { type: 'application/pdf' }),
      );
      (frame as HTMLIFrameElement).src = url;
      return url;
    }, 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDEwMCBUZCAoUERGIHByb2JlKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=');
    try {
      await expect
        .poll(() => page.frames().some((frame) => frame.url() === url))
        .toBe(true);
      expect(
        violations.filter((message) => message.includes('frame-src')),
      ).toEqual([]);
    } finally {
      await page.evaluate((value) => URL.revokeObjectURL(value), url);
    }
  });
});
