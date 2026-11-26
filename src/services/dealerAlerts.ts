/**
 * A dealer's reply as a real phone notification.
 *
 * The dealer platform has no push channel this build can subscribe to, so an alert
 * is raised by the app itself the moment it *sees* a new dealer message: while the
 * app is running in the background the WebView keeps polling for a while, and every
 * one of those reads is a chance to tell the farmer through the phone's own
 * notification shade rather than a screen he is not looking at.
 *
 * What this is not: a replacement for push. Android stops a backgrounded WebView
 * after a short while (and immediately when the phone is dozing), so a reply that
 * arrives after the app has been suspended is only announced when it next runs. A
 * guaranteed alert with the app killed needs FCM (`@capacitor/push-notifications`
 * plus a Firebase project) — until then this is the honest best effort, and the
 * chat still holds every message whether or not the notification fired.
 *
 * The plugin is imported lazily so the website, the tests and the older shells that
 * have no native bridge are unaffected by its presence.
 */

import { Capacitor } from '@capacitor/core';

const CHANNEL_ID = 'dealer-messages';
let channelReady = false;
/** Ids must be unique per app, or a second alert replaces the first. */
let nextId = 4_000;

type NotificationsPlugin = typeof import('@capacitor/local-notifications').LocalNotifications;

async function plugin(): Promise<NotificationsPlugin | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const module = await import('@capacitor/local-notifications');
    return module.LocalNotifications;
  } catch {
    return null;
  }
}

/**
 * Permission and the Android 8+ channel, once per launch.
 *
 * A refused permission is answered with `null` rather than an error: a farmer who
 * said no to notifications should still get the message in the chat.
 */
async function ready(): Promise<NotificationsPlugin | null> {
  const notifications = await plugin();
  if (!notifications) return null;
  if (channelReady) return notifications;

  try {
    let permission = await notifications.checkPermissions();
    if (permission.display !== 'granted') {
      permission = await notifications.requestPermissions();
    }
    if (permission.display !== 'granted') return null;

    try {
      await notifications.createChannel({
        id: CHANNEL_ID,
        name: 'Dealer replies',
        description: 'New messages from the shops you are connected to',
        importance: 4,
        visibility: 1,
      });
    } catch {
      /* Android below 8 has no channels; the notification still posts. */
    }

    channelReady = true;
    return notifications;
  } catch {
    return null;
  }
}

/** What a notification can say about a message that may be a photo or a voice note. */
export function alertBody(message: { text?: string | null }): string {
  const text = message.text?.trim();
  return text && text.length > 0 ? text : 'Sent you an attachment';
}

/**
 * Tell the farmer a dealer replied. Returns whether the phone accepted it, which is
 * only used for logging and testing — the caller never waits on it.
 */
export async function alertDealerReply(
  shopName: string,
  message: { text?: string | null },
): Promise<boolean> {
  try {
    const notifications = await ready();
    if (!notifications) return false;

    await notifications.schedule({
      notifications: [
        {
          id: nextId++,
          title: shopName || 'Your dealer',
          body: alertBody(message).slice(0, 180),
          channelId: CHANNEL_ID,
          smallIcon: 'ic_stat_icon_config_sample',
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}
