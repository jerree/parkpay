import test from "node:test";
import assert from "node:assert/strict";
import { seal, unseal, validatePin } from "../src/lib/vault.ts";

test("seal then unseal returns the original text", async () => {
  const vault = await seal("secret wallet link", "123456");
  assert.equal(await unseal(vault, "123456"), "secret wallet link");
});

test("wrong PIN or tampered data returns null", async () => {
  const vault = await seal("secret wallet link", "123456");
  assert.equal(await unseal(vault, "654321"), null);
  assert.equal(await unseal({ ...vault, ct: vault.ct.slice(0, -4) + "AAAA" }, "123456"), null);
});

test("the stored form hides the text and differs every time", async () => {
  const a = await seal("same text", "123456");
  const b = await seal("same text", "123456");
  assert.notEqual(a.ct, b.ct);
  assert.equal(JSON.stringify(a).includes("same text"), false);
});

test("PIN rules", () => {
  assert.equal(validatePin("123456"), null);
  assert.notEqual(validatePin("12345"), null);
  assert.notEqual(validatePin("12345a"), null);
  assert.notEqual(validatePin("1234567890123"), null);
});
