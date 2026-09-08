export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryUntil(fn, options) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < options.timeoutMs) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(options.intervalMs);
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms`);
}
