import test from "node:test";
import assert from "node:assert/strict";
import { isSettled, hasSpendingPower, waitForPayment } from "../src/lib/wallet.ts";
import type { WalletLike, Tx } from "../src/lib/wallet.ts";
import { createDemoWallet } from "../src/lib/demoWallet.ts";

function fakeWallet(answers: Array<Tx | Error>): WalletLike {
  let i = 0;
  return {
    async makeInvoice() { return { invoice: "lnbc1", payment_hash: "h" }; },
    async lookupInvoice() {
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("isSettled needs an explicit settlement signal", () => {
  assert.equal(isSettled({ settled_at: 1700000000 }), true);
  assert.equal(isSettled({ state: "settled" }), true);
  assert.equal(isSettled({ state: "pending" }), false);
  assert.equal(isSettled({}), false);
  assert.equal(isSettled(undefined), false);
  assert.equal(isSettled({ preimage: "abc" } as unknown as Tx), false); // a preimage alone is not proof
});

test("hasSpendingPower spots connections that can send money", () => {
  assert.equal(hasSpendingPower(["make_invoice", "lookup_invoice"]), false);
  assert.equal(hasSpendingPower(["make_invoice", "pay_invoice"]), true);
  assert.equal(hasSpendingPower(undefined), false);
});

test("waitForPayment: pending then settled gives paid", async () => {
  const c = clock();
  const r = await waitForPayment(fakeWallet([{ state: "pending" }, { state: "pending" }, { state: "settled" }]), "h", { timeoutMs: 60000, intervalMs: 2000, ...c });
  assert.equal(r, "paid");
});

test("waitForPayment: survives a temporary network error", async () => {
  const c = clock();
  const r = await waitForPayment(fakeWallet([new Error("net"), { settled_at: 1 }]), "h", { timeoutMs: 60000, intervalMs: 2000, ...c });
  assert.equal(r, "paid");
});

test("waitForPayment: never paid gives expired after the timeout", async () => {
  const c = clock();
  const r = await waitForPayment(fakeWallet([{ state: "pending" }]), "h", { timeoutMs: 10000, intervalMs: 2000, ...c });
  assert.equal(r, "expired");
});

test("waitForPayment: expired state ends early, abort gives cancelled", async () => {
  const c = clock();
  assert.equal(await waitForPayment(fakeWallet([{ state: "expired" }]), "h", { timeoutMs: 60000, intervalMs: 2000, ...c }), "expired");
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(await waitForPayment(fakeWallet([{ state: "pending" }]), "h", { timeoutMs: 60000, intervalMs: 2000, signal: ctrl.signal, ...clock() }), "cancelled");
});

test("demo wallet settles after the delay and is receive-only", async () => {
  const w = createDemoWallet(0);
  const inv = await w.makeInvoice({ amount: 1000000 });
  assert.ok(inv.invoice.startsWith("lnbcDEMO"));
  assert.equal(isSettled(await w.lookupInvoice({ payment_hash: inv.payment_hash })), true);
  const info = await w.getInfo!();
  assert.equal(hasSpendingPower(info.methods), false);
  assert.equal(isSettled(await createDemoWallet(60000).lookupInvoice({ payment_hash: "unknown" })), false);
});
