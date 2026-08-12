export type OrderCategory = "cibo" | "bevande";

export type OrderMenuItem = {
  id: string;
  category: OrderCategory;
  name: string;
  price: number;
  available_portions: number | null;
  stock_capacity: number | null;
  allergens: number[];
};

export type OrderLine = {
  id: string;
  category: OrderCategory;
  name: string;
  price: number;
  qty: number;
  allergens: number[];
};

export type SubmittedOrder = {
  event_id: string;
  event_name: string;
  order_id: string;
  display_number: number;
  alias: string;
  notes: string | null;
  items: OrderLine[];
  total: number;
  qr_token: string;
};

export type OrderingStatus = {
  accepting: boolean;
  reason: string | null;
  event_id: string | null;
  event_name: string | null;
  opens_at: string | null;
  closes_at: string | null;
};

export type OrderingCatalog = OrderingStatus & { items: OrderMenuItem[] };

export type StaffOrder = {
  id: string;
  event_id: string;
  display_number: number;
  alias: string | null;
  notes: string | null;
  items: OrderLine[];
  total: number;
  status: "in_attesa_pagamento" | "pagato" | "consegnato" | "annullato";
  created_at: string;
  paid_at: string | null;
  claim_expires_at: string | null;
};
