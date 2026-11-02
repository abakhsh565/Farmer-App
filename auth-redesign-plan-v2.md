# Auth redesign v2 — OTP stays, add a credential path

## What's changing

1. **ProfileScreen** — remove the ACCOUNT section only (the `profile.account.title` header card, guest card, "Create an account" row, and the signed-in card with ShieldCheck / Delete account / Log Out). Keep session status (signed in vs guest) shown through the header name/contact, which the profile already does — that row already shows `account?.name`/`account?.phone`/`account?.email`. Keep DataSection and everything else.
2. **Add a new credential sheet** (`src/session/CredentialSheet.tsx`) — a second identity path, alongside the existing OTP `IdentitySheet`. Phone/email tabs stay in the existing sheet; the new sheet is the password path the user described: single "number or email" input (auto-detect; phone max 11 digits) → if exists → password → sign in; if not → name + password → create + sign in.
3. **Wire the sheet open** — the gated actions (`requestIdentity(action, reason)`) open the OTP sheet as today; the new credential sheet opens from a new entry point. Since Profile's "Create an account" row (the only other opener) is being removed, decide how the farmer reaches the credential sheet. Options below.

## What stays

- The existing `IdentitySheet` (OTP, tabs, code step) — untouched.
- The `OtpProvider` contract and all providers (demo, supabase, gateway, development) — untouched. The registry's `serviceSummary` still reports the OTP provider correctly.
- `requestIdentity(action, reason)` + `pendingReason` flow — untouched. Gated actions still open the OTP sheet.

## Where the credential sheet is opened from

Because Profile's manual "Create an account" row is gone, the credential sheet needs an opener. Honest options:
- **A.** Keep a minimal account row in Profile (not the full ACCOUNT section). E.g. a single row under the DataSection: "Signed in as X" or "Not signed in — Sign in". That row opens the *credential* sheet (not the OTP sheet). This is the smallest addition that preserves the user's "remove the account section" intent while still giving a sign-in entry point. This is what I'd recommend — it's one row, not the whole section.
- **B.** No profile entry point at all; the credential sheet is reachable only by... it isn't today. (Not viable unless you add one.)
- **C.** Gated actions open the *credential* sheet instead of OTP for first-time identity, and OTP stays for... then OTP is unreachable. Not what you want.

I'd implement **A**: a single "Sign in" row in Profile (replaces the whole ACCOUNT block) that opens `CredentialSheet`. Gated actions still open `IdentitySheet` (OTP). That keeps both paths reachable and removes the cluttered section.

## The credential sheet flow (what the user described)

- **Step 1 — contact:** one input, "Number or email". Auto-detect: contains `@` → email (lowercased, trimmed); else a phone (digits only, max 11, normalized to `03xxxxxxxxx`). Continue button.
- **Step 2 — exists check:** call the backend to see if an account with that contact exists.
  - **If exists:** go to password step — "Enter your password" → Continue → `signInWithPassword` → on success, `ensure_party` → signed in.
  - **If not exists:** go straight to create — "Your name" + "Create a password" (two fields, no extra text/explanation) → Continue → `signUp` + `signInWithPassword` + `ensure_party` → signed in.
- **Loading/error states:** loading spinners on Continue; invalid-input inline errors (bad phone length, bad email, empty fields, mismatched create passwords if we add confirm); "user already exists" / "wrong password" / "network" sentences matching the app's catalogue tone.
- **Close:** "Not now — keep browsing" closes without signing in (same as today).

## The honest backend question: "does this contact exist?" without a password

Supabase Auth has no client-side "get user by email/phone" (no read-only contact lookup). `signInWithPassword` with a correct email but wrong password and with a nonexistent email both return `invalid_credentials`, so we can't tell "exists but wrong password" from "doesn't exist" from the client alone. So the "does this contact exist?" step in your flow needs a backend capability.

Honest options:
- **Option A (recommended):** add a small backend RPC `user_exists_by_contact(contact TEXT)` as a security-definer function (same family as the existing `ensure_party()` in `supabase/migrations/`), returning `{ exists: boolean, method: 'phone'|'email'|null, authUserId: string|null }`. The sheet calls it first; on true → password step then signInWithPassword + ensure_party; on false → create step. This is the honest way and reuses the exact mechanism the app already trusts for reading auth.users. Needs the migration applied to a Supabase project (local and/or hosted; I can apply to hosted if you give the service_role key, same as the demo provisioning, or you apply it).
- **Option B:** no backend change — the sheet always asks for a password after the contact, tries signInWithPassword, and on failure treats it as "new" and does signUp + signInWithPassword. Imprecise: a returning user who mistypes their password would be nudged toward "create a new account", which is the wrong recovery. Doesn't match your flow cleanly.

I'd go with **A** and apply the migration now (local and hosted, with the key when you set it). If you want to avoid a backend change for now, I can build the sheet against Option B and we revisit the honest lookup later — but that's the imprecise path.

## Phone sign-in caveat (state it honestly in the sheet)

Password sign-in by phone in Supabase Auth requires the auth user's phone to be confirmed AND have a password. So:
- A phone identity created via signUp needs `phone_autoconfirm` on the project (or a confirmation step) for the immediate password sign-in to work.
- An email identity via signUp with password works immediately.
If you want phone to remain OTP-only (the existing path) and the credential path to be email-first with phone still going through OTP, that's a legitimate design and I'll wire the sheet to route phone → OTP sheet and email → credential sheet. Tell me which you want.

## Tests

- Unit tests for the credential sheet: contact auto-detection (email vs phone, phone digit count/max 11, normalization), the exists/new branching with a mocked backend RPC, password sign-in success/failure, sign-up + sign-in success, error sentences.
- Existing `check:fast` + app tests continue to pass; OTP path untouched so OTP tests stay green.

## Files I expect to touch

- `src/screens/ProfileScreen.tsx` — remove ACCOUNT block, add a single "Sign in" row (Option A).
- `src/session/CredentialSheet.tsx` — new file.
- `src/session/SessionProvider.tsx` — wire the new sheet in as the opener for the Profile "Sign in" row (a new `openSignIn` / similar on the session value, alongside `prompt`/`requestIdentity`).
- `src/services/providers/credentialAuth.ts` (or inline in the sheet) — the credential path using the Supabase client: `signInWithPassword`, `signUp`, `ensure_party`. Adds `auth.signUp` to the typed client interface if we go that route.
- `supabase/migrations/<timestamp>_user_exists_by_contact.sql` — the backend RPC (Option A), plus a typed client call if needed.
- `.env.example` / docs — note the new phone-autoconfirm caveat if phone stays in the credential path.

Tell me:
1. Profile "Sign in" row = Option A (single row, opens credential sheet)? Or do you want the account section gone with no profile sign-in entry at all (and the credential sheet reachable another way)?
2. Backend "does this contact exist?" = Option A (add the RPC, I apply the migration) or Option B (client-side imprecise fallback for now)?
3. Phone: stay OTP-only (credential sheet is email-first; phone still goes through the OTP sheet) — or phone also in the credential path with the phone-autoconfirm caveat stated in the UI?
