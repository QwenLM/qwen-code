export interface MatchedMessageRoute {
  prefix: string;
  instructions: string;
  text: string;
}

export function matchMessageRoute(
  text: string,
  routes: ReadonlyMap<string, string>,
  defaultRoute?: string,
): MatchedMessageRoute | undefined {
  for (const [prefix, instructions] of [...routes].sort(
    ([a], [b]) => b.length - a.length,
  )) {
    let candidate = text.trim();
    while (
      !(
        candidate.startsWith(prefix) &&
        (candidate.length === prefix.length ||
          /\s/u.test(candidate.charAt(prefix.length)))
      )
    ) {
      const mention = candidate.match(/^(?:@[^@\s]+|<@[^>]{1,64}>)\s+/u)?.[0];
      if (!mention) break;
      candidate = candidate.slice(mention.length);
    }
    if (
      candidate.startsWith(prefix) &&
      /^\s+\S[\s\S]*$/u.test(candidate.slice(prefix.length))
    ) {
      return {
        prefix,
        instructions,
        text: candidate.slice(prefix.length).trim(),
      };
    }
  }
  if (defaultRoute !== undefined) {
    const instructions = routes.get(defaultRoute);
    if (instructions !== undefined) {
      return { prefix: defaultRoute, instructions, text };
    }
  }
  return undefined;
}
