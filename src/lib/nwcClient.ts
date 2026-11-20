// The only file that imports the Alby SDK. Everything else is SDK-free.
// @getalby/sdk v9 exports NWCClient from the ./nwc subpath, not from the root.
import { NWCClient } from "@getalby/sdk/nwc";
import type { HoldWalletLike } from "./holdWallet.ts";

export function connectNwc(nostrWalletConnectUrl: string): HoldWalletLike {
  const client = new NWCClient({ nostrWalletConnectUrl });
  return client as unknown as HoldWalletLike;
}
