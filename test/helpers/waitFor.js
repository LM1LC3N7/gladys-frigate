/** Resolves once `condition()` is truthy; rejects after `timeoutMs`. */
// Generous default: CI runners can be much slower than a workstation.
export async function waitFor(condition, { timeoutMs = 10_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
