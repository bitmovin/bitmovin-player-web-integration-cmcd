/**
 * Returns a function that logs each distinct message only once, to avoid a warning per request.
 * Each returned function has its own memory, so callers can choose the scope.
 */
export function createWarnOnce(): (message: string) => void {
  const logged = new Set<string>();
  return (message: string) => {
    if (!logged.has(message)) {
      logged.add(message);
      console.warn(message);
    }
  };
}
