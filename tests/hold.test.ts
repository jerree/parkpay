import test from "node:test";
import assert from "node:assert/strict";
import { isLocked, waitForLock } from "../src/lib/holdWallet.ts";
import type { HoldWalletLike } from "../src/lib/holdWallet.ts";
import type { Tx } from "../src/lib/wallet.ts";
import { createDemoHoldWallet } from "../src/lib/demoHoldWallet.ts";
import { generateSecret } from "../src/lib/escrow.ts";
import { applyEvent, upsert, newSellerDeal, buyerDealFromTerms, dealKey } from "../src/lib/deals.ts";

function fake(answers: Array<Tx | Error>): HoldWalletLike {
  let i = 0;
  return {
    async makeInvoice() { return { invoice: "x", payment_hash: "h" }; },
    async makeHoldInvoice() { return { invoice: "x", payment_hash: "h" }; },
    async settleHoldInvoice() { return {}; },
    async cancelHoldInvoice() { return {}; },
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
const opts = { timeoutMs: 60000, intervalMs: 3000 };

test("isLocked means the accepted state, nothing else", () => {
  assert.equal(isLocked({ state: "accepted" }), true);
  for (const s of ["pending", "settled", "canceled", "expired", undefined]) assert.equal(isLocked({ state: s }), false);
  assert.equal(isLocked(undefined), false);
});

test("waitForLock: pending then accepted gives locked", async () => {
  assert.equal(await waitForLock(fake([{ state: "pending" }, { state: "accepted" }]), "h", { ...opts, ...clock() }), "locked");
});

test("waitForLock: survives a network error, then ends on expired or cancelled", async () => {
  assert.equal(await waitForLock(fake([new Error("net"), { state: "accepted" }]), "h", { ...opts, ...clock() }), "locked");
  assert.equal(await waitForLock(fake([{ state: "expired" }]), "h", { ...opts, ...clock() }), "expired");
  assert.equal(await waitForLock(fake([{ state: "canceled" }]), "h", { ...opts, ...clock() }), "cancelled");
});

test("waitForLock: never paid gives expired, abort gives stopped", async () => {
  assert.equal(await waitForLock(fake([{ state: "pending" }]), "h", { timeoutMs: 9000, intervalMs: 3000, ...clock() }), "expired");
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(await waitForLock(fake([{ state: "pending" }]), "h", { ...opts, signal: ctrl.signal, ...clock() }), "stopped");
});

test("demo wallet: lock, wrong code fails, right code settles", async () => {
  const w = createDemoHoldWallet();
  const s = await generateSecret();
  const other = await generateSecret();
  const inv = await w.makeHoldInvoice({ amount: 1000, payment_hash: s.hash });
  assert.ok(inv.invoice.startsWith("lnbcDEMO"));
  assert.equal((await w.lookupInvoice({ payment_hash: s.hash })).state, "pending");
  await assert.rejects(w.settleHoldInvoice({ preimage: s.code })); // not paid yet
  w.simulatePayment(s.hash);
  assert.equal(isLocked(await w.lookupInvoice({ payment_hash: s.hash })), true);
  await assert.rejects(w.settleHoldInvoice({ preimage: other.code })); // wrong code
  await w.settleHoldInvoice({ preimage: s.code });
  assert.equal((await w.lookupInvoice({ payment_hash: s.hash })).state, "settled");
});

test("demo wallet: cancel returns the deal to cancelled and blocks settling", async () => {
  const w = createDemoHoldWallet();
  const s = await generateSecret();
  await w.makeHoldInvoice({ amount: 1000, payment_hash: s.hash });
  w.simulatePayment(s.hash);
  await w.cancelHoldInvoice({ payment_hash: s.hash });
  assert.equal((await w.lookupInvoice({ payment_hash: s.hash })).state, "canceled");
  await assert.rejects(w.settleHoldInvoice({ preimage: s.code }));
});

test("deals: builders, events and upsert", () => {
  const seller = newSellerDeal({ item: "Shoes", sats: 25000, driver: "Mr Musa", hours: 48, demo: false, now: 1 });
  assert.equal(seller.role, "seller");
  assert.equal(seller.state, "created");
  assert.equal(seller.key, dealKey("seller", seller.id));
  const buyer = buyerDealFromTerms({ id: seller.id, item: "Shoes", sats: 25000, driver: "Mr Musa", hours: 48 }, 2);
  assert.notEqual(buyer.key, seller.key); // one browser can hold both sides
  const moved = applyEvent(seller, "invoice_created");
  assert.equal(moved?.state, "invoice_ready");
  assert.equal(applyEvent(seller, "code_accepted"), null); // cannot release before the money is locked
  let list = upsert([], seller);
  list = upsert(list, buyer);
  list = upsert(list, { ...seller, state: "locked" });
  assert.equal(list.length, 2);
  assert.equal(list.find((d) => d.key === seller.key)?.state, "locked");
});
