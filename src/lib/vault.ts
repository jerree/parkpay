// Encrypts the wallet link with the seller's PIN (PBKDF2 + AES-GCM, via WebCrypto).
// Honest limit: a short PIN stops casual access, not a determined attacker who copies the stored data.

export type Vault = { v: 1; iter: number; salt: string; iv: string; ct: string };

const ITERATIONS = 300_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveKey(pin: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function validatePin(pin: string): string | null {
  return /^\d{6,12}$/.test(pin) ? null : "Use 6 to 12 digits.";
}

export async function seal(plain: string, pin: string): Promise<Vault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, enc.encode(plain));
  return { v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

// Returns null when the PIN is wrong or the data was changed.
export async function unseal(vault: Vault, pin: string): Promise<string | null> {
  try {
    const key = await deriveKey(pin, fromB64(vault.salt), vault.iter);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(vault.iv) as BufferSource },
      key,
      fromB64(vault.ct) as BufferSource,
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}
