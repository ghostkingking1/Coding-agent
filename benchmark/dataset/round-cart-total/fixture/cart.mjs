export function cartTotal(items, taxRate) {
  return items.reduce((total, item) => total + item.price * item.quantity, 0) * (1 + taxRate);
}
