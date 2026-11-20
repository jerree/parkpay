// Shapes shared by the app and the Supabase tables.

export type DealState =
  | "created"
  | "pin_set"
  | "invoice_ready"
  | "locked"
  | "code_sent"
  | "released"
  | "cancelled"
  | "expired";

export type Profile = {
  id: string;
  username: string;
  name: string;
  phone: string | null;
  created_at?: string;
};

export type DealRow = {
  id: string;
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
  state: DealState;
  hash: string | null;
  invoice: string | null;
  expires_at: number | null;
  code: string | null;
  demo: boolean;
  created_at: string;
  updated_at: string;
};

export const STATE_LABEL: Record<DealState, string> = {
  created: "Started",
  pin_set: "PIN set",
  invoice_ready: "Waiting for payment",
  locked: "Payment locked",
  code_sent: "Code sent",
  released: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const STATE_STEP: Record<DealState, number> = {
  created: 0,
  pin_set: 1,
  invoice_ready: 2,
  locked: 3,
  code_sent: 4,
  released: 5,
  cancelled: -1,
  expired: -1,
};

export const STEPS = ["Deal", "PIN", "Invoice", "Locked", "Code", "Paid"];

export function isFinal(state: DealState): boolean {
  return state === "released" || state === "cancelled" || state === "expired";
}

// Maps the live states onto the states the demo wallet understands.
export function demoSeedState(state: DealState): "created" | "invoice_ready" | "locked" | "released" | "cancelled" | "expired" {
  if (state === "pin_set") return "created";
  if (state === "code_sent") return "locked";
  if (state === "invoice_ready") return "invoice_ready";
  if (state === "locked") return "locked";
  if (state === "released") return "released";
  if (state === "cancelled") return "cancelled";
  if (state === "expired") return "expired";
  return "created";
}
