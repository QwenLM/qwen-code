export async function copyResponseText(
  text: string,
  writeText: (value: string) => Promise<void>,
): Promise<{ status: 'copied' } | { status: 'failed'; error: unknown }> {
  try {
    await writeText(text);
    return { status: 'copied' };
  } catch (error) {
    return { status: 'failed', error };
  }
}
