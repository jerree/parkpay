// Escrow core: the secret code, its fingerprint, the messages passed between buyer and seller,
// and the deal state machine. No SDK and no network, so it can be tested on its own.

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9]{8,32}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The code is 32 random bytes. It must be long and random: a short or chosen code could be
// guessed by the computers a payment passes through, and the money could be taken.
export async function generateSecret(): Promise<{ code: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { code: toHex(bytes), hash: await sha256Hex(bytes) };
}

export async function hashOfCode(code: string): Promise<string | null> {
  const clean = code.trim().toLowerCase();
  return HEX64.test(clean) ? sha256Hex(fromHex(clean)) : null;
}

// The seller's app uses this to check a code before releasing anything.
export async function verifyCode(code: string, expectedHash: string): Promise<boolean> {
  const hash = await hashOfCode(code);
  if (hash === null || !HEX64.test(expectedHash)) return false;
  return constantTimeEqual(hash, expectedHash);
}

export function newDealId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

// ---- Messages passed between the two phones (as links over WhatsApp or similar) ----

export type Share =
  | { t: "deal"; v: 1; id: string; item: string; sats: number; driver: string; hours: number }
  | { t: "lock"; v: 1; id: string; hash: string }
  | { t: "invoice"; v: 1; id: string; invoice: string; expiresAt: number }
  | { t: "release"; v: 1; id: string; code: string };

export const MAX_SATS = 10_000_000;
export const MIN_HOURS = 1;
export const MAX_HOURS = 72;

function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function encodeShare(share: Share): string {
  return bytesToB64Url(new TextEncoder().encode(JSON.stringify(share)));
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

// Strict checks. Only known fields are copied into a fresh object. Returns null for anything else.
export function decodeShare(text: string): Share | null {
  try {
    if (typeof text !== "string" || text.length > 4000) return null;
    const raw = JSON.parse(new TextDecoder().decode(b64UrlToBytes(text.trim()))) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || raw.v !== 1) return null;
    const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
    if (id === null) return null;
    switch (raw.t) {
      case "deal": {
        const item = cleanText(raw.item, 80);
        const driver = cleanText(raw.driver, 80);
        const sats = raw.sats;
        const hours = raw.hours;
        if (item === null || driver === null) return null;
        if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats < 1 || sats > MAX_SATS) return null;
        if (typeof hours !== "number" || !Number.isSafeInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) return null;
        return { t: "deal", v: 1, id, item, sats, driver, hours };
      }
      case "lock": {
        return typeof raw.hash === "string" && HEX64.test(raw.hash) ? { t: "lock", v: 1, id, hash: raw.hash } : null;
      }
      case "invoice": {
        const invoice = raw.invoice;
        const expiresAt = raw.expiresAt;
        if (typeof invoice !== "string" || !/^ln[a-z0-9]{20,2000}$/i.test(invoice)) return null;
        if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
        return { t: "invoice", v: 1, id, invoice, expiresAt };
      }
      case "release": {
        return typeof raw.code === "string" && HEX64.test(raw.code) ? { t: "release", v: 1, id, code: raw.code } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---- The deal state machine ----

export type DealState = "created" | "invoice_ready" | "locked" | "released" | "cancelled" | "expired";
export type DealEvent = "invoice_created" | "payment_locked" | "code_accepted" | "cancelled" | "timed_out";

const TRANSITIONS: Record<DealState, Partial<Record<DealEvent, DealState>>> = {
  created: { invoice_created: "invoice_ready", cancelled: "cancelled", timed_out: "expired" },
  invoice_ready: { payment_locked: "locked", cancelled: "cancelled", timed_out: "expired" },
  locked: { code_accepted: "released", cancelled: "cancelled", timed_out: "expired" },
  released: {},
  cancelled: {},
  expired: {},
};

// Returns the new state, or null when the event is not allowed in the current state.
export function nextState(state: DealState, event: DealEvent): DealState | null {
  return TRANSITIONS[state][event] ?? null;
}

export function isFinished(state: DealState): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}

export function expiryTime(createdAt: number, hours: number): number {
  const clamped = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.floor(hours)));
  return createdAt + clamped * 60 * 60 * 1000;
}

export const SAFETY_MARGIN_MS = 15 * 60 * 1000;

// The seller's screen shows "release the package" only when this says ok.
export function handoverCheck(args: {
  state: DealState;
  codeValid: boolean;
  expiresAt: number;
  now: number;
  marginMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const margin = args.marginMs ?? SAFETY_MARGIN_MS;
  if (args.state !== "locked") return { ok: false, reason: "The payment is not locked. Do not release the package." };
  if (!args.codeValid) return { ok: false, reason: "The code does not match. Do not release the package." };
  if (args.now + margin >= args.expiresAt) {
    return { ok: false, reason: "The lock is about to expire or has expired. Do not release the package." };
  }
  return { ok: true };
}
