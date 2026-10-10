/**
 * Wraps an async task so overlapping calls share work instead of running in
 * parallel. A call made while the task is running triggers one more run, and
 * every caller's promise settles only after a run that started after its call.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await task();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
