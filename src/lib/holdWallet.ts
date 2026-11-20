// Hold-invoice wallet interface and the "wait until the money is locked" logic. No SDK imports.

import { isSettled } from "./wallet.ts";
import type { Tx, WalletLike } from "./wallet.ts";

export type HoldWalletLike = WalletLike & {
  makeHoldInvoice(args: {
    amount: number; // in millisatoshis
    payment_hash: string;
    description?: string;
    expiry?: number; // seconds the buyer has to pay
  }): Promise<{ invoice: string; payment_hash: string; expires_at?: number }>; // expires_at: unix seconds
  settleHoldInvoice(args: { preimage: string }): Promise<unknown>;
  cancelHoldInvoice(args: { payment_hash: string }): Promise<unknown>;
};

// "accepted" means the buyer's payment has arrived and is locked, waiting for the code or a cancel.
export function isLocked(tx: Tx | null | undefined): boolean {
  return tx?.state === "accepted";
}

export type LockResult = "locked" | "expired" | "cancelled" | "stopped";

export async function waitForLock(
  wallet: WalletLike,
  paymentHash: string,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<LockResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const end = now() + opts.timeoutMs;
  while (now() < end) {
    if (opts.signal?.aborted) return "stopped";
    try {
      const tx = await wallet.lookupInvoice({ payment_hash: paymentHash });
      if (isLocked(tx) || isSettled(tx)) return "locked";
      const state = tx?.state;
      if (state === "expired" || state === "failed") return "expired";
      if (state === "canceled" || state === "cancelled") return "cancelled";
    } catch {
      // A temporary network error: keep trying until the timeout.
    }
    await sleep(opts.intervalMs);
  }
  return "expired";
}
