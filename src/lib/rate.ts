// Exchange rate (naira per 1 BTC). The seller can type it in, or fetch it from a public API.

export function parseRate(input: string): number | null {
  const cleaned = input.replace(/[,\s₦]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// A typo guard: warn (do not block) when a rate looks far outside a sensible range.
export function isRatePlausible(rate: number): boolean {
  return rate >= 1_000_000 && rate <= 10_000_000_000;
}

export async function fetchNgnPerBtc(signal?: AbortSignal): Promise<number> {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=ngn",
    { signal },
  );
  if (!res.ok) throw new Error("rate request failed");
  const data = (await res.json()) as { bitcoin?: { ngn?: unknown } };
  const rate = data?.bitcoin?.ngn;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("unexpected rate response");
  }
  return rate;
}
