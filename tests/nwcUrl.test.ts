import test from "node:test";
import assert from "node:assert/strict";
import { parseNwcUrl } from "../src/lib/nwcUrl.ts";

const PUB = "a".repeat(64);
const SECRET = "b".repeat(64);
const good = `nostr+walletconnect://${PUB}?relay=${encodeURIComponent("wss://relay.example.com")}&secret=${SECRET}`;

test("accepts a valid link and never returns the secret", () => {
  const r = parseNwcUrl(good);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.info.pubkey, PUB);
    assert.deepEqual(r.info.relays, ["wss://relay.example.com"]);
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
});

test("accepts the no-slashes form", () => {
  const r = parseNwcUrl(`nostr+walletconnect:${PUB}?relay=wss%3A%2F%2Fr.example.com&secret=${SECRET}`);
  assert.equal(r.ok, true);
});

test("rejects bad links", () => {
  const cases = [
    "https://example.com",
    `nostr+walletconnect://nothex?relay=wss%3A%2F%2Fr.example.com&secret=${SECRET}`,
    `nostr+walletconnect://${PUB}?secret=${SECRET}`,
    `nostr+walletconnect://${PUB}?relay=ws%3A%2F%2Fr.example.com&secret=${SECRET}`,
    `nostr+walletconnect://${PUB}?relay=wss%3A%2F%2Fr.example.com`,
    `nostr+walletconnect://${PUB}?relay=wss%3A%2F%2Fr.example.com&secret=short`,
    "",
  ];
  for (const c of cases) assert.equal(parseNwcUrl(c).ok, false, c);
});
