import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSecret, hashOfCode, verifyCode, newDealId, encodeShare, decodeShare,
  nextState, isFinished, expiryTime, handoverCheck, MAX_SATS,
} from "../src/lib/escrow.ts";
import type { Share, DealState, DealEvent } from "../src/lib/escrow.ts";

test("the code is 64 hex characters, different each time, and matches its fingerprint", async () => {
  const a = await generateSecret();
  const b = await generateSecret();
  assert.match(a.code, /^[0-9a-f]{64}$/);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(await hashOfCode(a.code), a.hash);
});

test("verifyCode accepts the right code and rejects everything else", async () => {
  const s = await generateSecret();
  const other = await generateSecret();
  assert.equal(await verifyCode(s.code, s.hash), true);
  assert.equal(await verifyCode(`  ${s.code.toUpperCase()} `, s.hash), true); // tidy input
  assert.equal(await verifyCode(other.code, s.hash), false);
  assert.equal(await verifyCode("123456", s.hash), false); // a short code is never valid
  assert.equal(await verifyCode("zz".repeat(32), s.hash), false);
  assert.equal(await verifyCode(s.code, "nothex"), false);
  assert.equal(await verifyCode("", s.hash), false);
});

test("known test vector: the fingerprint of 32 zero bytes", async () => {
  assert.equal(
    await hashOfCode("00".repeat(32)),
    "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
  );
});

test("deal ids look right", () => {
  assert.match(newDealId(), /^[a-z0-9]{8,32}$/);
  assert.notEqual(newDealId(), newDealId());
});

test("every message type survives encode then decode", async () => {
  const s = await generateSecret();
  const msgs: Share[] = [
    { t: "deal", v: 1, id: "abcd1234", item: "Black sneakers, size 43", sats: 25000, driver: "Mr Musa, 080 0000 0000", hours: 48 },
    { t: "lock", v: 1, id: "abcd1234", hash: s.hash },
    { t: "invoice", v: 1, id: "abcd1234", invoice: "lnbc250u1p" + "q".repeat(60), expiresAt: 1_800_000_000_000 },
    { t: "release", v: 1, id: "abcd1234", code: s.code },
  ];
  for (const m of msgs) assert.deepEqual(decodeShare(encodeShare(m)), m);
});

test("decodeShare rejects garbage, bad fields and oversized input", async () => {
  const s = await generateSecret();
  const bad = [
    "", "not base64 at all!!", encodeShare({ t: "x" } as unknown as Share),
    encodeShare({ t: "lock", v: 1, id: "abcd1234", hash: "short" }),
    encodeShare({ t: "lock", v: 1, id: "BAD ID", hash: s.hash }),
    encodeShare({ t: "release", v: 1, id: "abcd1234", code: "123456" }),
    encodeShare({ t: "deal", v: 1, id: "abcd1234", item: "", sats: 1000, driver: "x", hours: 24 }),
    encodeShare({ t: "deal", v: 1, id: "abcd1234", item: "x", sats: MAX_SATS + 1, driver: "x", hours: 24 }),
    encodeShare({ t: "deal", v: 1, id: "abcd1234", item: "x", sats: 1000, driver: "x", hours: 500 }),
    encodeShare({ t: "deal", v: 1, id: "abcd1234", item: "x", sats: 1.5, driver: "x", hours: 24 } as unknown as Share),
    "A".repeat(5000),
  ];
  for (const b of bad) assert.equal(decodeShare(b), null, b.slice(0, 40));
});

test("decodeShare copies only known fields", () => {
  const sneaky = encodeShare({ t: "lock", v: 1, id: "abcd1234", hash: "a".repeat(64), extra: "evil", __proto__: { x: 1 } } as unknown as Share);
  const out = decodeShare(sneaky);
  assert.deepEqual(Object.keys(out as object).sort(), ["hash", "id", "t", "v"]);
});

test("state machine: the happy path and the refund paths", () => {
  let s: DealState = "created";
  s = nextState(s, "invoice_created")!; assert.equal(s, "invoice_ready");
  s = nextState(s, "payment_locked")!; assert.equal(s, "locked");
  s = nextState(s, "code_accepted")!; assert.equal(s, "released");
  assert.equal(nextState("locked", "cancelled"), "cancelled");
  assert.equal(nextState("locked", "timed_out"), "expired");
  assert.equal(nextState("invoice_ready", "timed_out"), "expired");
});

test("state machine: nothing is allowed after a deal is finished, and no shortcuts", () => {
  const events: DealEvent[] = ["invoice_created", "payment_locked", "code_accepted", "cancelled", "timed_out"];
  for (const done of ["released", "cancelled", "expired"] as DealState[]) {
    assert.equal(isFinished(done), true);
    for (const e of events) assert.equal(nextState(done, e), null, `${done} + ${e}`);
  }
  assert.equal(nextState("created", "code_accepted"), null); // cannot release before money is locked
  assert.equal(nextState("invoice_ready", "code_accepted"), null);
  assert.equal(nextState("created", "payment_locked"), null);
  assert.equal(isFinished("locked"), false);
});

test("expiryTime stays inside the allowed range", () => {
  assert.equal(expiryTime(0, 48), 48 * 3600 * 1000);
  assert.equal(expiryTime(0, 1000), 72 * 3600 * 1000);
  assert.equal(expiryTime(0, 0), 1 * 3600 * 1000);
});

test("handoverCheck only says ok when locked, valid and not about to expire", () => {
  const base = { state: "locked" as DealState, codeValid: true, expiresAt: 10_000_000, now: 1_000_000 };
  assert.deepEqual(handoverCheck(base), { ok: true });
  assert.equal(handoverCheck({ ...base, state: "invoice_ready" }).ok, false);
  assert.equal(handoverCheck({ ...base, state: "expired" }).ok, false);
  assert.equal(handoverCheck({ ...base, codeValid: false }).ok, false);
  assert.equal(handoverCheck({ ...base, now: base.expiresAt - 60_000 }).ok, false); // inside the margin
  assert.equal(handoverCheck({ ...base, now: base.expiresAt + 1 }).ok, false);
});
