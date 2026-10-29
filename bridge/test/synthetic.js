// Fake secrets in the tests are written with a U+00B7 every few characters and pass through syn() at run time, so the
// repository holds no literal that a secret scanner (GitGuardian) reports as a password or a high-entropy secret.
export const syn = (s) => String(s).replaceAll('·', '');
