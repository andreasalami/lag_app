import type { MenuCategory, MenuSection } from "../menu/menuSections";

export type OrderCategory = MenuCategory;
export type PreparationMode = "immediate" | "deferred";
export type KitchenState = "none" | "reserved" | "dormant" | "waiting" | "active" | "done";
export type OrderStatus = "in_attesa_pagamento" | "pagato" | "ritiro_parziale" | "consegnato" | "annullato";

export type OrderMenuItem = {
  id: string;
  category: OrderCategory;
  subcategory: MenuSection;
  name: string;
  price: number;
  available_portions: number | null;
  stock_capacity: number | null;
  allergens: number[];
};

export type OrderLine = Omit<OrderMenuItem, "available_portions" | "stock_capacity"> & { qty: number };

export type SubmittedOrder = {
  preparation_mode?: PreparationMode;
  kitchen_state?: KitchenState;
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
  reservation_minutes?: number;
  max_item_quantity?: number;
  max_order_quantity?: number;
};

export type OrderingCatalog = OrderingStatus & { items: OrderMenuItem[] };

export type StaffOrder = {
  preparation_mode?: PreparationMode;
  kitchen_state?: KitchenState;
  id: string;
  event_id: string;
  display_number: number;
  alias: string | null;
  notes: string | null;
  items: OrderLine[];
  total: number;
  status: OrderStatus;
  created_at: string;
  paid_at: string | null;
  claim_expires_at: string | null;
};
