/** Debounced persist that always writes whatever `read` returns at fire time. */
export function createDraftPersist<T>(
  read: () => T,
  write: (draft: T) => Promise<void>,
  delayMs = 1200,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    pending = false;
    const draft = read();
    try {
      await write(draft);
    } catch (error) {
      pending = true;
      throw error;
    }
    if (pending) await flush();
  }

  function schedule() {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, delayMs);
  }

  return { schedule, flush };
}
