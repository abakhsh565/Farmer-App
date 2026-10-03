import type { MessageKey } from '@/i18n/catalog';

/**
 * Purchases a farmer can ask for credit against.
 *
 * This is a *read model* of the dealer's business records, in the shape the PRD
 * requires: the farmer never types a purchase into existence, they point at one
 * that the shop already knows about. When the dealer integration lands this file
 * is replaced by the synchronized read — the ids and the fields are the contract,
 * and the screens only ever see these fields.
 *
 * `amount` is what the shop quoted for the order; the credit request proposes a
 * repayment against it, and the shop owner decides.
 */
export type Order = {
  id: string;
  productKey: MessageKey;
  dealerKey: MessageKey;
  amount: number;
  km: string;
};

export const ORDERS: readonly Order[] = [
  {
    id: 'order-dap-1',
    productKey: 'product.dap',
    dealerKey: 'dealer.aliTraders',
    amount: 12_000,
    km: '1.8',
  },
  {
    id: 'order-roundup-1',
    productKey: 'product.roundup',
    dealerKey: 'dealer.greenAgro',
    amount: 4_500,
    km: '3.4',
  },
  {
    id: 'order-seed-1',
    productKey: 'product.seedCotton',
    dealerKey: 'dealer.wazirabadAgri',
    amount: 22_000,
    km: '4.1',
  },
];

export function orderById(id: string): Order | undefined {
  return ORDERS.find((order) => order.id === id);
}
