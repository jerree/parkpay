import test from "node:test";
import assert from "node:assert/strict";
import { parseNairaToKobo, koboToSats, formatNaira, formatNairaInput, formatSats } from "../src/lib/money.ts";
import { parseRate, isRatePlausible } from "../src/lib/rate.ts";

test("parseNairaToKobo accepts plain, comma and decimal amounts", () => {
  assert.equal(parseNairaToKobo("1000"), 100000);
  assert.equal(parseNairaToKobo("2,500.50"), 250050);
  assert.equal(parseNairaToKobo("₦ 150"), 15000);
  assert.equal(parseNairaToKobo("99.5"), 9950);
});

test("parseNairaToKobo rejects bad input", () => {
  for (const bad of ["", "0", "-5", "abc", "12.345", "1e6", "5000001", "1,2,3x"]) {
    assert.equal(parseNairaToKobo(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("koboToSats converts and rounds up", () => {
  assert.equal(koboToSats(100000, 100_000_000), 1000); // N1,000 at N100M per BTC
  assert.equal(koboToSats(100, 150_000_000), 1); // a fraction still costs 1 sat
  assert.equal(koboToSats(250000, 160_000_000), 1563); // 1562.5 rounds up
});

test("koboToSats rejects impossible input", () => {
  assert.equal(koboToSats(0, 100_000_000), null);
  assert.equal(koboToSats(100, 0), null);
  assert.equal(koboToSats(100, Number.NaN), null);
  assert.equal(koboToSats(1.5, 100_000_000), null);
});

test("formatting", () => {
  assert.equal(formatNaira(250050), "₦2,500.50");
  assert.equal(formatSats(1563), "1,563 sats");
});

test("formatNairaInput groups thousands while typing", () => {
  assert.equal(formatNairaInput(""), "");
  assert.equal(formatNairaInput("1000"), "1,000");
  assert.equal(formatNairaInput("1000000"), "1,000,000");
  assert.equal(formatNairaInput("1,000.5"), "1,000.5");
  assert.equal(formatNairaInput("1000.567"), "1,000.56");
  assert.equal(formatNairaInput("abc12x3"), "123");
  assert.equal(formatNairaInput("000123"), "123");
  assert.equal(formatNairaInput("."), "0.");
});

test("rate parsing and plausibility", () => {
  assert.equal(parseRate("150,000,000"), 150000000);
  assert.equal(parseRate("0"), null);
  assert.equal(parseRate("abc"), null);
  assert.equal(isRatePlausible(150_000_000), true);
  assert.equal(isRatePlausible(1000), false);
});

import { formatNairaInput as _fmt } from "../src/lib/money.ts";

test("formatNairaInput adds commas while typing", () => {
  assert.equal(_fmt("1000"), "1,000");
  assert.equal(_fmt("100000"), "100,000");
  assert.equal(_fmt("1234567"), "1,234,567");
  assert.equal(_fmt("1,000"), "1,000");
});

test("formatNairaInput keeps two decimals and strips junk", () => {
  assert.equal(_fmt("1500.505"), "1,500.50");
  assert.equal(_fmt("₦2500abc"), "2,500");
  assert.equal(_fmt("0050"), "50");
  assert.equal(_fmt(""), "");
});
