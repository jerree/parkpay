// A fake wallet for demos and judging. It moves NO real money and is always labelled DEMO in the app.

import type { WalletLike } from "./wallet.ts";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createDemoWallet(settleAfterMs = 5000): WalletLike {
  const created = new Map<string, number>();
  return {
    async makeInvoice({ amount }) {
      const hash = randomHex(32);
      created.set(hash, Date.now());
      return { invoice: `lnbcDEMO${amount}n1demo${hash.slice(0, 24)}`, payment_hash: hash };
    },
    async lookupInvoice({ payment_hash }) {
      const t = created.get(payment_hash);
      if (t !== undefined && Date.now() - t >= settleAfterMs) {
        return { settled_at: Math.floor(Date.now() / 1000), state: "settled" };
      }
      return { state: "pending" };
    },
    async getInfo() {
      return { methods: ["get_info", "make_invoice", "lookup_invoice"] };
    },
  };
}
