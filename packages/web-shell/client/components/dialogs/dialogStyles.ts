import styles from './DialogPrimitives.module.css';

export function dp(
  ...names: Array<keyof typeof styles | false | null | undefined>
): string {
  return names
    .filter((name): name is keyof typeof styles => Boolean(name))
    .map((name) => styles[name])
    .filter(Boolean)
    .join(' ');
}
