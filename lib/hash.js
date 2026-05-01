// Streamed SHA-256 hasher.
//
// Web Crypto's crypto.subtle.digest() is one-shot — it has no init/
// update/finalize, so it can't stream. The architecture's "never load
// the whole file into memory" rule (5GB videos, 6GB-RAM phones, OOM)
// requires a JS-side streaming SHA-256. We use the vendored
// @noble/hashes implementation.
//
// Usage:
//   const hex = await hashFile(file, (n, total) => updateProgressBar(n / total));
//
// `file` is anything with .size and .stream() — File, Blob, or any
// duck-typed equivalent in tests.

import { sha256 } from '../vendor/noble-hashes/sha2.js';

const HEX = '0123456789abcdef';

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  }
  return s;
}

export async function hashFile(file, onProgress) {
  const hasher = sha256.create();
  const total = file.size;
  let hashed = 0;
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      hashed += value.byteLength;
      if (onProgress) onProgress(hashed, total);
    }
  } finally {
    reader.releaseLock();
  }
  return bytesToHex(hasher.digest());
}
