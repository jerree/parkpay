// Wallet-facing logic that does not import any SDK, so it can be tested on its own.

export type Tx = { settled_at?: number; state?: string };

export type WalletLike = {
  makeInvoice(args: { amount: number; description?: string }): Promise<{ invoice: string; payment_hash: string }>;
  lookupInvoice(args: { payment_hash: string }): Promise<Tx>;
  getInfo?(): Promise<{ methods?: string[] }>;
  close?(): void;
};

// Only an explicit settlement signal counts. A preimage alone is NOT proof of payment,
// because the receiving wallet may already know it before the invoice is paid.
export function isSettled(tx: Tx | null | undefined): boolean {
  if (!tx) return false;
  return Boolean(tx.settled_at) || tx.state === "settled";
}

const SPENDING_METHODS = ["pay_invoice", "multi_pay_invoice", "pay_keysend", "multi_pay_keysend"];

// True when the connection can also send money. A checkout only needs to receive.
export function hasSpendingPower(methods: string[] | undefined): boolean {
  return Array.isArray(methods) && methods.some((m) => SPENDING_METHODS.includes(m));
}

export type PaymentResult = "paid" | "expired" | "cancelled";

export async function waitForPayment(
  wallet: WalletLike,
  paymentHash: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<PaymentResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const end = now() + opts.timeoutMs;
  while (now() < end) {
    if (opts.signal?.aborted) return "cancelled";
    try {
      const tx = await wallet.lookupInvoice({ payment_hash: paymentHash });
      if (isSettled(tx)) return "paid";
      if (tx?.state === "expired" || tx?.state === "failed") return "expired";
    } catch {
      // A temporary network error: keep trying until the timeout.
    }
    await sleep(opts.intervalMs);
  }
  return "expired";
}
