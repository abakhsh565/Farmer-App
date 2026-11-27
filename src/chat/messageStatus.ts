import type { ChatMessage } from '@/data/chat';

/**
 * What is known about a message this phone sent.
 *
 * The vocabulary is WhatsApp's because the farmer already reads it that way, but
 * each step here is a fact the shop's own record supports — never an animation:
 *
 *  · `sending`   — a file is still going up from this phone;
 *  · `failed`    — the shop refused it, or the upload died;
 *  · `delivered` — the message is in the shop's thread (the shop stored it). Its
 *                  row is what draws the bubble at all, so this is known, not hoped
 *                  for. A shop that also returns `delivered_to_app_at` adds the time;
 *  · `read`      — the shop returned a read timestamp. This is the only route to a
 *                  blue double tick, and a shop that does not publish receipts never
 *                  gets one, however long the thread stays open.
 *
 * Incoming messages have no state of their own to show the farmer; the function
 * returns `null` for them rather than a misleading "delivered".
 */
export type MessageDelivery = 'sending' | 'failed' | 'delivered' | 'read';

export function deliveryOf(message: ChatMessage): MessageDelivery | null {
  if (message.from !== 'me') return null;

  const file = message.audio ?? message.image;
  if (file?.status === 'sending') return 'sending';
  if (file?.status === 'failed') return 'failed';

  if (message.readAt) return 'read';
  if (message.deliveredAt || message.sentAt) return 'delivered';
  return null;
}
