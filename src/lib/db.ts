// All Supabase reads and writes live here. Row-level security limits every
// query to the signed-in user's own deals.

import { supabase } from "./supabase.ts";
import type { DealRow, DealState, Profile } from "./live.ts";
import type { Vault } from "./vault.ts";

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, name, phone, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export async function findProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, name")
    .eq("username", username.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export async function usernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("username_available", {
    want: username.trim().toLowerCase(),
  });
  if (error) throw error;
  return Boolean(data);
}

export async function listDeals(): Promise<DealRow[]> {
  const { data, error } = await supabase
    .from("deals")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DealRow[];
}

export type NewDeal = {
  seller_id: string;
  buyer_id: string;
  seller_username: string;
  buyer_username: string;
  seller_name: string;
  buyer_name: string;
  item: string;
  amount_kobo: number;
  sats: number;
  ngn_per_btc: number;
  driver_name: string;
  driver_phone: string;
  hours: number;
  demo: boolean;
};

export async function createDeal(input: NewDeal): Promise<DealRow> {
  const { data, error } = await supabase.from("deals").insert(input).select("*").single();
  if (error) throw error;
  return data as DealRow;
}

export type DealPatch = Partial<Pick<DealRow, "state" | "hash" | "invoice" | "expires_at" | "code">>;

export async function patchDeal(
  id: string,
  patch: DealPatch,
  expectState?: DealState,
): Promise<DealRow | null> {
  const base = supabase.from("deals").update(patch).eq("id", id);
  const query = expectState ? base.eq("state", expectState) : base;
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error;
  return (data as DealRow | null) ?? null;
}

export async function saveSecret(dealId: string, buyerId: string, vault: Vault): Promise<void> {
  const { error } = await supabase
    .from("deal_secrets")
    .upsert({ deal_id: dealId, buyer_id: buyerId, vault }, { onConflict: "deal_id" });
  if (error) throw error;
}

export async function loadSecret(dealId: string): Promise<Vault | null> {
  const { data, error } = await supabase
    .from("deal_secrets")
    .select("vault")
    .eq("deal_id", dealId)
    .maybeSingle();
  if (error) throw error;
  return (data?.vault as Vault | undefined) ?? null;
}
