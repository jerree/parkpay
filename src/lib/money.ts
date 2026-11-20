// Money helpers. Naira amounts are kept as whole kobo (integers) to avoid float errors.

export const SATS_PER_BTC = 100_000_000;
export const MAX_KOBO = 500_000_000; // N5,000,000: a typo guard, not a legal limit

export function parseNairaToKobo(input: string): number | null {
  const cleaned = input.replace(/[,\s₦]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const kobo = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(kobo) || kobo <= 0 || kobo > MAX_KOBO) return null;
  return kobo;
}

// Rounds UP so the seller is never short by a fraction of a sat.
export function koboToSats(kobo: number, ngnPerBtc: number): number | null {
  if (!Number.isSafeInteger(kobo) || kobo <= 0) return null;
  if (!Number.isFinite(ngnPerBtc) || ngnPerBtc <= 0) return null;
  const sats = Math.ceil((kobo / 100 / ngnPerBtc) * SATS_PER_BTC - 1e-6);
  return Math.max(1, sats);
}

export function satsToKobo(sats: number, ngnPerBtc: number): number {
  return Math.round((sats / SATS_PER_BTC) * ngnPerBtc * 100);
}

// Formats naira while the seller types: groups thousands and keeps at most two decimals.
export function formatNairaInput(input: string): string {
  const cleaned = input.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  const wholeRaw = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fracRaw = dot === -1 ? null : cleaned.slice(dot + 1).replace(/\./g, "");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fracRaw === null) return grouped;
  return `${grouped || "0"}.${fracRaw.slice(0, 2)}`;
}

export function formatNaira(kobo: number): string {
  const naira = (kobo / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `₦${naira}`;
}

export function formatSats(sats: number): string {
  return `${sats.toLocaleString("en-US")} sats`;
}
