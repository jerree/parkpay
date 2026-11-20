import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { expiryTime, generateSecret, MAX_HOURS, MAX_SATS, MIN_HOURS, SAFETY_MARGIN_MS, verifyCode } from "./lib/escrow.ts";
import { createDemoHoldWallet } from "./lib/demoHoldWallet.ts";
import type { DemoHoldWallet } from "./lib/demoHoldWallet.ts";
import { isLocked } from "./lib/holdWallet.ts";
import type { HoldWalletLike } from "./lib/holdWallet.ts";
import { formatNaira, formatNairaInput, formatSats, koboToSats, parseNairaToKobo } from "./lib/money.ts";
import { parseNwcUrl } from "./lib/nwcUrl.ts";
import { fetchNgnPerBtc, isRatePlausible, parseRate } from "./lib/rate.ts";
import { supabase, supabaseReady } from "./lib/supabase.ts";
import { createDeal, fetchProfile, findProfileByUsername, listDeals, loadSecret, patchDeal, saveSecret, usernameAvailable } from "./lib/db.ts";
import type { DealRow, DealState, Profile } from "./lib/live.ts";
import { demoSeedState, isFinal, STATE_LABEL, STATE_STEP, STEPS } from "./lib/live.ts";
import { seal, unseal, validatePin } from "./lib/vault.ts";
import type { Vault } from "./lib/vault.ts";
import { hasSpendingPower, isSettled } from "./lib/wallet.ts";

const WALLET_KEY = "oja.wallet.v2";
const RATE_KEY = "oja.rate.v2";
const POLL_MS = 4000;
const DEMO_RATE = 100_000_000;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked; the app keeps working for this session.
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function authMessage(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("already registered")) return "That email already has an account. Log in instead.";
  if (text.includes("database error")) return "That username is taken. Try another one.";
  if (text.includes("invalid login")) return "Wrong email or password.";
  if (text.includes("email not confirmed")) return "Confirm your email first, or turn off email confirmation in Supabase.";
  if (text.includes("password")) return "Use a password with at least 6 characters.";
  return message;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

function Wordmark() {
  return (
    <span className="brand-text">
      Park<em>Pay</em>
    </span>
  );
}

function Mark() {
  return <img className="mark" src="/logo-mark.png" alt="" width={34} height={34} />;
}

function IconShield() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14.5v2" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
      <path d="M4 8.5 12 13l8-4.5" />
      <path d="M12 13v7" />
    </svg>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authName, setAuthName] = useState("");
  const [authUsername, setAuthUsername] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  const [deals, setDeals] = useState<DealRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [toastKey, setToastKey] = useState(0);
  const [confirmDlg, setConfirmDlg] = useState<{ text: string; yes: string; resolve: (ok: boolean) => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const [vault, setVault] = useState<Vault | null>(null);
  const [wallet, setWallet] = useState<HoldWalletLike | null>(null);
  const [demo, setDemo] = useState(false);
  const [permission, setPermission] = useState<"unknown" | "ok" | "can-spend">("unknown");
  const [linkText, setLinkText] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");

  const [rate, setRate] = useState<number | null>(() => load<{ value: number } | null>(RATE_KEY, null)?.value ?? null);
  const [rateText, setRateText] = useState(() => {
    const saved = load<{ value: number } | null>(RATE_KEY, null)?.value;
    return saved ? formatNairaInput(String(saved)) : "";
  });
  const [buyerUsername, setBuyerUsername] = useState("");
  const [itemText, setItemText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [driverNameText, setDriverNameText] = useState("");
  const [driverPhoneText, setDriverPhoneText] = useState("");
  const [hoursText, setHoursText] = useState("48");

  const [bpin, setBpin] = useState("");
  const [bpin2, setBpin2] = useState("");
  const [releasePin, setReleasePin] = useState("");
  const [codeConfirmed, setCodeConfirmed] = useState(false);
  const [qr, setQr] = useState("");

  const working = useRef<Set<string>>(new Set());
  const demoWalletRef = useRef<DemoHoldWallet | null>(null);

  const myId = session?.user.id ?? "";
  const selectedDeal = deals.find((d) => d.id === selectedId) ?? null;

  function notify(text: string) {
    setNotice(text);
    setError("");
    setToastKey((k) => k + 1);
  }
  function fail(text: string) {
    setError(text);
    setNotice("");
    setToastKey((k) => k + 1);
  }
  // The site's own confirmation box, used instead of the browser's pop-up.
  function askConfirm(text: string, yes = "Yes, continue"): Promise<boolean> {
    return new Promise((resolve) => setConfirmDlg({ text, yes, resolve }));
  }
  function closeConfirm(ok: boolean) {
    confirmDlg?.resolve(ok);
    setConfirmDlg(null);
  }

  useEffect(() => {
    if (!notice) return;
    // Short messages ("Copied.") fade quickly; instructions stay long enough to read.
    const t = window.setTimeout(() => setNotice(""), notice.length > 40 ? 12000 : 3500);
    return () => window.clearTimeout(t);
  }, [notice, toastKey]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(""), 8000);
    return () => window.clearTimeout(t);
  }, [error, toastKey]);

  useEffect(() => {
    if (!confirmDlg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        confirmDlg.resolve(false);
        setConfirmDlg(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDlg]);

  // ---- auth ----
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        let p = await fetchProfile(session.user.id);
        if (!p) {
          const meta = session.user.user_metadata as { name?: string; username?: string; phone?: string };
          const username = (meta.username ?? "").toLowerCase();
          if (username) {
            const { error: insertError } = await supabase.from("profiles").insert({
              id: session.user.id,
              username,
              name: meta.name ?? session.user.email?.split("@")[0] ?? "User",
              phone: meta.phone || null,
            });
            if (insertError) throw insertError;
            p = await fetchProfile(session.user.id);
          }
        }
        if (alive) setProfile(p);
      } catch {
        if (alive) fail("Could not load your profile. Refresh and try again.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [session?.user.id]);

  useEffect(() => {
    if (!profile) {
      setVault(null);
      return;
    }
    setVault(load<Vault | null>(`${WALLET_KEY}.${profile.id}`, null));
  }, [profile?.id]);

  // ---- live deals ----
  useEffect(() => {
    if (!session) {
      setDeals([]);
      return;
    }
    const userId = session.user.id;
    let alive = true;
    const loadRows = async () => {
      try {
        const rows = await listDeals();
        if (alive) setDeals(rows);
      } catch {
        if (alive) fail("Could not load your deals. Check your connection.");
      }
    };
    void loadRows();
    const channel = supabase
      .channel("deals-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "deals" }, (payload) => {
        if (!alive) return;
        if (payload.eventType === "DELETE") {
          const old = payload.old as { id?: string };
          if (old.id) setDeals((prev) => prev.filter((d) => d.id !== old.id));
          return;
        }
        const row = payload.new as DealRow;
        if (payload.eventType === "INSERT" && row.buyer_id === userId) {
          notify(`New deal from ${row.seller_name}: ${row.item}.`);
        }
        setDeals((prev) => {
          const i = prev.findIndex((d) => d.id === row.id);
          if (i === -1) return [row, ...prev];
          const copy = prev.slice();
          copy[i] = row;
          return copy;
        });
      })
      .subscribe();
    const onFocus = () => {
      void loadRows();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      void supabase.removeChannel(channel);
      window.removeEventListener("focus", onFocus);
    };
  }, [session?.user.id]);

  useEffect(() => {
    if (!demo && rate !== null) save(RATE_KEY, { value: rate, at: Date.now() });
  }, [rate, demo]);

  useEffect(() => {
    setCodeConfirmed(false);
    setReleasePin("");
    setBpin("");
    setBpin2("");
  }, [selectedId]);

  useEffect(() => {
    if (!selectedDeal || selectedDeal.buyer_id !== myId || selectedDeal.state !== "invoice_ready" || !selectedDeal.invoice) {
      setQr("");
      return;
    }
    let alive = true;
    QRCode.toDataURL("lightning:" + selectedDeal.invoice.toUpperCase(), { margin: 1, width: 280 })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        if (alive) setQr("");
      });
    return () => {
      alive = false;
    };
  }, [selectedDeal?.id, selectedDeal?.invoice, selectedDeal?.state, myId]);

  useEffect(() => {
    if (!selectedDeal) return;
    if (selectedDeal.state === "released") {
      setNotice(
        selectedDeal.buyer_id === myId
          ? "Done. The seller received the payment."
          : "VALID. Payment received. Tell the driver to release the package now.",
      );
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeal?.state, selectedDeal?.id, myId]);

  // ---- seller automation ----
  useEffect(() => {
    if (!wallet || !profile) return;
    for (const d of deals) {
      if (d.seller_id === profile.id && d.state === "pin_set" && d.hash && !d.invoice && d.demo === demo) {
        void createInvoiceFor(d);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, wallet, profile, demo]);

  useEffect(() => {
    if (!wallet || !profile) return;
    const pending = deals.filter((d) => d.seller_id === profile.id && d.state === "invoice_ready" && d.hash && d.demo === demo);
    if (pending.length === 0) return;
    let stopped = false;
    const check = async () => {
      for (const d of pending) {
        if (stopped) return;
        try {
          const tx = await wallet.lookupInvoice({ payment_hash: d.hash as string });
          if (isLocked(tx)) {
            const saved = await patchDeal(d.id, { state: "locked" }, "invoice_ready");
            if (saved) notify("Payment locked. You can ship the package.");
          } else if (tx?.state === "expired" || tx?.state === "failed") {
            await patchDeal(d.id, { state: "expired" }, "invoice_ready");
          } else if (tx?.state === "canceled" || tx?.state === "cancelled") {
            await patchDeal(d.id, { state: "cancelled" }, "invoice_ready");
          }
        } catch {
          // A temporary wallet or network error: try again on the next tick.
        }
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [deals, wallet, profile, demo]);

  useEffect(() => {
    if (!wallet || !profile) return;
    for (const d of deals) {
      if (d.seller_id === profile.id && d.state === "code_sent" && d.code && d.hash && d.demo === demo) {
        void settle(d);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deals, wallet, profile, demo]);

  // ---- wallet ----
  async function openWallet(url: string): Promise<boolean> {
    let w: HoldWalletLike;
    try {
      const { connectNwc } = await import("./lib/nwcClient.ts");
      w = connectNwc(url);
    } catch {
      fail("Could not load the wallet code. Check your internet and try again.");
      return false;
    }
    try {
      const info = await w.getInfo?.();
      const methods = info?.methods;
      if (Array.isArray(methods)) {
        const needed = ["make_hold_invoice", "settle_hold_invoice", "cancel_hold_invoice", "lookup_invoice"];
        if (!needed.every((m) => methods.includes(m))) {
          w.close?.();
          fail("This wallet connection does not allow hold invoices. Create a connection that allows make_hold_invoice, settle_hold_invoice, cancel_hold_invoice and lookup_invoice.");
          return false;
        }
        setPermission(hasSpendingPower(methods) ? "can-spend" : "ok");
      } else {
        setPermission("unknown");
      }
    } catch {
      setPermission("unknown");
    }
    demoWalletRef.current = null;
    setWallet(w);
    setDemo(false);
    return true;
  }

  async function handleSetup(e: FormEvent) {
    e.preventDefault();
    setError("");
    const parsed = parseNwcUrl(linkText);
    if (!parsed.ok) return fail(parsed.error);
    const pinError = validatePin(pin);
    if (pinError) return fail(pinError);
    if (pin !== pin2) return fail("The two PINs do not match.");
    setBusy(true);
    try {
      if (!(await openWallet(linkText.trim()))) return;
      const v = await seal(linkText.trim(), pin);
      save(`${WALLET_KEY}.${profile?.id ?? "anon"}`, v);
      setVault(v);
      setLinkText("");
      setPin("");
      setPin2("");
      notify("Wallet connected.");
    } catch {
      fail("Could not save or connect. Check the link and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(e: FormEvent) {
    e.preventDefault();
    if (!vault) return;
    setBusy(true);
    try {
      const url = await unseal(vault, pin);
      if (url === null) return fail("Wrong PIN.");
      if (await openWallet(url)) {
        setPin("");
        setError("");
      }
    } finally {
      setBusy(false);
    }
  }

  function startDemo() {
    const seed = deals
      .filter((d) => d.seller_id === myId && d.demo && d.hash)
      .map((d) => ({ hash: d.hash as string, state: demoSeedState(d.state) }));
    const w = createDemoHoldWallet(seed);
    demoWalletRef.current = w;
    setWallet(w);
    setDemo(true);
    setPermission("ok");
    setRate(DEMO_RATE);
    setRateText(formatNairaInput(String(DEMO_RATE)));
    notify("Demo mode: a fake wallet. No real money moves.");
  }

  function lockWallet() {
    wallet?.close?.();
    setWallet(null);
    demoWalletRef.current = null;
    if (demo) {
      setDemo(false);
      const saved = load<{ value: number } | null>(RATE_KEY, null)?.value ?? null;
      setRate(saved);
      setRateText(saved ? formatNairaInput(String(saved)) : "");
    }
  }

  async function forgetWallet() {
    if (!(await askConfirm("Forget this wallet link from this device?", "Yes, forget it"))) return;
    lockWallet();
    try {
      localStorage.removeItem(`${WALLET_KEY}.${profile?.id ?? "anon"}`);
    } catch {
      // ignore
    }
    setVault(null);
  }

  // ---- auth actions ----
  async function handleAuth(e: FormEvent) {
    e.preventDefault();
    setAuthError("");
    if (authMode === "signup") {
      const name = authName.trim();
      const username = authUsername.trim().toLowerCase();
      const email = authEmail.trim();
      const phone = authPhone.trim();
      const digits = phone.replace(/\D/g, "");
      if (name.length < 1 || name.length > 40) return setAuthError("Enter your name (1 to 40 characters).");
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return setAuthError("Username: 3 to 20 letters, numbers or underscores.");
      if (!email.includes("@")) return setAuthError("Enter a valid email.");
      if (phone && (!/^\+?[\d\s-]+$/.test(phone) || digits.length < 7 || digits.length > 15)) {
        return setAuthError("Enter a valid phone number, or leave it empty.");
      }
      if (authPassword.length < 6) return setAuthError("Use a password with at least 6 characters.");
      setAuthBusy(true);
      try {
        const free = await usernameAvailable(username);
        if (!free) {
          setAuthError("That username is taken. Try another.");
          return;
        }
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password: authPassword,
          options: { data: { name, username, phone } },
        });
        if (signUpError) {
          setAuthError(authMessage(signUpError.message));
          return;
        }
        if (!data.session) {
          setAuthMode("login");
          setAuthError("Account created. Check your email to confirm it, then log in. (For the demo, turn Confirm email off in Supabase.)");
          return;
        }
        setAuthName("");
        setAuthUsername("");
        setAuthPhone("");
        setAuthPassword("");
      } catch (err) {
        setAuthError(err instanceof Error ? authMessage(err.message) : "Could not create the account.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }
    const email = authEmail.trim();
    if (!email.includes("@") || authPassword.length < 6) return setAuthError("Enter your email and password.");
    setAuthBusy(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: authPassword });
      if (signInError) setAuthError(authMessage(signInError.message));
      else setAuthPassword("");
    } catch {
      setAuthError("Could not log in. Try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    working.current.clear();
    setDeals([]);
    setSelectedId(null);
    setProfile(null);
    setWallet(null);
    setVault(null);
    setDemo(false);
    demoWalletRef.current = null;
    setNotice("");
    setError("");
  }

  // ---- seller actions ----
  async function createInvoiceFor(d: DealRow) {
    if (!wallet || !d.hash) return;
    const key = "invoice:" + d.id;
    if (working.current.has(key)) return;
    working.current.add(key);
    try {
      const inv = await wallet.makeHoldInvoice({
        amount: d.sats * 1000,
        payment_hash: d.hash,
        description: `ParkPay: ${d.item}`.slice(0, 100),
        expiry: d.hours * 3600,
      });
      const expiresAt =
        typeof inv.expires_at === "number" && Number.isSafeInteger(inv.expires_at) && inv.expires_at > 0
          ? inv.expires_at * 1000
          : expiryTime(Date.now(), d.hours);
      const saved = await patchDeal(d.id, { state: "invoice_ready", invoice: inv.invoice, expires_at: expiresAt }, "pin_set");
      if (saved) notify("Invoice created. Waiting for the buyer to pay.");
      else notify("This deal changed before the invoice was saved.");
    } catch {
      fail("Could not create the invoice. Check your wallet connection and try again.");
    } finally {
      working.current.delete(key);
    }
  }

  async function settle(d: DealRow) {
    if (!wallet || !d.code || !d.hash) return;
    const key = "settle:" + d.id;
    if (working.current.has(key)) return;
    working.current.add(key);
    try {
      const valid = await verifyCode(d.code, d.hash);
      if (!valid) {
        fail("The code did not match. Do not release the package.");
        return;
      }
      const tx = await wallet.lookupInvoice({ payment_hash: d.hash });
      if (isSettled(tx)) {
        await patchDeal(d.id, { state: "released", code: null }, "code_sent");
        notify("VALID. Payment received. Tell the driver to release the package now.");
        return;
      }
      if (!isLocked(tx)) {
        fail("The payment is not locked. Do not release the package.");
        return;
      }
      if (d.expires_at !== null && Date.now() + SAFETY_MARGIN_MS >= d.expires_at) {
        fail("The lock is about to expire. Do not release the package.");
        return;
      }
      await wallet.settleHoldInvoice({ preimage: d.code });
      await patchDeal(d.id, { state: "released", code: null }, "code_sent");
      notify("VALID. Payment received. Tell the driver to release the package now.");
    } catch {
      fail("Could not claim the payment. Keep the package and try again.");
    } finally {
      working.current.delete(key);
    }
  }

  function simulatePayment(d: DealRow) {
    if (!d.hash) return;
    const w = demoWalletRef.current;
    if (!w) return fail("The demo wallet is not loaded. Exit and try demo mode again.");
    w.simulatePayment(d.hash);
    notify("Simulated payment. Waiting for the wallet to report the lock...");
  }

  async function cancelDeal(d: DealRow) {
    const seller = d.seller_id === myId;
    if (!(await askConfirm(seller ? "Cancel this deal? If the buyer's payment is locked, it is returned to the buyer." : "Cancel this deal?", "Yes, cancel the deal"))) return;
    setBusy(true);
    try {
      if (seller && wallet && d.hash && (d.state === "invoice_ready" || d.state === "locked")) {
        try {
          await wallet.cancelHoldInvoice({ payment_hash: d.hash });
        } catch {
          fail("Could not cancel the invoice. Try again.");
          return;
        }
      }
      const allowed = seller ? ["created", "pin_set", "invoice_ready", "locked"] : ["created", "pin_set"];
      const { error: updateError } = await supabase
        .from("deals")
        .update({ state: "cancelled" })
        .eq("id", d.id)
        .in("state", allowed);
      if (updateError) throw updateError;
      notify("Deal cancelled.");
    } catch {
      fail("Could not cancel. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // ---- buyer actions ----
  async function startLock(d: DealRow) {
    const pinError = validatePin(bpin);
    if (pinError) return fail(pinError);
    if (bpin !== bpin2) return fail("The two PINs do not match.");
    if (!myId) return fail("Log in again.");
    setBusy(true);
    try {
      const secret = await generateSecret();
      const v = await seal(secret.code, bpin);
      await saveSecret(d.id, myId, v);
      const saved = await patchDeal(d.id, { hash: secret.hash, state: "pin_set" }, "created");
      if (!saved) return fail("This deal changed. Refresh and try again.");
      setBpin("");
      setBpin2("");
      notify("PIN set. Waiting for the seller to create the invoice.");
    } catch {
      fail("Could not lock your payment. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function releaseCode(d: DealRow) {
    if (!codeConfirmed) return fail("Tick the box first.");
    const pinError = validatePin(releasePin);
    if (pinError) return fail(pinError);
    if (!(await askConfirm("Only send the code when the package is in your hands and you are on the phone with the seller. Send it now?", "Yes, send the code"))) return;
    setBusy(true);
    try {
      const stored = await loadSecret(d.id);
      if (!stored) return fail("No code found for this deal on your account.");
      const code = await unseal(stored, releasePin);
      if (code === null) return fail("Wrong PIN.");
      const saved = await patchDeal(d.id, { code, state: "code_sent" }, "locked");
      if (!saved) return fail("This deal changed. Refresh and try again.");
      setReleasePin("");
      setCodeConfirmed(false);
      notify("Code sent. The seller can now claim the payment.");
    } catch {
      fail("Could not send your code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // ---- sale form ----
  function useRate() {
    const value = parseRate(rateText);
    if (value === null) return fail("Enter the rate as a number, for example 150,000,000.");
    setRate(value);
    setRateText(formatNairaInput(String(value)));
    setError("");
  }

  async function fetchRate() {
    try {
      setRate(await fetchNgnPerBtc());
      setError("");
    } catch {
      fail("Could not fetch the rate. Type it in instead.");
    }
  }

  async function createSale(e: FormEvent) {
    e.preventDefault();
    if (!profile) return;
    const wanted = buyerUsername.trim().toLowerCase().replace(/^@/, "");
    const item = itemText.trim();
    const driverName = driverNameText.trim();
    const driverPhone = driverPhoneText.trim();
    const phoneDigits = driverPhone.replace(/\D/g, "");
    const kobo = parseNairaToKobo(priceText);
    const hours = Number(hoursText);
    if (!/^[a-z0-9_]{3,20}$/.test(wanted)) return fail("Enter the buyer's username, for example @ada.");
    if (item.length < 1 || item.length > 80) return fail("Describe the item in 1 to 80 characters.");
    if (driverName.length < 1 || driverName.length > 40) return fail("Enter the driver's name (1 to 40 characters).");
    if (!/^\+?[\d\s-]+$/.test(driverPhone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
      return fail("Enter the driver's phone number (7 to 15 digits).");
    }
    if (kobo === null) return fail("Enter the price in naira, for example 25,000.");
    if (rate === null) return fail("Set today's rate first.");
    const sats = koboToSats(kobo, rate);
    if (sats === null || sats > MAX_SATS) return fail("This price is too large or could not be converted.");
    if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) return fail(`Lock time must be ${MIN_HOURS} to ${MAX_HOURS} hours.`);
    setBusy(true);
    try {
      const buyer = await findProfileByUsername(wanted);
      if (!buyer) return fail("No user with that username. Ask them to sign up first.");
      if (buyer.id === profile.id) return fail("Use another account as the buyer.");
      const row = await createDeal({
        seller_id: profile.id,
        buyer_id: buyer.id,
        seller_username: profile.username,
        buyer_username: buyer.username,
        seller_name: profile.name,
        buyer_name: buyer.name,
        item,
        amount_kobo: kobo,
        sats,
        ngn_per_btc: Math.round(rate),
        driver_name: driverName,
        driver_phone: driverPhone,
        hours,
        demo,
      });
      setSelectedId(row.id);
      setBuyerUsername("");
      setItemText("");
      setPriceText("");
      setDriverNameText("");
      setDriverPhoneText("");
      notify(`Deal sent to @${buyer.username}.`);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Could not create the sale. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    if (!navigator.clipboard) return fail("Could not copy. Select the text and copy it yourself.");
    navigator.clipboard.writeText(text).then(
      () => notify("Copied."),
      () => fail("Could not copy. Select the text and copy it yourself."),
    );
  }

  function openDeal(id: string) {
    setSelectedId(id);
    setNotice("");
    setError("");
  }

  function closeDeal() {
    setSelectedId(null);
    setQr("");
    setNotice("");
    setError("");
  }

  // ---- screens ----
  function dealListCard(title: string, rows: DealRow[], empty: string) {
    return (
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Escrow</p>
            <h2>{title}</h2>
          </div>
          <span className="count">{rows.length}</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <EmptyIcon />
            <p className="small">{empty}</p>
          </div>
        ) : (
          <ul className="deal-list">
            {rows.map((d) => {
              const otherName = d.seller_id === myId ? d.buyer_name : d.seller_name;
              const otherUsername = d.seller_id === myId ? d.buyer_username : d.seller_username;
              return (
                <li key={d.id}>
                  <button className="deal-card" onClick={() => openDeal(d.id)}>
                    <span className="deal-avatar">{initials(otherName)}</span>
                    <span className="deal-body">
                      <span className="deal-title">{d.item}</span>
                      <span className="deal-meta">
                        @{otherUsername} · {formatNaira(d.amount_kobo)}
                      </span>
                    </span>
                    <span className={`pill ${d.state}`}>{STATE_LABEL[d.state]}</span>
                    <span className="deal-arrow" aria-hidden="true">›</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  function walletCard() {
    if (wallet) {
      return (
        <div className="wallet-state">
          <div className="wallet-line">
            <span className="status-dot" aria-hidden="true" />
            <strong>{demo ? "Demo wallet" : "Wallet connected"}</strong>
            {demo && <span className="pill demo">DEMO: no real money</span>}
          </div>
          {permission === "can-spend" && !demo && (
            <p className="warn small">This connection can also send money. For safety, use a connection that can only receive and manage hold invoices.</p>
          )}
          <div className="button-row">
            <button className="secondary smallbtn" onClick={lockWallet}>{demo ? "Exit demo" : "Lock wallet"}</button>
            {!demo && <button className="ghost smallbtn" onClick={forgetWallet}>Forget wallet</button>}
          </div>
        </div>
      );
    }
    if (vault) {
      return (
        <form className="wallet-state" onSubmit={handleUnlock}>
          <p className="small">Unlock your wallet to create invoices.</p>
          <label htmlFor="unlock">PIN</label>
          <input id="unlock" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
          <div className="button-row">
            <button type="submit" disabled={busy}>Unlock</button>
            <button type="button" className="secondary" onClick={startDemo}>Demo mode</button>
            <button type="button" className="ghost" onClick={forgetWallet}>Forget wallet</button>
          </div>
        </form>
      );
    }
    return (
      <form className="stack" onSubmit={handleSetup}>
        <p className="small">Buyers do not need a wallet connection. Sellers do. The link is encrypted on this device with your PIN.</p>
        <label htmlFor="link">Wallet connection link</label>
        <input id="link" type="password" autoComplete="off" value={linkText} onChange={(e) => setLinkText(e.target.value)} />
        <label htmlFor="pin">Choose a PIN (6 to 12 digits)</label>
        <input id="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
        <label htmlFor="pin2">Repeat the PIN</label>
        <input id="pin2" type="password" inputMode="numeric" autoComplete="off" value={pin2} onChange={(e) => setPin2(e.target.value)} />
        <div className="button-row">
          <button type="submit" disabled={busy}>Save and connect</button>
          <button type="button" className="secondary" onClick={startDemo}>Try demo mode</button>
        </div>
      </form>
    );
  }

  function newSaleForm() {
    return (
      <form className="sale-form" onSubmit={createSale}>
        <div className="rate-card">
          <div>
            <p className="eyebrow">Today's rate</p>
            <p className="rate-value">{rate === null ? "Rate not set" : `1 BTC = ${formatNaira(Math.round(rate * 100))}`}</p>
          </div>
          <button type="button" className="secondary smallbtn" onClick={fetchRate} disabled={demo}>Fetch rate</button>
        </div>
        {rate !== null && !isRatePlausible(rate) && <p className="error">This rate looks unusual. Check it.</p>}
        <label htmlFor="rate">Naira per 1 BTC</label>
        <div className="inline-field">
          <input id="rate" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          <button type="button" className="secondary" onClick={useRate}>Use this rate</button>
        </div>
        <label htmlFor="buyer">Buyer's username</label>
        <input
          id="buyer"
          maxLength={21}
          autoCapitalize="none"
          placeholder="@ada"
          value={buyerUsername}
          onChange={(e) => setBuyerUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_@]/g, ""))}
        />
        <label htmlFor="item">Item</label>
        <input id="item" maxLength={80} value={itemText} onChange={(e) => setItemText(e.target.value)} />
        <label htmlFor="price">Price (naira)</label>
        <input id="price" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(formatNairaInput(e.target.value))} />
        <div className="field-row">
          <div>
            <label htmlFor="drivername">Driver name</label>
            <input id="drivername" maxLength={40} value={driverNameText} onChange={(e) => setDriverNameText(e.target.value)} />
          </div>
          <div>
            <label htmlFor="driverphone">Driver phone</label>
            <input id="driverphone" type="tel" inputMode="tel" maxLength={20} value={driverPhoneText} onChange={(e) => setDriverPhoneText(e.target.value)} />
          </div>
        </div>
        <label htmlFor="hours">Lock time in hours ({MIN_HOURS} to {MAX_HOURS})</label>
        <input id="hours" inputMode="numeric" value={hoursText} onChange={(e) => setHoursText(e.target.value)} />
        <button type="submit" className="wide" disabled={busy}>Send deal to buyer</button>
        <p className="form-note">The buyer pays from any Lightning wallet. The rate only converts naira to sats.</p>
      </form>
    );
  }

  function dealHeader(d: DealRow, role: "seller" | "buyer") {
    return (
      <div className="deal-hero">
        <div className="deal-hero-top">
          <p className="eyebrow">{role === "seller" ? "Sale" : "Purchase"} · deal {shortId(d.id)}</p>
          <div className="deal-hero-pills">
            {d.demo && <span className="pill demo">Demo</span>}
            <span className={`pill ${d.state}`}>{STATE_LABEL[d.state]}</span>
          </div>
        </div>
        <h1>{d.item}</h1>
        <p className="deal-amount">
          {formatSats(d.sats)} <span>· about {formatNaira(d.amount_kobo)}</span>
        </p>
        <div className="deal-facts">
          <span>{role === "seller" ? `Buyer: ${d.buyer_name} @${d.buyer_username}` : `Seller: ${d.seller_name} @${d.seller_username}`}</span>
          <span>Driver: {d.driver_name} · {d.driver_phone}</span>
          <span>Lock time: {d.hours} hours</span>
        </div>
      </div>
    );
  }

  function tracker(state: DealState) {
    if (state === "cancelled" || state === "expired") {
      return <p className="warn small">{state === "cancelled" ? "This deal was cancelled." : "This deal expired."}</p>;
    }
    const step = STATE_STEP[state];
    return (
      <ol className="stepper">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step ? "done" : i === step ? "done now" : ""}>
            <span className="dot">{i < step ? "✓" : i + 1}</span>
            <span className="step-label">{label}</span>
          </li>
        ))}
      </ol>
    );
  }

  function termsPanel(d: DealRow, role: "seller" | "buyer") {
    const otherName = role === "seller" ? d.buyer_name : d.seller_name;
    const otherUsername = role === "seller" ? d.buyer_username : d.seller_username;
    return (
      <aside className="panel terms-panel">
        <div className="panel-head">
          <h2>Deal terms</h2>
        </div>
        <dl className="terms">
          <div>
            <dt>{role === "seller" ? "Buyer" : "Seller"}</dt>
            <dd>
              {otherName}
              <span>@{otherUsername}</span>
            </dd>
          </div>
          <div>
            <dt>Driver</dt>
            <dd>
              {d.driver_name}
              <span>{d.driver_phone}</span>
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              {formatSats(d.sats)}
              <span>{formatNaira(d.amount_kobo)}</span>
            </dd>
          </div>
          <div>
            <dt>Lock time</dt>
            <dd>
              {d.hours} hours
              <span>Deal {shortId(d.id)}</span>
            </dd>
          </div>
        </dl>
        {d.demo && <p className="warn small">Demo deal: the invoice is fake. No real money moves.</p>}
      </aside>
    );
  }

  function sellerView(d: DealRow) {
    return (
      <>
        <section className="panel action-panel">
          <div className="panel-head">
            <h2>What happens next</h2>
          </div>
          {d.state === "created" && (
            <>
              <p>Waiting for @{d.buyer_username} to set a PIN. They will see this deal on their dashboard.</p>
              <p className="waiting">
                <span className="pulse" aria-hidden="true" />
                The deal opens as soon as they choose a PIN.
              </p>
            </>
          )}
          {d.state === "pin_set" && (
            <>
              <p className="ok">@{d.buyer_username} set a PIN.</p>
              {d.demo !== demo ? (
                <p className="warn">{d.demo ? "This is a demo deal. Use demo mode to continue it." : "This is a real deal. Connect your wallet to continue it."}</p>
              ) : wallet ? (
                <p className="waiting">
                  <span className="pulse" aria-hidden="true" />
                  Creating the invoice...
                </p>
              ) : (
                <p className="warn">Go back and connect your wallet in "Sell something" to create the invoice.</p>
              )}
              {wallet && d.demo === demo && (
                <button className="secondary" onClick={() => createInvoiceFor(d)} disabled={busy}>Create invoice again</button>
              )}
            </>
          )}
          {d.state === "invoice_ready" && d.invoice && (
            <>
              <p>Invoice sent to @{d.buyer_username}. Waiting for payment.</p>
              <p className="waiting">
                <span className="pulse" aria-hidden="true" />
                The wallet is watching for the lock.
              </p>
              {d.demo && (
                <button className="demo-action" onClick={() => simulatePayment(d)} disabled={busy}>Simulate buyer payment (demo only)</button>
              )}
            </>
          )}
          {d.state === "locked" && (
            <div className="success-block">
              <p className="ok">Payment locked. You can ship the package.</p>
              <p className="small">When the package arrives, the buyer releases the code here. This page claims the payment automatically. Do not release the package before it says VALID.</p>
            </div>
          )}
          {d.state === "code_sent" && (
            <>
              <p className="waiting">
                <span className="pulse" aria-hidden="true" />
                Code received. Claiming the payment...
              </p>
              <p className="small">Keep the package until this screen says the payment is received.</p>
              <button className="secondary" onClick={() => settle(d)} disabled={busy}>Try to claim again</button>
            </>
          )}
          {d.state === "released" && (
            <div className="success-block">
              <p className="ok">VALID. Payment received. Tell the driver to release the package now.</p>
              <p className="small">The money is in your wallet. This deal is complete.</p>
            </div>
          )}
          {d.state === "cancelled" && <p>This deal was cancelled. Any locked payment went back to the buyer.</p>}
          {d.state === "expired" && <p>This deal expired. Any locked payment went back to the buyer.</p>}
          {!isFinal(d.state) && (
            <div className="button-row">
              <button className="danger" onClick={() => cancelDeal(d)} disabled={busy}>Cancel deal</button>
            </div>
          )}
        </section>
        {termsPanel(d, "seller")}
      </>
    );
  }

  function buyerView(d: DealRow) {
    return (
      <>
        <section className="panel action-panel">
          <div className="panel-head">
            <h2>
              {d.state === "created"
                ? "Protect your payment"
                : d.state === "invoice_ready"
                  ? "Pay the invoice"
                  : d.state === "locked"
                    ? "Release your code"
                    : "What happens next"}
            </h2>
          </div>
          {d.state === "created" && (
            <>
              <p className="small">Your money stays locked in the seller's wallet until you send your code. If the package never arrives, the lock expires and the money returns to you. Choose a PIN to protect your code.</p>
              <label htmlFor="bpin">PIN (6 to 12 digits)</label>
              <input id="bpin" type="password" inputMode="numeric" autoComplete="off" value={bpin} onChange={(e) => setBpin(e.target.value)} />
              <label htmlFor="bpin2">Repeat the PIN</label>
              <input id="bpin2" type="password" inputMode="numeric" autoComplete="off" value={bpin2} onChange={(e) => setBpin2(e.target.value)} />
              <div className="button-row">
                <button onClick={() => startLock(d)} disabled={busy}>Set PIN and lock payment</button>
                <button className="secondary" onClick={() => cancelDeal(d)} disabled={busy}>Cancel</button>
              </div>
            </>
          )}
          {d.state === "pin_set" && (
            <>
              <p className="waiting">
                <span className="pulse" aria-hidden="true" />
                PIN set. Waiting for the seller to create the invoice...
              </p>
              <p className="small">You can cancel this deal until you pay.</p>
              <button className="secondary" onClick={() => cancelDeal(d)} disabled={busy}>Cancel</button>
            </>
          )}
          {d.state === "invoice_ready" && d.invoice && (
            <>
              {d.invoice.startsWith("lnbcDEMO") && <p className="warn">This is a DEMO invoice. Do not pay it.</p>}
              <div className="ticket">
                <p className="eyebrow">Lightning invoice</p>
                <p className="ticket-amount">{formatNaira(d.amount_kobo)}</p>
                {qr && <img className="qr" src={qr} alt="Lightning invoice QR code" width={280} height={280} />}
                <p className="small">Pay this invoice with any Lightning wallet. The money stays locked until you send your code.</p>
                <div className="button-row">
                  <button className="secondary" onClick={() => copy(d.invoice as string)}>Copy invoice</button>
                  <a className="btn" href={`lightning:${d.invoice}`}>Open in wallet</a>
                </div>
              </div>
            </>
          )}
          {d.state === "locked" && (
            <>
              <div className="success-block">
                <p className="ok">Payment locked. The seller can now ship the package.</p>
                <p className="small">Do not send your code before the package is in your hands. The code is like cash.</p>
              </div>
              <label className="check" htmlFor="codeok">
                <input id="codeok" type="checkbox" checked={codeConfirmed} onChange={(e) => setCodeConfirmed(e.target.checked)} />
                <span>The package is in my hands and I am on the phone with the seller.</span>
              </label>
              <label htmlFor="rpin">Your PIN</label>
              <input id="rpin" type="password" inputMode="numeric" autoComplete="off" value={releasePin} onChange={(e) => setReleasePin(e.target.value)} />
              <button className="wide" onClick={() => releaseCode(d)} disabled={busy || !codeConfirmed}>Release my code</button>
            </>
          )}
          {d.state === "code_sent" && (
            <>
              <p className="waiting">
                <span className="pulse" aria-hidden="true" />
                Code sent. The seller is claiming the payment.
              </p>
              <p className="small">Keep the package with you until this screen says completed.</p>
            </>
          )}
          {d.state === "released" && (
            <div className="success-block">
              <p className="ok">Done. The seller received the payment.</p>
              <p className="small">This deal is complete. Thank you for trading safely.</p>
            </div>
          )}
          {d.state === "cancelled" && <p>This deal was cancelled. Any locked money returned to you.</p>}
          {d.state === "expired" && <p>This deal expired. Any locked money returned to you.</p>}
        </section>
        {termsPanel(d, "buyer")}
      </>
    );
  }

  if (!supabaseReady) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand"><Mark /><Wordmark /></div>
        </header>
        <main className="page narrow">
          <div className="page-head">
            <div>
              <p className="eyebrow">Setup</p>
              <h1>Connect Supabase</h1>
              <p className="lead">The app needs a database before accounts and deals can work.</p>
            </div>
          </div>
          <div className="panel">
            <p className="small">Create a file called <code>.env.local</code> in the project folder with these two lines, then restart the dev server:</p>
            <pre className="envbox">{`VITE_SUPABASE_URL=https://your-project.supabase.co\nVITE_SUPABASE_ANON_KEY=your-anon-public-key`}</pre>
            <p className="small">Never use the service_role key in this app.</p>
          </div>
        </main>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand"><Mark /><Wordmark /></div>
        </header>
        <main className="page narrow">
          <div className="page-head">
            <div>
              <p className="eyebrow">ParkPay</p>
              <h1>Opening your market...</h1>
            </div>
          </div>
          <p className="waiting">
            <span className="pulse" aria-hidden="true" />
            Loading your session.
          </p>
        </main>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth">
        <aside className="auth-brand">
          <div className="brand"><Mark /><Wordmark /></div>
          <div className="auth-copy">
            <p className="eyebrow">Pay on delivery, the safe way</p>
            <h1>Trust the market, <em>not the middleman.</em></h1>
            <p className="lead">The buyer's money waits in a Lightning lock until the package is in their hands. No shop, no stranger, no leap of faith.</p>
            <ul className="trust-list">
              <li><IconLock />Money stays locked until the buyer sends their secret code.</li>
              <li><IconShield />If the package never arrives, the lock expires and the money returns.</li>
              <li><IconBolt />Lightning settles in seconds, with fees too small to matter.</li>
            </ul>
          </div>
          <p className="auth-foot">Built for open markets across Nigeria. No card, no bank visit, no middleman.</p>
        </aside>
        <div className="auth-panel">
          <div className="auth-card">
            <div className="auth-head">
              <p className="eyebrow">Your account</p>
              <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
              <p className="small">Pay on delivery with money that only moves when both sides agree.</p>
            </div>
            <form onSubmit={handleAuth}>
              <div className="tabs">
                <button type="button" className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>Log in</button>
                <button type="button" className={authMode === "signup" ? "active" : ""} onClick={() => { setAuthMode("signup"); setAuthError(""); }}>Sign up</button>
              </div>
              {authMode === "signup" && (
                <>
                  <label htmlFor="aname">Your name</label>
                  <input id="aname" maxLength={40} value={authName} onChange={(e) => setAuthName(e.target.value)} />
                  <label htmlFor="auser">Username (3 to 20 letters, numbers or _)</label>
                  <input id="auser" maxLength={20} autoCapitalize="none" value={authUsername} onChange={(e) => setAuthUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
                  <label htmlFor="aphone">Phone (optional)</label>
                  <input id="aphone" type="tel" inputMode="tel" maxLength={20} value={authPhone} onChange={(e) => setAuthPhone(e.target.value)} />
                </>
              )}
              <label htmlFor="aemail">Email</label>
              <input id="aemail" type="email" autoComplete="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
              <label htmlFor="apass">Password</label>
              <input id="apass" type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} />
              <button type="submit" disabled={authBusy}>{authBusy ? "Working..." : authMode === "login" ? "Log in" : "Create account"}</button>
              {authError && <p className="error" role="alert">{authError}</p>}
            </form>
            <p className="auth-tip">Demo tip: create two accounts to try both sides. A seller connects a wallet or uses demo mode; a buyer does not need a wallet.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand"><Mark /><Wordmark /></div>
        </header>
        <main className="page narrow">
          <div className="page-head">
            <div>
              <p className="eyebrow">Almost there</p>
              <h1>Setting up your account...</h1>
              <p className="lead">If this stays here, refresh the page. If it still fails, check that the SQL schema was run.</p>
            </div>
          </div>
          <div className="button-row">
            <button onClick={() => window.location.reload()}>Refresh</button>
            <button className="secondary" onClick={logout}>Log out</button>
          </div>
        </main>
      </div>
    );
  }

  const buyerDeals = deals.filter((d) => d.buyer_id === myId);
  const sellerDeals = deals.filter((d) => d.seller_id === myId);
  const activeDeals = deals.filter((d) => !isFinal(d.state));
  const lockedDeals = deals.filter((d) => d.state === "locked" || d.state === "code_sent");
  const lockedKobo = lockedDeals.reduce((sum, d) => sum + d.amount_kobo, 0);
  const completedDeals = deals.filter((d) => d.state === "released");
  const firstName = profile.name.split(/\s+/)[0] || profile.name;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Mark /><Wordmark /></div>
        <div className="topbar-right">
          <div className="user-chip">
            <span className="avatar">{initials(profile.name)}</span>
            <span className="user-text">
              <strong>{profile.name}</strong>
              <span>@{profile.username}</span>
            </span>
          </div>
          <button className="ghost smallbtn" onClick={logout}>Log out</button>
        </div>
      </header>
      <main className="page">
        {(busy || notice || error) && (
          <div className="toast-layer">
            {error ? (
              <div className="toast toast-error" role="alert">
                <span>{error}</span>
                <button className="smallbtn" onClick={() => setError("")}>OK</button>
              </div>
            ) : busy ? (
              <div className="toast toast-busy" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>Working. This can take a few seconds.</span>
              </div>
            ) : (
              <div className="toast toast-ok" role="status" onClick={() => setNotice("")}>
                <span>{notice}</span>
              </div>
            )}
          </div>
        )}
        {confirmDlg && (
          <div className="modal-backdrop" role="presentation" onClick={() => closeConfirm(false)}>
            <div className="modal" role="alertdialog" aria-modal="true" aria-label="Please confirm" onClick={(e) => e.stopPropagation()}>
              <p>{confirmDlg.text}</p>
              <div className="modal-actions">
                <button className="ghost" autoFocus onClick={() => closeConfirm(false)}>Go back</button>
                <button onClick={() => closeConfirm(true)}>{confirmDlg.yes}</button>
              </div>
            </div>
          </div>
        )}
        {selectedDeal ? (
          <div className="deal-view">
            <button className="ghost back" onClick={closeDeal}>← Back</button>
            {dealHeader(selectedDeal, selectedDeal.seller_id === myId ? "seller" : "buyer")}
            {tracker(selectedDeal.state)}
            <div className="deal-grid">
              {selectedDeal.seller_id === myId ? sellerView(selectedDeal) : buyerView(selectedDeal)}
            </div>
          </div>
        ) : (
          <>
            <div className="page-head">
              <div>
                <p className="eyebrow">Dashboard</p>
                <h1>Welcome back, {firstName}.</h1>
                <p className="small signed">Signed in as {profile.name} · @{profile.username}</p>
              </div>
              <span className="pill locked">Live escrow</span>
            </div>
            <section className="stats" aria-label="Your escrow at a glance">
              <div className="stat">
                <p className="stat-label">Active deals</p>
                <p className="stat-value">{activeDeals.length}</p>
                <p className="stat-sub">
                  {activeDeals.length === 0 ? "Nothing in motion" : activeDeals.length === 1 ? "One deal in motion" : `${activeDeals.length} deals in motion`}
                </p>
              </div>
              <div className="stat">
                <p className="stat-label">Locked value</p>
                <p className="stat-value">{formatNaira(lockedKobo)}</p>
                <p className="stat-sub">
                  {lockedDeals.length === 0 ? "No money locked" : lockedDeals.length === 1 ? "One payment locked" : `${lockedDeals.length} payments locked`}
                </p>
              </div>
              <div className="stat">
                <p className="stat-label">Completed</p>
                <p className="stat-value">{completedDeals.length}</p>
                <p className="stat-sub">
                  {completedDeals.length === 0 ? "No payouts yet" : completedDeals.length === 1 ? "One payout" : `${completedDeals.length} payouts`}
                </p>
              </div>
            </section>
            <div className="dash-grid">
              <div className="dash-main">
                {dealListCard("Deals for you", buyerDeals, `When a seller creates a deal for @${profile.username}, it appears here automatically.`)}
                {dealListCard("Your sales", sellerDeals, "No sales yet. Start one from the sale form.")}
              </div>
              <aside className="dash-side">
                <section className="panel sell-panel">
                  <div className="panel-head">
                    <div>
                      <p className="eyebrow">Seller tools</p>
                      <h2>Sell something</h2>
                    </div>
                  </div>
                  {walletCard()}
                  {wallet && newSaleForm()}
                </section>
              </aside>
            </div>
            <footer className="foot">
              <span>ParkPay</span>
              <span>Hold invoices on Lightning. Your wallet, your keys.</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
