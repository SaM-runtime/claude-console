/**
 * Fixtures use Windows paths (`C:/…`, `D:/…`). On macOS/Linux the engine resolves those as
 * relative and prefixes the working directory; strip that prefix so every platform sees the
 * same fixture key.
 */
export const fixturePath = (path: string) => path.replace(/\\/g, '/').replace(/^.*\/(?=[A-Za-z]:\/)/, '')
