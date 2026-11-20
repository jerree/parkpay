// Validates a Nostr Wallet Connect link. The returned info NEVER contains the secret.

export type NwcInfo = { pubkey: string; relays: string[] };
export type NwcParse = { ok: true; info: NwcInfo } | { ok: false; error: string };

const HEX64 = /^[0-9a-f]{64}$/i;

export function parseNwcUrl(raw: string): NwcParse {
  const text = raw.trim();
  if (!/^nostr\+?walletconnect:/i.test(text)) {
    return { ok: false, error: "This is not a Nostr Wallet Connect link. It should start with nostr+walletconnect://" };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "The link could not be read." };
  }
  const pubkey = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (!HEX64.test(pubkey)) return { ok: false, error: "The wallet key in the link looks wrong." };

  const relays = url.searchParams.getAll("relay");
  if (relays.length === 0) return { ok: false, error: "The link has no relay." };
  if (!relays.every((r) => /^wss:\/\/\S+$/i.test(r))) {
    return { ok: false, error: "Relays must use wss://" };
  }
  const secret = url.searchParams.get("secret") ?? "";
  if (!HEX64.test(secret)) return { ok: false, error: "The link has no valid secret." };

  return { ok: true, info: { pubkey, relays } };
}
