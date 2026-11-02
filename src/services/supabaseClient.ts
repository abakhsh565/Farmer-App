/**
 * The one Supabase client in the app.
 *
 * It lives in its own module because it is a *session* holder, not just a
 * transport: the token that authorises an RPC is the same token that identifies
 * the farmer, and two clients would mean two copies of it, refreshed on two
 * different clocks. Everything that talks to the backend — the repository, the
 * normalised weather/market/dealer reads, the saved location, the AI gateway's
 * `Authorization` header — goes through here.
 *
 * The import is dynamic and failure is returned rather than thrown, so a build
 * with no backend configured runs entirely on its development providers instead
 * of crashing at import time. That property is load-bearing for the tests and for
 * a device running the offline path.
 */

/** The narrow slice of the SDK this app uses. Typed by hand so the surface stays explicit. */
export type SupabaseSession = {
  access_token: string;
  user: { id: string; phone?: string | null; email?: string | null };
};

/**
 * Sign-up input accepted by the Supabase client's `auth.signUp`.
 *
 * Kept explicit so the credential sheet can call `signUp` with a typed input
 * rather than a loose object. The `options` bag is broad enough to let the SDK
 * accept it and narrow enough for the app's own use.
 */
export type SupabaseSignUpInput = {
  email?: string;
  phone?: string;
  password: string;
  options?: {
    emailRedirectTo?: string;
    phonePhone?: string;
    [key: string]: unknown;
  };
};

export type SupabaseLike = {
  from: (table: string) => unknown;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  auth: {
    getSession: () => Promise<{ data: { session: SupabaseSession | null } }>;
    /** Supabase sends its own SMS when phone auth is configured; we never hold the code. */
    signInWithOtp: (input: {
      phone?: string;
      email?: string;
      options?: Record<string, unknown>;
    }) => Promise<{ data: unknown; error: { message: string; status?: number } | null }>;
    verifyOtp: (input: {
      phone?: string;
      email?: string;
      token: string;
      type: 'sms' | 'email';
    }) => Promise<{
      data: { session: SupabaseSession | null; user: { id: string } | null };
      error: { message: string; status?: number } | null;
    }>;
    /**
     * Credential sign-in. Used by the credential sheet and the dev demo provider;
     * the password check is still the server's.
     */
    signInWithPassword: (input: {
      phone?: string;
      email?: string;
      password: string;
    }) => Promise<{
      data: { session: SupabaseSession | null; user: { id: string } | null };
      error: { message: string; status?: number } | null;
    }>;
    /**
     * Create an authenticated user with an email or phone and a password. Used by
     * the credential sheet's self-sign-up step — a new contact becomes a user
     * without an OTP being sent.
     *
     * The returned `data.user` is the auth uid when sign-up succeeds; `data` itself
     * may be null when the provider returns no body. A sign-up that succeeds may
     * still require the provider to confirm the contact before sign-in works, which
     * is why the sheet surfaces an honest \"phone sign-up not supported\" when the
     * phone path is not usable client-side.
     */
    signUp: (input: SupabaseSignUpInput) => Promise<{
      data: { user: { id: string } | null; superset_ref?: string | null } | null;
      error: { message: string; status?: number } | null;
    }>;
    signOut: () => Promise<{ error: { message: string } | null }>;
    onAuthStateChange?: (callback: (event: string) => void) => { data: { subscription: unknown } };
  };
};

/**
 * Reads the caller's auth uid without constructing a full session object. Used by
 * the credential sheet's `ensure_party` call, which only needs the uid.
 */
export async function currentAuthUserId(): Promise<string | null> {
  const client = cachedClient;
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

let cachedClient: SupabaseLike | null = null;
/**
 * The attempt currently in flight, cached so concurrent callers share it.
 *
 * Caching the client alone was not enough. `await import(...)` yields, so every
 * caller that arrives in the same tick passes the `cachedClient` check before
 * any of them has set it, and each goes on to build its own client: the app was
 * creating three on startup, all sharing one `sb-…-auth-token` storage key.
 * Supabase warns that this \"may produce undefined behavior when used
 * concurrently\" — in practice a token refresh from one instance invalidates
 * another, which arrives to the farmer as being signed out for no reason.
 *
 * Caching the promise makes the whole creation one operation: the first caller
 * starts it, the rest await the same result.
 */
let clientAttempt: Promise<SupabaseLike | null> | null = null;
let clientFailed = false;

export function resetSupabaseClient(): void {
  cachedClient = null;
  clientAttempt = null;
  clientFailed = false;
}

/**
 * Lazily creates the client. Returns null — never throws — when the backend is
 * not configured or the dependency cannot be loaded.
 */
export async function getSupabaseClient(config: {
  configured: boolean;
  url: string | null;
  anonKey: string | null;
}): Promise<SupabaseLike | null> {
  if (cachedClient) return cachedClient;
  if (clientFailed) return null;
  if (clientAttempt) return clientAttempt;
  if (!config.configured || !config.url || !config.anonKey) return null;

  clientAttempt = (async () => {
    try {
      const mod = await import('@supabase/supabase-js');
      cachedClient = mod.createClient(config.url as string, config.anonKey as string, {
        auth: { persistSession: true, autoRefreshToken: true },
      }) as unknown as SupabaseLike;
      return cachedClient;
    } catch {
      clientFailed = true;
      return null;
    }
  })();

  return clientAttempt;
}

/**
 * The signed-in farmer's access token, or null.
 *
 * Read from the client's own session rather than from a store of our own, so
 * there is exactly one copy of the token and one place that refreshes it. A guest
 * is a legitimate answer here: the AI gateway answers guests, and an expired token
 * in the moment before refresh simply arrives as one.
 */
export async function currentAccessToken(): Promise<string | null> {
  const client = cachedClient;
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** The signed-in user's auth id, or null. */
export async function currentAuthUserId_(): Promise<string | null> {
  const client = cachedClient;
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

/** The signed-in user as Supabase knows them. */
export type SessionUser = { id: string; phone: string | null; email: string | null };

/**
 * Who Supabase thinks is signed in, or null for a guest.
 *
 * Distinct from `currentAuthUserId()` on purpose. The id is what a token is
 * addressed to; the phone and the email are what the farmer *is*, and they are
 * needed to rebuild the app's own account when the app's copy of the session was
 * lost while Supabase's survived. Reading the session is local — it does not
 * touch the network — so this is cheap enough to ask on every launch.
 */
export async function currentSessionUser(): Promise<SessionUser | null> {
  const client = cachedClient;
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    return { id: user.id, phone: user.phone ?? null, email: user.email ?? null };
  } catch {
    return null;
  }
}

/**
 * E.164 for Supabase's phone auth, from the app's own normalised digits.
 *
 * The app stores Pakistani numbers as national digits (`03001234567` normalised
 * to `923001234567`); Supabase wants the same number with a leading `+`.
 */
export function toE164(digits: string): string {
  const bare = digits.replace(/[^0-9]/g, '');
  if (bare === '') return '';
  if (bare.startsWith('0')) return `+92${bare.slice(1)}`;
  if (bare.startsWith('92')) return `+${bare}`;
  return `+${bare}`;
}

/**
 * The inverse of `toE164`.
 *
 * Supabase stores `+923001234567`; the app asks a farmer for `03001234567`.
 * A session that is adopted has to be shown the way the farmer would have typed
 * it, or the profile would display a number in a format no screen in the app
 * ever accepts.
 */
export function fromE164(phone: string): string {
  const bare = phone.replace(/[^0-9]/g, '');
  if (bare.startsWith('92') && bare.length >= 12) return `0${bare.slice(2)}`;
  return bare;
}
