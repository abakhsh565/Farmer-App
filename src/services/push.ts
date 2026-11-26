import { Capacitor } from '@capacitor/core';
import { farmerRegisterDevice } from '@/shop/api/client';
import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

/**
 * Push registration, for the phone that answers a shop's counter.
 *
 * A shop owner needs to know a farmer joined, or a message is waiting, without
 * opening the app. That is a device token: per install, not per account, because
 * the same owner often has a counter phone and a personal one.
 *
 * Three things this deliberately does not do:
 *
 *  · It does not ask for permission on launch. A notification prompt with no
 *    context is the fastest way to be denied forever, and a phone that is denied
 *    cannot be asked again from inside the app. The caller asks at the moment the
 *    owner is told why — see `requestShopOwnerPush`.
 *  · It does not run in the browser. Web push needs a service worker subscription
 *    with VAPID keys and a sender that speaks Web Push; the native path is what
 *    this project ships, and a half-wired browser path would report success for
 *    notifications it cannot deliver.
 *  · It does not throw at the caller. A shop without push is a shop that reads the
 *    app; it is not an error the owner should see.
 */

export type PushRegistration =
  | { status: 'registered'; platform: 'android' | 'ios' }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'unavailable' };

/**
 * Whether this build can actually receive push.
 *
 * The native plugin asks Firebase for a token on its own background thread, and
 * when the app carries no `google-services.json` that call throws
 * `IllegalStateException: Default FirebaseApp is not initialized` — on a thread no
 * JavaScript can catch. The process dies, at launch, every launch: on 2026-11 the
 * staging APK crash-looped the moment a farmer connected to a shop, because a shop
 * credential is what starts registration.
 *
 * So the plugin is not called at all in a build without Firebase config. The APK
 * build sets `VITE_PUSH_ENABLED=1` once the file is present; until then, a phone
 * without push reads the app, which is the documented fallback rather than a
 * crash.
 */
function pushConfigured(): boolean {
  return import.meta.env.VITE_PUSH_ENABLED === '1';
}

/** True when the app is the installed build rather than the browser tab. */
export function pushSupported(): boolean {
  return Capacitor.isNativePlatform() && pushConfigured();
}

/**
 * Registers this phone and hands the token to the server.
 *
 * The token is stored through `register_push_token`, which is idempotent on the
 * token itself — launching the app again must not double every notification.
 */
/**
 * The notification channel, created before the first push arrives.
 *
 * Android 8 and later drop a notification whose channel does not exist, silently,
 * which is indistinguishable from a push that never arrived. The id is `agrishop`
 * because the shop app uses the same one: one channel in the phone's settings, so a
 * shop owner and a farmer are explaining the same switch when they compare phones.
 */
export const SHOP_CHANNEL_ID = 'agrishop';

export async function ensureShopChannel(): Promise<void> {
  if (!pushConfigured()) return;
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.createChannel({
      id: SHOP_CHANNEL_ID,
      name: 'AgriShop',
      description: 'Messages, offers and visits from your shop',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
  } catch {
    // A channel that already exists is not an error; nor is a shell without the
    // plugin, which is what a browser tab is.
  }
}

/**
 * This phone's FCM token, or null when the platform will not give one.
 *
 * Resolves on whichever comes first: a registration, a registration error, or ten
 * seconds. The platform answers in milliseconds; a refusal must not hang a launch.
 */
async function deviceToken(
  PushNotifications: typeof import('@capacitor/push-notifications').PushNotifications,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const settle = (value: string | null) => resolve(value);

    void PushNotifications.addListener('registration', (value) => settle(value.value));
    void PushNotifications.addListener('registrationError', () => settle(null));
    void PushNotifications.register();

    setTimeout(() => settle(null), 10_000);
  });
}

/**
 * Registers this phone with the shop backend, which is what lets the shop reach it.
 *
 * Deliberately silent about permission: it runs on launch, every launch, and a
 * permission prompt with no explanation on screen is the fastest way to be denied
 * forever. A phone that has not granted it is simply not registered yet.
 */
export async function registerShopDevice(shopToken: string): Promise<boolean> {
  if (!pushConfigured()) return false;
  if (!Capacitor.isNativePlatform()) return false;
  if (!shopToken) return false;

  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return false;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const permission = await PushNotifications.checkPermissions();
    if (permission.receive !== 'granted') return false;

    await ensureShopChannel();

    const token = await deviceToken(PushNotifications);
    if (!token) return false;

    const result = await farmerRegisterDevice(shopToken, token, platform);
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * A tap on a notification, as the route it asked for.
 *
 * `data.route` is the shop's own instruction — `/` for a farmer, meaning "open the
 * conversation". It is read as a signal rather than a URL to navigate to, because a
 * route this app does not recognise is a shop-side deployment detail and must not
 * send a farmer to a screen that does not exist.
 */
export async function onPushTap(handler: (route: string | null) => void): Promise<() => void> {
  if (!pushConfigured()) return () => undefined;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await ensureShopChannel();

    const listener = await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action) => {
        const data = (action.notification?.data ?? {}) as Record<string, unknown>;
        handler(typeof data.route === 'string' ? data.route : null);
      },
    );

    return () => {
      void listener.remove();
    };
  } catch {
    return () => undefined;
  }
}

export async function requestShopOwnerPush(): Promise<PushRegistration> {
  if (!pushConfigured()) return { status: 'unavailable' };
  if (!Capacitor.isNativePlatform()) return { status: 'unsupported' };
  if (!serviceConfig.supabase.configured) return { status: 'unavailable' };

  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return { status: 'unsupported' };

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const existing = await PushNotifications.checkPermissions();
    let permission = existing.receive;

    if (permission === 'prompt' || permission === 'prompt-with-rationale') {
      permission = (await PushNotifications.requestPermissions()).receive;
    }

    if (permission !== 'granted') return { status: 'denied' };

    await ensureShopChannel();

    const token = await deviceToken(PushNotifications);

    if (!token) return { status: 'unavailable' };

    const client = await getSupabaseClient(serviceConfig.supabase);
    if (!client) return { status: 'unavailable' };

    const { error } = await client.rpc('register_push_token', {
      p_token: token,
      p_platform: platform,
    });

    if (error) return { status: 'unavailable' };

    return { status: 'registered', platform };
  } catch {
    return { status: 'unavailable' };
  }
}
