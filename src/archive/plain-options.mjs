/** Reject removed encryption options instead of silently writing plain data. */
export function assertPlainZipOptions(options = {}) {
  for (const key of ['password', 'rawPassword', 'encryptionStrength', 'zipCrypto', 'encrypted', 'encryptionMethod']) if (Object.hasOwn(options, key)) throw new Error(`Unsupported ZIP encryption option: ${key}`);
}
