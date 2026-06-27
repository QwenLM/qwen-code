export function createSentinelSerializer<T>(sentinel: string) {
  return {
    serialize(data: T): string {
      return `${sentinel}${JSON.stringify(data)}`;
    },
    parse(content: string): T | null {
      if (!content.startsWith(sentinel)) return null;
      try {
        const parsed = JSON.parse(content.slice(sentinel.length));
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as T;
      } catch {
        return null;
      }
    },
  };
}
