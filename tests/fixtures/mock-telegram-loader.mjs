const mockUrl = new URL('./mock-telegram-client.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/telegram-client.js')) {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
