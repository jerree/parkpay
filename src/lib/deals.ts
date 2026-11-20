// A deal as stored on one phone. The seller and the buyer each keep their own copy.

import { newDealId, nextState } from "./escrow.ts";
import type { DealEvent, DealState } from "./escrow.ts";
import type { Vault } from "./vault.ts";

export type Role = "seller" | "buyer";

export type Deal = {
  key: string; // role + id, so one browser can hold both sides while demoing
  id: string;
  role: Role;
  createdAt: number;
  item: string;
  sats: number;
  driver: string;
  hours: number;
  state: DealState;
  hash?: string; // the fingerprint of the buyer's secret code
  invoice?: string;
  expiresAt?: number;
  vault?: Vault; // buyer only: the secret code, encrypted with the buyer's PIN
  demo: boolean;
};

export function dealKey(role: Role, id: string): string {
  return `${role}:${id}`;
}

export function applyEvent(deal: Deal, event: DealEvent): Deal | null {
  const next = nextState(deal.state, event);
  return next === null ? null : { ...deal, state: next };
}

export function upsert(list: Deal[], deal: Deal): Deal[] {
  const i = list.findIndex((d) => d.key === deal.key);
  if (i === -1) return [deal, ...list];
  const copy = list.slice();
  copy[i] = deal;
  return copy;
}

export function newSellerDeal(args: { item: string; sats: number; driver: string; hours: number; demo: boolean; now: number }): Deal {
  const id = newDealId();
  return {
    key: dealKey("seller", id),
    id,
    role: "seller",
    createdAt: args.now,
    item: args.item,
    sats: args.sats,
    driver: args.driver,
    hours: args.hours,
    state: "created",
    demo: args.demo,
  };
}

export function buyerDealFromTerms(
  terms: { id: string; item: string; sats: number; driver: string; hours: number },
  now: number,
): Deal {
  return {
    key: dealKey("buyer", terms.id),
    id: terms.id,
    role: "buyer",
    createdAt: now,
    item: terms.item,
    sats: terms.sats,
    driver: terms.driver,
    hours: terms.hours,
    state: "created",
    demo: false,
  };
}
