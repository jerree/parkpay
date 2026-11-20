// A fake hold-invoice wallet for demos and judging. It moves NO real money.
// It does check the secret code properly, so the demo behaves like the real thing.

import { hashOfCode } from "./escrow.ts";
import type { DealState } from "./escrow.ts";
import type { HoldWalletLike } from "./holdWallet.ts";

type DemoState = "pending" | "accepted" | "settled" | "canceled";
export type DemoHoldWallet = HoldWalletLike & { simulatePayment(paymentHash: string): void };

// The browser stores deals but not the wallet object, so a page reload would otherwise
// leave the demo wallet with no memory of invoices it already created. Seeding it from
// the saved deals keeps a demo alive across a reload.
export type DemoSeed = { hash: string; state: DealState };

function seedState(state: DealState): DemoState | null {
  if (state === "invoice_ready") return "pending";
  if (state === "locked") return "accepted";
  if (state === "released") return "settled";
  if (state === "cancelled" || state === "expired") return "canceled";
  return null; // "created": no invoice exists yet
}

export function createDemoHoldWallet(seed?: readonly DemoSeed[]): DemoHoldWallet {
  const states = new Map<string, DemoState>();
  for (const s of seed ?? []) {
    const mapped = seedState(s.state);
    if (mapped !== null && !states.has(s.hash)) states.set(s.hash, mapped);
  }
  return {
    async makeInvoice() {
      throw new Error("not used in demo");
    },
    async makeHoldInvoice({ amount, payment_hash, expiry }) {
      states.set(payment_hash, "pending");
      const seconds = typeof expiry === "number" && expiry > 0 ? expiry : 3600;
      return {
        invoice: `lnbcDEMO${amount}n1demo${payment_hash.slice(0, 32)}`,
        payment_hash,
        expires_at: Math.floor(Date.now() / 1000) + seconds,
      };
    },
    async lookupInvoice({ payment_hash }) {
      const state = states.get(payment_hash);
      if (state === undefined) throw new Error("not found");
      return state === "settled" ? { state, settled_at: Math.floor(Date.now() / 1000) } : { state };
    },
    async settleHoldInvoice({ preimage }) {
      const hash = await hashOfCode(preimage);
      if (hash === null || states.get(hash) !== "accepted") throw new Error("cannot settle");
      states.set(hash, "settled");
      return {};
    },
    async cancelHoldInvoice({ payment_hash }) {
      const state = states.get(payment_hash);
      if (state === "pending" || state === "accepted") states.set(payment_hash, "canceled");
      return {};
    },
    async getInfo() {
      return { methods: ["get_info", "make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice", "lookup_invoice"] };
    },
    simulatePayment(paymentHash) {
      if (states.get(paymentHash) === "pending") states.set(paymentHash, "accepted");
    },
  };
}
