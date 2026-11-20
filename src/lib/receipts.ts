// Receipt log. Stores only amount, time, a short note and the payment hash. No customer data.

export type ReceiptStatus = "pending" | "paid" | "expired";

export type Receipt = {
  id: string; // the payment hash
  createdAt: number;
  paidAt?: number;
  amountKobo: number;
  sats: number;
  ngnPerBtc: number;
  note: string;
  status: ReceiptStatus;
  demo: boolean;
};

export function cleanNote(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
}

export function newReceipt(args: {
  id: string;
  now: number;
  amountKobo: number;
  sats: number;
  ngnPerBtc: number;
  note: string;
  demo: boolean;
}): Receipt {
  return {
    id: args.id,
    createdAt: args.now,
    amountKobo: args.amountKobo,
    sats: args.sats,
    ngnPerBtc: args.ngnPerBtc,
    note: cleanNote(args.note),
    status: "pending",
    demo: args.demo,
  };
}

export function markPaid(list: Receipt[], id: string, now: number): Receipt[] {
  return list.map((r) => (r.id === id && r.status === "pending" ? { ...r, status: "paid", paidAt: now } : r));
}

export function markExpired(list: Receipt[], id: string): Receipt[] {
  return list.map((r) => (r.id === id && r.status === "pending" ? { ...r, status: "expired" } : r));
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Only real (non-demo) paid receipts count toward totals.
export function totalsForDay(list: Receipt[], dayStart: number): { count: number; kobo: number; sats: number } {
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  let count = 0;
  let kobo = 0;
  let sats = 0;
  for (const r of list) {
    if (r.status === "paid" && !r.demo && (r.paidAt ?? 0) >= dayStart && (r.paidAt ?? 0) < dayEnd) {
      count += 1;
      kobo += r.amountKobo;
      sats += r.sats;
    }
  }
  return { count, kobo, sats };
}

// Spreadsheet programs run cells that start with = + - or @, so those get a leading apostrophe.
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(list: Receipt[]): string {
  const header = ["id", "created", "paid", "amount_ngn", "sats", "ngn_per_btc", "status", "mode", "note"];
  const rows = list.map((r) =>
    [
      r.id,
      new Date(r.createdAt).toISOString(),
      r.paidAt ? new Date(r.paidAt).toISOString() : "",
      (r.amountKobo / 100).toFixed(2),
      r.sats,
      r.ngnPerBtc,
      r.status,
      r.demo ? "demo" : "live",
      r.note,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...rows].join("\n");
}
