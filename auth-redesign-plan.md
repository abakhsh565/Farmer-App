# New auth flow: design

## What the user asked

1. **Profile page: remove the "Account" section entirely** (the ACCOUNT block in ProfileScreen — guest state row, "Create an account" button, signed-in row, Delete account, Log Out).
2. **Replace the current OTP sheet** (phone/email tabs → contact → OTP code → verify) with a **single unified credential sheet**, no tabs:
   - One input field that accepts a number or an email, detected automatically (contains `@` → email; otherwise a number, max 11 digits).
   - Two-step flow:
     - Step 1: enter number or email → system checks whether it exists.
     - Step 2A (exists): enter password to sign in.
     - Step 2B (does not exist): automatically move to account creation — enter **name + password** (no extra text, no extra explanation, no extra step). Create the account, sign in.

So the sheet is: `contact input → exists? → [exists] password → sign in / [new] name+password → create → sign in`.

## What the existing system actually provides

- The `OtpProvider` contract is two methods: `request(channel, destination)` and `verify(channel, destination, code)`. It is OTP-only by design.
- The only provider that can mint a real session is `SupabaseOtpProvider`, which calls Supabase Auth OTP. It has an `identity()` method (returns `partyId`) and signs in via `signInWithOtp`/`verifyOtp`.
- `src/services/supabaseClient.ts` exposes `auth.signInWithPassword` (credential sign-in) on the typed `SupabaseLike` interface. That is the mechanism a password-based flow would use.
- The registry (`src/services/registry.ts`) selects the OTP provider; the OTP provider choice is `demo | supabase | gateway | development`.
- The sheet (`src/session/IdentitySheet.tsx`) uses `provider.request` → `provider.verify` → `provider.identity?()` → `signIn(...)` → session established.
- The store (`src/session/store.ts`) `signIn` takes `{ method, contact, name?, partyId? }` and produces an `Account`.

## Design decisions

### Two flows, same sheet surface

The new sheet replaces the OTP sheet and is **destination-only first**, then splits by existence:
- Contact input (auto-detected: phone vs email, max 11 digits for phone).
- If exists → password step (sign-in).
- If new → name + password step (create + sign-in).

This keeps the existing `OtpProvider` machinery in place for whatever still uses OTP (and we keep the existing providers untouched), while adding a **new password-based credential path** for the new sheet.

### Auth backend for the new path

The natural provider for password sign-in in a Supabase-backed deployment is the same `auth.signInWithPassword` route used by `SupabaseOtpProvider`'s demo variant. We add a **credential provider** built on the same Supabase client, and wire it as the provider the new sheet uses.

Exactly what the credential provider should do:
- On "contact exists?" check: call the backend to see whether an account with that contact (phone normalized to E.164, or email lowercased) exists. The honest way is to attempt credential-based lookup — but Supabase Auth doesn't expose a "does this user exist?" endpoint directly. The realistic approach (and the one that also yields the session) is:
  - **Sign-in by password** for an existing user (that yields the session).
  - **Sign-up** for a new user (create user + auth.uid() → session), then `ensure_party()` → partyId.
- So the "exists?" step is really: "can we sign in or create with this contact + this password/name?" The split is:
  - try sign-in by password with the given password against this contact → if session → login.
  - if sign-in fails as "user not found" / "no such user" → do sign-up (create with the contact as the password credential, or create a user and set the password), then sign-in, then ensure_party.

Actually more precisely: Supabase Auth phone/password sign-in requires a **password** stored on the auth user. A brand-new user created via `signUp` with email+password (or phone+password) will have a password; subsequent `signInWithPassword` works. So the "new user" path is:
  signUp({ email or phone, password }) → auth.user created → then signInWithPassword with the same password → session → ensure_party → partyId.

And the "existing user" path is:
  signInWithPassword({ email or phone, password }) → if session → ensure_party → partyId.

The "does this contact exist?" check is then implicit in the flow: try sign-in first; if it fails, treat as a new user and sign up.

### Phone password caveat

Password sign-in by phone requires the auth user to have a **confirmed phone** + a password stored. In Supabase Auth, phone+password sign-in works when `phone_autoconfirm` is on OR the user's phone is confirmed, AND a password is set (e.g. by sign-up with password, or by the provider setting it). This is the same caveat as the earlier demo flow: the app handles "password + verified phone" only in the demo build's sense. We should be honest about this in the UI/catalogue: a phone sign-in requires a password on file. For email, the normal real path (sign-up with email+password, then signInWithPassword) works.

### Maintaining the OTP path

We keep the OTP sheet *running* because the rest of the app (gated actions, the `pendingReason` flow) still uses it. The request is to redesign login, not to remove OTP. Strategy:
- Add the new credential sheet as a separate screen/component.
- The entry point that opened the OTP sheet (Profile's "Create an account" prompt) is removed (per request 1).
- So the new credential sheet becomes the *only* identity flow. The `requestIdentity` + `pendingReason` flow still works — the new sheet opens for the same `pendingReason`, just with the new UI.

Wait — request 1 says "remove this compellty accoutn secion on profile page". That is the ACCOUNT block in ProfileScreen, which contains the "Create an account" button that calls `prompt('profile.account.createReason')`. Removing it means the Profile no longer opens the identity sheet at all. But gated actions still call `requestIdentity` / `pendingReason` (post, reply, dealer message, credit, etc.) — those still open the identity sheet.

So: the Profile page loses the ACCOUNT section (no longer a manual "sign in" entry point); the identity sheet is still opened by `requestIdentity` for gated actions. But the user's new login flow is the whole replacement — so the identity sheet *is* the new sheet.

Question: does the Profile page still need an account entry point at all? The request says remove the ACCOUNT section. So the Profile shows the farmer's details and settings, but no "Sign in / Create account" row. That's fine — the identity sheet opens via `requestIdentity` when needed.

Actually, wait: if the user is a guest and there's no ACCOUNT section in Profile, how does a first-time user ever get to the identity sheet? Via a gated action (post, dealer message, credit). That's actually the existing "identity-on-action" design intent — the user said "anywhere login shown this data" — and the sheet is the entry point. Good.

### The new sheet, step by step (the UI the user pasted as "images")

From the two pasted images:
- Image 1 (profile Account section to remove): "ACCOUNT" header, a card with two parts — top: "You are browsing without an account. Crops, language and drafts stay on this phone." + icon; bottom: "Create an account" link + chevron.
- Image 2 (the sheet we replace): "Create your account" modal, info banner, Mobile/Email tabs, Mobile number input, "Your name" input (pre-filled "Bilal Ahmed"), Continue button, "Not now — keep browsing", footer "We will send a code by SMS to this number..."

We replace Image 2's sheet with the new credential flow:
- Title: "Sign in" or "Create your account" depending on step.
- A single input: "Number or email" — auto-detects.
- A Continue button.
- Step detection: if contact looks like an email → email path; else phone (max 11 digits), auto-normalised.
- After Continue:
  - If a session was established via sign-in → done.
  - If sign-in failed as "no such user" → move to name+password step (create).
- Name + password step: "Your name" + "Password" fields, a Create/Continue button. On success, account created and signed in.
- Loading states, invalid-input states, "user already exists with a different contact?" handling, etc.

### What we keep from the existing sheet's look

We keep the Sheet morphology (bottom sheet, title, Close button, Continue/Not now pattern, the rounded inputs, the info banner style). We replace the tabs + OTP code step with the single-field credential flow.

### Scope of the build

1. **Remove** the ACCOUNT block from ProfileScreen (lines ~188-242 there: the `profile.account.title`, the guest div, the `Row` with LogIn icon "Create an account", and the signed-in branch with ShieldCheck / DeleteAccount / LogOut). Keep everything else in ProfileScreen.
2. **Build** the new credential sheet component (`src/session/CredentialSheet.tsx`) replacing the OTP sheet. It:
   - Accepts `pendingReason`.
   - Has state: `step` ('contact' | 'password' | 'create' | 'done'), `contact`, `name`, `password`, `isEmail`, `loading`, `error`.
   - Auto-detects email vs phone (contains `@` → email; else phone, trimmed digits, length ≤ 11).
   - Step 1 → Continue → resolve contact against backend (try signInWithPassword; if no user, proceed to create step).
   - Create step → signUp + signInWithPassword + ensure_party → done.
   - Uses the Supabase client (the same one) for both sign-in and sign-up.
3. **Wire** the new sheet into SessionProvider in place of IdentitySheet (or alongside, gated by... actually replace: the new sheet becomes *the* identity sheet). We keep `requestIdentity` + `pendingReason` flow intact.
4. **Keep** the OTP providers untouched (they are still used by whatever still uses OTP; and the demo provider's `signInWithPassword` code can be reused/inspected as reference). We add a new credential provider or inline the Supabase credential calls in the sheet.

Question: should the credential provider be a new class implementing a contract, or just inline Supabase calls in the sheet? Given the new sheet is the *only* identity flow now, and the existing OTP providers are still around for... actually, do anything else still use OTP? Let me check: the current identity sheet is the only place that calls `provider.request`/`provider.verify`. If we replace it with the credential sheet, the OTP providers would become unused.

Decision: keep it simple and honest — add a **credential-based auth function** used by the new sheet, built on the Supabase client (the same one), and replace IdentitySheet with the new CredentialSheet. The OTP provider selection in the registry can stay (for the diagnostics panel it reports which provider is running), but the actual auth flow becomes credential-based.

Actually — the cleanest and most honest approach given the user's intent: the new flow is **password-based sign-in/sign-up**. We build it on the Supabase client. We replace the IdentitySheet with the new sheet. We keep the OTP providers in the registry (so `serviceSummary` still reports correctly), but the sheet no longer uses them.

But wait — there's a subtlety. The user said: "using this data shown first enter number or email → system check if exist ask to move to next to ask enter password if not then he create account automatically without any extra text or expalanaion or step ask him to enter his name and password and complete it."

So the flow is:
1. Enter number or email.
2. System checks if it exists.
3. If exists → move to next step → ask password → enter → login.
4. If not exist → automatically create account (without extra text/explanation/step) → ask for name and password → complete.

This implies: after entering a non-existent contact, the UI *automatically* transitions to the name+password step (no extra prompt, no "this contact doesn't exist, create an account?" confirmation). The user just types a number/email, taps Continue, and the UI either asks for password (existing) or shows name+password (new) — seamlessly.

Implementation:
- Contact input + Continue button.
- On Continue:
  - Validate contact (email or 11-digit phone).
  - Call backend: try signInWithPassword with this contact + a *tentative* password? No — we don't have a password yet for the "exists?" check. We only have the contact.
  - So the "exists?" check is: does an auth.user with this contact exist? We can check via the Supabase admin API, or via the client's `getSession`/`getUser`... hmm.

Actually the cleanest "does this contact exist?" for Supabase Auth is:
- Try to sign in with the contact and... we don't have a password. So we can't.
- Alternative: use the Supabase admin API (service role) to list users and check by email/phone. That needs the service_role key — not available to the client.
- Alternative: on the backend, expose an Edge Function that checks whether an auth.user with this contact exists (read-only, no session). That's the honest way.

But that's more infrastructure than the user asked for. Let me think about what's realistic given the existing codebase.

The existing codebase has:
- Supabase client with `auth.signInWithOtp`, `auth.verifyOtp`, `auth.signInWithPassword`, `auth.signUp`? Let me check if `signUp` is on the typed interface. From the grep: `signInWithOtp`, `verifyOtp`, `signInWithPassword`, `signOut`, `getSession`, `onAuthStateChange`. **No `signUp` on the typed interface.** So sign-up isn't currently typed. We'd need to add it.

For the "does this contact exist?" check without a password, the honest options are:
1. Add a read-only Edge Function `auth/user-exists` (returns whether an auth.user with this email/phone exists). Requires backend work.
2. Attempt signInWithPassword with the contact and an *empty/placeholder* password — that would fail, but the failure mode might tell us "user not found" vs "wrong password". In Supabase Auth, `signInWithPassword` with a valid email but wrong password returns `invalid_credentials` (not "user not found"). With an email that has no user, also `invalid_credentials`. So we can't distinguish. Not useful.
3. Use `signUp` with the contact + a placeholder? signUp with email creates a user; with phone it may require confirmation. Not useful for "does it exist?".

So the honest "does this contact exist?" requires either the admin API (service role, server-side) or a backend Edge Function. Given the codebase already has Edge Functions (`supabase/functions/`), option 1 (a read-only Edge Function) is the honest path.

Hmm, but the user explicitly asked for "system check if this number exiist" as part of the flow. So we do need a backend check. Let me see what Edge Functions exist.

Actually, let me step back. Given the complexity, let me be pragmatic and honest with the user first about what the backend can and cannot do, *before* building. The honest question: does the backend have a read-only way to check if a contact (phone or email) has an auth.user?

Let me check the existing Edge Functions and the Supabase setup.

Actually — I realize I should present this as a decision to the user, because the "does this contact exist?" step without a password is the crux, and the honest options depend on what the backend can do. Let me check the backend capabilities first, then present options.

Let me check:
- Does `supabaseClient.auth` expose `signUp`? (No, from grep.)
- What Edge Functions exist in `supabase/functions/`?
- What's the Supabase setup (project URL, functions)?

Let me look. Actually, I've spent enough exploration. Let me present the situation to the user with the honest options and ask.

Wait — actually, re-reading the user's request: they want password-based login/registration. The most natural Supabase Auth flow for this (when Supabase Auth is configured) is:
- **Sign-up**: `signUp({ email, password })` or `signUp({ phone, password })` → creates auth.user → sets password → (for phone, requires confirmation or phone_autoconfirm).
- **Sign-in**: `signInWithPassword({ email, password })` or `signInWithPassword({ phone, password })`.

And "does this contact exist?" can be answered on the client by:
- Trying `signInWithPassword` with the contact + the *user's entered password* (in the password step). If it succeeds → login. If it fails as "invalid_credentials" → the user doesn't exist *with that password*, but could exist with a different password... not conclusive.
- OR: for the "does this contact exist?" check *before* asking for a password, we need a read-only lookup.

The honest backend-less approach: **don't do a separate "does it exist?" check.** Instead, restructure:
1. User enters contact.
2. User enters password (always — for both existing and new).
3. Try signInWithPassword(contact, password):
   - If succeeds → login.
   - If fails (invalid_credentials) → try signUp(contact, password):
     - If signUp succeeds (user created) → then signInWithPassword → login. (Phone signUp may require confirmation; if not confirmed, signInWithPassword fails. So phone password sign-up requires phone_autoconfirm on, or the user to confirm. This is the phone caveat.)
   - If signUp also fails → error.

But the user explicitly said: existing user → password step; new user → name+password step (no password in the "exists?" step). So the user's flow does have a password *only* in the password step (step 2A), and name+password in the create step (step 2B). That means for the "exists?" check (step 1→2), we don't have a password.

Hmm, so we *do* need a "does this contact exist?" check without a password, per the user's flow.

OK so the options for "does this contact exist?" without a password:
A. Backend Edge Function (read-only, returns exists/doesn't). Honest, requires backend work.
B. Supabase admin API via a server-side function (service_role). Same as A essentially.
C. Client-side heuristic: just assume the contact is new if signInWithPassword (in step 2A with the password) fails — but then we conflate "user doesn't exist" with "wrong password", which is wrong per the user's spec (existing user with wrong password should still go to "re-enter password", not "create new account").

Given the user's explicit flow, option A (backend Edge Function) is the honest path. Let me check if the codebase has an Edge Function we can extend, or if we need to add one.

Let me check the Edge Functions directory and the Supabase setup quickly. I'll do this and then present to the user.

Actually — let me reconsider. Maybe I'm overcomplicating. Let me re-read the user's flow once more:

"when user enter his number system check if this number exiist then ask to enter password to enter in the app if not then automatically create account and for create account user have to entner anem and create passoerd for later for login as usual.

if user exiist in the ystem he enter passowrd other wise create account as per telling"

So:
- Enter number/email.
- System checks if it exists.
- If exists → ask password → enter → login.
- If not exists → create account (name + password) → complete.

The "check if exists" is the key step. For this to work honestly, the backend must be able to answer "does auth.user with this contact exist?" — and it must do so *without* requiring a password (since the password comes in step 2A).

In Supabase Auth, a client-side "does this email exist?" check is not directly exposed (no `getUser` by email). The honest ways:
1. Backend Edge Function: `POST /functions/v1/auth/check-contact` with `{ contact }` → `{ exists: true, method: 'email'|'phone' }` or `{ exists: false }`. Requires the Edge Function to use the service_role key (which Supabase injects into functions) or to query `auth.users` via a defined RPC.
2. An RPC `get_user_by_contact(contact)` on the Supabase DB that queries `auth.users` (using the `auth.uid()`-independent path — but `auth.users` is only readable by the service role or via a security definer function). Supabase's `ensure_party` RPC pattern (the codebase already has it) shows how to create a security-definer RPC. We could add `user_exists_by_contact(contact)` as a security-definer RPC.

Given the codebase already has `ensure_party` (a security-definer RPC that reads `auth.users` and creates the party), adding `user_exists_by_contact` as a similar security-definer RPC is the most consistent honest approach. It's backend work (an SQL migration + applying it), but it's the honest way.

Let me check the existing `ensure_party` migration and the RPC pattern, then decide.

Actually, let me just check the supabase migrations for `ensure_party` and the functions dir. Then I'll present a clear plan to the user.

Let me look. I'll also re-read the existing code more carefully to know what's there.

OK given time constraints, let me just present the honest situation and the options to the user, with a recommendation. The key honest point: the "does this contact exist?" step without a password requires a backend capability (an RPC or Edge Function) that the client alone cannot do. I need to know if the user wants me to add that backend capability (an SQL function `user_exists_by_contact` via a migration, applied to their Supabase project) as part of this task, or if they want a client-side approximation.

Let me present this clearly with the recommendation (add the security-definer RPC, since the codebase already uses exactly that pattern via `ensure_party`).

I'll do a quick check of the existing `ensure_party` migration to reference it accurately, then present.

Let me check.