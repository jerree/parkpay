import test from "node:test";
import assert from "node:assert/strict";
import { cleanNote, newReceipt, markPaid, markExpired, totalsForDay, startOfLocalDay, toCsv } from "../src/lib/receipts.ts";

const base = { now: 1_000_000, amountKobo: 250000, sats: 1563, ngnPerBtc: 160_000_000, note: "rice", demo: false };

test("cleanNote strips control characters and limits length", () => {
  assert.equal(cleanNote("  hi\nthere\t "), "hi there");
  assert.equal(cleanNote("x".repeat(100)).length, 60);
});

test("receipt lifecycle only changes pending receipts", () => {
  let list = [newReceipt({ ...base, id: "a" }), newReceipt({ ...base, id: "b" })];
  list = markPaid(list, "a", 2_000_000);
  list = markExpired(list, "b");
  assert.equal(list[0].status, "paid");
  assert.equal(list[0].paidAt, 2_000_000);
  assert.equal(list[1].status, "expired");
  list = markExpired(list, "a"); // already paid: must stay paid
  assert.equal(list[0].status, "paid");
});

test("totals count only real paid receipts from that day", () => {
  const now = Date.now();
  const day = startOfLocalDay(now);
  let list = [
    newReceipt({ ...base, id: "real", now }),
    newReceipt({ ...base, id: "demo", now, demo: true }),
    newReceipt({ ...base, id: "pending", now }),
    newReceipt({ ...base, id: "old", now }),
  ];
  list = markPaid(list, "real", now);
  list = markPaid(list, "demo", now);
  list = markPaid(list, "old", day - 1000);
  assert.deepEqual(totalsForDay(list, day), { count: 1, kobo: 250000, sats: 1563 });
});

test("CSV neutralizes spreadsheet formulas and escapes quotes", () => {
  const r = newReceipt({ ...base, id: "x", note: '=SUM(A1) "hi"' });
  const csv = toCsv([r]);
  assert.ok(csv.includes(`"'=SUM(A1) ""hi"""`));
  assert.equal(csv.split("\n").length, 2);
});
