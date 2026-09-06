export type PickupItem = {
  id: string;
  name: string;
  quantity: number;
  delivered_quantity: number;
};

export function remainingToPickUp(item: PickupItem) {
  return Math.max(0, item.quantity - item.delivered_quantity);
}

export function selectedPickupCount(selection: Record<string, number>) {
  return Object.values(selection).reduce((total, quantity) => total + quantity, 0);
}

// A selection must be checked against the latest queue, including items that
// disappeared because another device delivered them. Never silently increase
// or reduce a delivery that an operator is about to confirm.
export function isPickupSelectionValid(items: PickupItem[], selection: Record<string, number>) {
  return Object.entries(selection).every(([id, quantity]) => {
    if (!Number.isInteger(quantity) || quantity < 0) return false;
    if (quantity === 0) return true;
    const item = items.find((candidate) => candidate.id === id);
    return Boolean(item && quantity <= remainingToPickUp(item));
  });
}

export function remainingPickupSelection(items: PickupItem[]) {
  return Object.fromEntries(items.map((item) => [item.id, remainingToPickUp(item)]));
}
