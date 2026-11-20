// Two-account end-to-end test for the live (Supabase) app.
//
// 1. Put the Supabase URL and anon key in .env.local.
// 2. Run the app: npm run dev -- --port 5174
// 3. Run this: node tests/e2e-live.mjs http://localhost:5174/
//
// It uses Microsoft Edge by default (Windows). Set EDGE_PATH to another
// Chromium browser if needed. It creates throwaway accounts with unique
// emails and usernames, so it can be run more than once.
import { spawn } from "node:child_process";
import path from "node:path";

const EDGE =
  process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP = process.argv[2] || "http://localhost:5174/";
const PROFILE_ROOT = process.env.TEMP || process.env.TMP || ".";
const stamp = Date.now().toString().slice(-6);
const sellerName = "Ada Seller";
const buyerName = "Bola Buyer";
const sellerUser = `ada${stamp}`;
const buyerUser = `bola${stamp}`;
const sellerEmail = `ada.${stamp}@example.com`;
const buyerEmail = `bola.${stamp}@example.com`;
const password = "password123";
const pin = "123456";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stepNo = 0;
function step(msg) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${msg}`);
}
function pass(msg) {
  console.log(`   PASS: ${msg}`);
}
function fail(msg) {
  console.log(`   FAIL: ${msg}`);
  process.exitCode = 1;
}

class Browser {
  constructor(label, port) {
    this.label = label;
    this.port = port;
    this.profile = path.join(PROFILE_ROOT, `oja-live-e2e-${label}-${stamp}`);
    this.consoleErrors = [];
    this.pageErrors = [];
    this.msgId = 0;
    this.pending = new Map();
  }

  async start() {
    this.proc = spawn(
      EDGE,
      [
        "--headless=new",
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--window-size=430,900",
        APP,
      ],
      { stdio: "ignore" },
    );
    const target = await this.findTarget();
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
        return;
      }
      if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
        const text = data.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        this.consoleErrors.push(text);
      }
      if (data.method === "Runtime.exceptionThrown") {
        const d = data.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description || d.text);
      }
      if (data.method === "Page.javascriptDialogOpening") {
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.until("document.readyState === 'complete'", 30000, "app loaded");
    const text = await this.text();
    if (text.includes("Connect Supabase")) {
      throw new Error(`${this.label}: .env.local is missing or the app is not configured`);
    }
    await this.until("!!document.querySelector('form')", 15000, "sign-in form");
    return this;
  }

  async findTarget() {
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page;
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    throw new Error(`${this.label}: CDP endpoint never came up`);
  }

  send(method, params = {}) {
    const id = ++this.msgId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  async until(expression, timeoutMs = 20000, label = expression) {
    const start = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.evaluate(expression);
      } catch {
        v = false;
      }
      if (v) return v;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`${this.label}: timeout waiting for ${label}`);
      }
      await sleep(200);
    }
  }

  text() {
    return this.evaluate("document.body.innerText");
  }

  async expect(snippet, timeoutMs = 20000) {
    await this.until(
      `document.body.innerText.includes(${JSON.stringify(snippet)})`,
      timeoutMs,
      `text "${snippet}"`,
    );
    pass(`${this.label} sees "${snippet}"`);
  }

  async clickText(label, exact = true) {
    const ok = await this.evaluate(`(() => {
      const want = ${JSON.stringify(label)};
      const btn = [...document.querySelectorAll('button')].find((b) =>
        ${exact ? "b.textContent.trim() === want" : "b.textContent.includes(want)"}
      );
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!ok) throw new Error(`${this.label}: button not found: ${label}`);
  }

  async clickSel(selector) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`${this.label}: element not found: ${selector}`);
  }

  async fill(selector, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`${this.label}: field not found: ${selector}`);
  }

  async signup(name, username, email) {
    await this.clickText("Sign up");
    await this.fill("#aname", name);
    await this.fill("#auser", username);
    await this.fill("#aemail", email);
    await this.fill("#apass", password);
    await this.clickSel('button[type="submit"]');
    await this.expect(`Signed in as ${name}`);
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: true });
    await sleep(1200);
    await this.until("document.readyState === 'complete' && !!document.querySelector('form')", 30000, "reload");
  }

  async report() {
    if (this.consoleErrors.length) {
      fail(`${this.label} console errors:\n     ${this.consoleErrors.join("\n     ")}`);
    }
    if (this.pageErrors.length) {
      fail(`${this.label} page errors:\n     ${this.pageErrors.join("\n     ")}`);
    }
  }
}

const seller = new Browser("seller", 9341);
const buyer = new Browser("buyer", 9342);

try {
  step("Open the app in two separate browsers");
  await seller.start();
  await buyer.start();
  await seller.expect("ParkPay");
  await buyer.expect("ParkPay");
  pass("both browsers loaded");

  step("Seller signs up");
  await seller.signup(sellerName, sellerUser, sellerEmail);

  step("Buyer signs up");
  await buyer.signup(buyerName, buyerUser, buyerEmail);

  step("Seller: use demo mode");
  await seller.clickText("Try demo mode");
  await seller.expect("DEMO: no real money");
  await seller.expect("Sell something");

  step("Seller: set the rate");
  await seller.fill("#rate", "100000000");
  await seller.clickText("Use this rate");
  await seller.expect("1 BTC = ₦100,000,000.00");

  step("Seller: create a deal for the buyer's username");
  await seller.fill("#buyer", buyerUser);
  await seller.fill("#item", "Phone 12 Pro");
  await seller.fill("#price", "25000");
  await seller.fill("#drivername", "Musa");
  await seller.fill("#driverphone", "08012345678");
  await seller.fill("#hours", "48");
  await seller.clickText("Send deal to buyer");
  await seller.expect(`Deal sent to @${buyerUser}.`);
  await seller.expect(`Waiting for @${buyerUser} to set a PIN.`);

  step("Buyer: the deal appears on the dashboard without a link");
  const dealVisible = await buyer
    .until(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Phone 12 Pro'))`,
      10000,
      "deal on buyer dashboard",
    )
    .catch(() => false);
  if (!dealVisible) {
    pass("realtime missed the insert; reloading the buyer dashboard");
    await buyer.reload();
    await buyer.until(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Phone 12 Pro'))`,
      15000,
      "deal after reload",
    );
  }
  await buyer.clickText("Phone 12 Pro", false);
  await buyer.expect("Set PIN and lock payment");

  step("Buyer: set a PIN and lock");
  await buyer.fill("#bpin", pin);
  await buyer.fill("#bpin2", pin);
  await buyer.clickText("Set PIN and lock payment");
  await buyer.expect("PIN set. Waiting for the seller to create the invoice...");

  step("Seller: invoice is created automatically");
  await seller.expect(`Invoice sent to @${buyerUser}. Waiting for payment.`);
  await seller.expect("Simulate buyer payment (demo only)");

  step("Seller: simulate the buyer's payment");
  await seller.clickText("Simulate buyer payment (demo only)");
  await seller.expect("Simulated payment. Waiting for the wallet to report the lock...");

  step("Both sides see the locked payment live");
  await seller.expect("Payment locked. You can ship the package.", 30000);
  await buyer.expect("Payment locked. The seller can now ship the package.", 30000);

  step("Buyer: release the code after handover");
  await buyer.clickSel("#codeok");
  await buyer.fill("#rpin", pin);
  await buyer.clickText("Release my code");
  await buyer.expect("Code sent. The seller is claiming the payment.", 10000);

  step("Seller: claims the payment automatically");
  await seller.expect("VALID. Payment received. Tell the driver to release the package now.", 30000);

  step("Buyer: deal completes live");
  await buyer.expect("Done. The seller received the payment.", 20000);

  step("No browser errors");
  await seller.report();
  await buyer.report();
  if (!process.exitCode) console.log("\nALL LIVE E2E CHECKS PASSED");
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  for (const [name, b] of [["seller", seller], ["buyer", buyer]]) {
    try {
      const text = await b.text();
      console.log(`\n--- ${name} page text ---\n${text}`);
    } catch {
      // browser not available
    }
  }
} finally {
  await sleep(300);
  seller.proc?.kill();
  buyer.proc?.kill();
}
