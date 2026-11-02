import { ArrowLeft, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { serviceConfig } from '@/services/config';
import { getSupabaseClient, toE164, type SupabaseLike } from '@/services/supabaseClient';
import { useSession } from './SessionProvider';
import { isEmail, isPhone } from './store';

/**
 * The way into the app: who you are, and then the one step that identity implies.
 *
 * There used to be two sheets — a phone/email tab pair with a code step, and this
 * one behind it. The code step asked a second question even when the answer was
 * already known, and it is still gone: whether the contact exists decides the next
 * screen.
 *
 *   · The contact exists  → the password for it. Nothing else.
 *   · The contact is new  → a name and a password, and the account is made.
 *
 * One field, and the rule reads the *characters* rather than waiting for an `@`.
 * Anything made only of digits, spaces, `+`, dashes and brackets is treated as a
 * number — folded into the national form and capped at eleven — and the moment a
 * letter or an `@` appears the value is an address and is left exactly as typed.
 *
 * The field used to ask whether an `@` had arrived yet and delete every other
 * character as a stray digit, so the letters of `ali@shop.com` were erased one by
 * one before the `@` could be reached and the address arrived as `@shop.com` — and
 * because it asked for the numeric keyboard until that `@` existed, a phone had no
 * `@` key to press at all. The keyboard is now the one that can type both.
 *
 * The one question the client cannot answer on its own is "does this account
 * exist?". Supabase refuses to tell a client, and trying to infer it from a failed
 * password sign-in would send a returning farmer down the new-account path the
 * moment they mistyped. So `user_exists_by_contact` answers it on the server, and
 * this sheet only presents the answer.
 *
 * Without a backend configured (a development build, or a phone with no server),
 * there is nothing to ask, so the answer is treated as "new" and the account is
 * made on the phone — which is what the app's other development providers already
 * do, and what the note at the bottom of the sheet says.
 */

type Step = 'contact' | 'password' | 'create';

/** The shortest password Supabase accepts by default; below it, sign-up fails. */
const MIN_PASSWORD = 6;

/** A number is at most 11 digits here (`0300 1234567`), so the field refuses more. */
const MAX_PHONE_DIGITS = 11;

/** Ties the field that failed to the sentence explaining it, for screen readers. */
const ERROR_ID = 'credential-error';

export function CredentialSheet() {
  const { t } = useLocale();
  const { pendingReason, signIn, dismiss } = useSession();

  const [step, setStep] = useState<Step>('contact');
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  /**
   * The provider's own words, when it explained something the app cannot.
   *
   * "Email address is invalid" and "sign-ups are disabled" are not failures the
   * app can classify, and replacing them with "try again" tells a farmer to
   * repeat a step that cannot succeed. The sentence is shown as-is, the way the
   * OTP sheet already treats a provider's own message.
   */
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Every request starts clean: the previous farmer's typed number is not reused. */
  useEffect(() => {
    if (!pendingReason) return;
    setStep('contact');
    setContact('');
    setPassword('');
    setName('');
    setError(null);
    setDetail(null);
    setBusy(false);
  }, [pendingReason]);

  const channel: 'phone' | 'email' = isEmail(contact) ? 'email' : 'phone';

  /*
   * One field for two kinds of contact, and the rule reads what is in it.
   *
   * Number side — two spellings of the same subscriber are folded rather than
   * refused, because both are things a farmer actually types:
   *
   *   · the international form — `+92 300 1234567` is `0300 1234567`, so the
   *     country code is swapped for the leading zero instead of being truncated
   *     into a number that belongs to somebody else;
   *   · Urdu numerals (`۰۳۰۰۱۲۳۴۵۶۷`) — the keyboard a farmer may well be using.
   *     They become the Latin digits the rest of the app compares against.
   *
   * Address side — nothing is rewritten: an address is typed, not derived, and the
   * only judgement made about it is whether it is one.
   *
   * The test is on the *characters*, so a half-typed address survives. Reading it
   * the other way round — "does it contain an `@` yet" — deleted each letter as it
   * was typed, and no address could be entered at all.
   */
  const onContactChange = useCallback(
    (raw: string) => {
      setContact(onlyNumberCharacters(raw) ? nationalDigits(raw).slice(0, MAX_PHONE_DIGITS) : raw);
      if (error) setError(null);
    },
    [error],
  );

  /** Whether the contact is usable, and in which channel. */
  const validate = (): MessageKey | null => {
    if (contact.trim() === '') return 'credential.emptyContact';
    if (channel === 'email') return isEmail(contact) ? null : 'credential.badContact';
    return isPhone(contact) ? null : 'credential.badContact';
  };

  const continueFromContact = useCallback(async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      /*
       * No backend: nothing knows whether the contact exists, so it is treated as
       * new. The account is then made on the phone, and the note below says so.
       */
      if (!client) {
        setStep('create');
        return;
      }
      const exists = await contactExists(client, contact);
      setStep(exists ? 'password' : 'create');
    } catch {
      setError('credential.backendError');
    } finally {
      setBusy(false);
    }
  }, [contact, channel]);

  const continueWithPassword = useCallback(async () => {
    if (password === '') {
      setError('credential.emptyPassword');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      if (!client) {
        /* Development: the password is what the farmer chose, kept on the phone. */
        finish(null);
        return;
      }

      const credential = credentialFor(channel, contact);
      const { data, error: refusal } = await client.auth.signInWithPassword({
        ...credential,
        password,
      });
      if (refusal || !data.session) {
        setError(
          refusal && isWrongCredentials(refusal.message)
            ? 'credential.wrongPassword'
            : 'credential.backendError',
        );
        setDetail(refusal?.message ?? null);
        return;
      }

      finish(await ensureParty(client));
    } catch {
      setError('credential.backendError');
    } finally {
      setBusy(false);
    }
  }, [channel, contact, password]);

  const continueWithNewAccount = useCallback(async () => {
    if (name.trim() === '') {
      setError('credential.emptyName');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError('credential.weakPassword');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      if (!client) {
        finish(null);
        return;
      }

      const credential = credentialFor(channel, contact);
      /*
       * The account is created with the password the farmer just chose and then
       * signed in with it, in that order: a sign-up that the project requires to
       * be confirmed would otherwise leave them on a sheet with a session that
       * does not exist.
       */
      const created = await client.auth.signUp({ ...credential, password });
      if (created.error && !isAlreadyRegistered(created.error.message)) {
        setError(
          channel === 'phone' ? 'credential.phoneSignupNotSupported' : 'credential.createFailed',
        );
        setDetail(created.error.message);
        return;
      }

      const { data, error: refusal } = await client.auth.signInWithPassword({
        ...credential,
        password,
      });
      if (refusal || !data.session) {
        /*
         * The account was made and the provider still refuses the session: on a
         * project with confirmation switched on, that is the whole answer, and
         * "try again" would send the farmer round the same loop forever.
         */
        setError(
          refusal && isUnconfirmed(refusal.message)
            ? 'credential.confirmRequired'
            : 'credential.createFailed',
        );
        setDetail(refusal?.message ?? null);
        return;
      }

      finish(await ensureParty(client));
    } catch {
      setError('credential.backendError');
    } finally {
      setBusy(false);
    }
  }, [channel, contact, name, password]);

  /**
   * The account, once the server has issued a session.
   *
   * `null` for the party id is a real state: the session exists but the backend
   * has not been asked who it owns yet, and the Profile's data row says so rather
   * than claiming a sync that is not happening.
   */
  const finish = (partyId: string | null) => {
    const result = signIn({ method: channel, contact, name: name.trim() || undefined, partyId });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStep('contact');
  };

  const backToContact = () => {
    setPassword('');
    setName('');
    setError(null);
    setDetail(null);
    setStep('contact');
  };

  return (
    <Sheet
      open={pendingReason !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <SheetContent
        side="bottom"
        /*
         * A thumb-sized sheet: wider than the 430px the identity sheet used, and
         * with the room below the button that a phone with a gesture bar needs.
         */
        className="mx-auto w-full max-w-[520px] pb-2"
      >
        <SheetHeader>
          {/* Two steps are sign-in, one is creation, and the title can only say
              which after the server has answered about the contact. */}
          <SheetTitle>{t(step === 'create' ? 'session.title' : 'credential.signIn')}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-5 pt-1 pb-10">
          {/*
            Why an account is being asked for, in the words of the action that
            asked. Every gate passes a reason (`session.why.post`, `…credit`,
            `…report`), and the sheet is the one place that can show it: without
            this line a farmer tapping "Send report" is shown a sign-in form and
            no explanation of what it has to do with their field. The sentence is
            the caller's, so it is correct for every gate without this sheet
            knowing which action it interrupted.
          */}
          {pendingReason ? (
            <p className="flex gap-2 rounded-md bg-brand-soft px-3 py-2.5 text-body-sm text-brand">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              {t(pendingReason)}
            </p>
          ) : null}

          {step === 'contact' ? (
            <div>
              <Label htmlFor="credential-contact" className="text-label text-muted-foreground">
                {t('credential.contactLabel')}
              </Label>
              {/*
                One field for either, and the keyboard is the one that can type
                both: `email` carries the `@` a number never needs and the digits
                an address never needs.
              */}
              <Input
                id="credential-contact"
                type="text"
                inputMode="email"
                autoComplete="username"
                value={contact}
                onChange={(event) => onContactChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void continueFromContact();
                }}
                placeholder={t('credential.contactPlaceholder')}
                className="mt-3 h-12 px-4"
                aria-invalid={fieldOf(error) === 'contact'}
                aria-describedby={error ? ERROR_ID : undefined}
                readOnly={busy}
              />
            </div>
          ) : null}

          {step === 'password' ? (
            <p className="text-body-sm text-muted-foreground">
              {t('credential.passwordPrompt', { contact: contact.trim() })}
            </p>
          ) : null}

          {step === 'password' ? (
            <div>
              <Label htmlFor="credential-password" className="text-label text-muted-foreground">
                {t('credential.passwordLabel')}
              </Label>
              <Input
                id="credential-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void continueWithPassword();
                }}
                className="mt-3 h-12 px-4"
                aria-invalid={fieldOf(error) === 'password'}
                aria-describedby={error ? ERROR_ID : undefined}
                readOnly={busy}
              />
            </div>
          ) : null}

          {step === 'create' ? (
            <>
              <div>
                <Label htmlFor="credential-name" className="text-label text-muted-foreground">
                  {t('credential.nameLabel')}
                </Label>
                <Input
                  id="credential-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={t('credential.namePlaceholder')}
                  autoComplete="name"
                  className="mt-3 h-12 px-4"
                  aria-invalid={fieldOf(error) === 'name'}
                  aria-describedby={error ? ERROR_ID : undefined}
                  readOnly={busy}
                />
              </div>
              <div>
                <Label
                  htmlFor="credential-new-password"
                  className="text-label text-muted-foreground"
                >
                  {t('credential.createPasswordLabel')}
                </Label>
                <Input
                  id="credential-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void continueWithNewAccount();
                  }}
                  placeholder={t('credential.createPasswordPlaceholder')}
                  className="mt-3 h-12 px-4"
                  aria-invalid={fieldOf(error) === 'password'}
                  aria-describedby={error ? ERROR_ID : undefined}
                  readOnly={busy}
                />
              </div>
            </>
          ) : null}

          {error ? (
            <p
              id={ERROR_ID}
              role="alert"
              className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
            >
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {t(error, { contact: contact.trim() })}
            </p>
          ) : null}

          {/* The provider's own sentence, kept because it is often the only
              accurate explanation there is. */}
          {detail ? (
            <p className="rounded-md bg-muted px-3 py-2.5 text-caption text-muted-foreground">
              {detail}
            </p>
          ) : null}

          {step === 'contact' ? (
            <Button className="mt-7 h-12 rounded-full" onClick={() => void continueFromContact()} disabled={busy}>
              {busy ? t('credential.checking') : t('credential.continue')}
            </Button>
          ) : null}

          {step === 'password' ? (
            <Button className="mt-7 h-12 rounded-full" onClick={() => void continueWithPassword()} disabled={busy}>
              {busy ? t('credential.signingIn') : t('credential.signIn')}
            </Button>
          ) : null}

          {step === 'create' ? (
            <Button className="mt-7 h-12 rounded-full" onClick={() => void continueWithNewAccount()} disabled={busy}>
              {busy ? t('credential.creating') : t('credential.create')}
            </Button>
          ) : null}

          {/* Only the steps past the contact have somewhere to go back to; the
              sheet's own close control is the way out of the first one. */}
          {step !== 'contact' ? (
            <button
              type="button"
              onClick={backToContact}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-full py-2 text-body-sm text-muted-foreground"
            >
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              {t('credential.back')}
            </button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The field an error belongs to, so exactly that one is marked as wrong.
 *
 * A sheet-level failure — the backend unreachable, a sign-up the provider
 * refused — has no field to blame, and marking both of them red would tell a
 * farmer to fix something that is not the problem.
 */
function fieldOf(error: MessageKey | null): 'contact' | 'name' | 'password' | null {
  if (error === 'credential.emptyContact' || error === 'credential.badContact') return 'contact';
  if (error === 'credential.emptyName') return 'name';
  if (
    error === 'credential.emptyPassword' ||
    error === 'credential.weakPassword' ||
    error === 'credential.wrongPassword'
  ) {
    return 'password';
  }
  return null;
}

/**
 * Whether every character typed so far could belong to a phone number.
 *
 * Digits (Latin and Urdu), spaces, `+`, dashes, brackets and dots qualify. One
 * letter, or an `@`, and this is an address being typed — which is why the field
 * asks this question instead of asking whether an `@` has arrived yet: that
 * version erased the letters before the `@` could be reached.
 */
function onlyNumberCharacters(raw: string): boolean {
  return /^[0-9\s()+.\-\u0660-\u0669\u06f0-\u06f9]*$/.test(raw);
}

/**
 * Digits in the national form the app compares against: `03001234567`.
 *
 * Accepts whatever of a number a farmer typed — spaces, dashes, a `+92` country
 * code, Urdu numerals — and returns at most eleven digits starting `0`.
 */
function nationalDigits(raw: string): string {
  const ascii = raw.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) =>
    String(digit.charCodeAt(0) & 0xf),
  );
  const digits = ascii.replace(/[^0-9]/g, '');
  /* `92` + ten digits is the international spelling of the same subscriber. */
  if (digits.startsWith('92') && digits.length > MAX_PHONE_DIGITS) return `0${digits.slice(2)}`;
  return digits;
}

/** The contact in the shape the provider stores it. */
function credentialFor(
  channel: 'phone' | 'email',
  contact: string,
): { phone?: string; email?: string } {
  return channel === 'email' ? { email: contact.trim().toLowerCase() } : { phone: toE164(contact) };
}

/**
 * Whether the server already holds an account for this contact.
 *
 * The function is a security definer in the database because `auth.users` is not
 * readable by a client; the answer comes back as one boolean, and a boolean is all
 * this needs.
 */
async function contactExists(client: SupabaseLike, contact: string): Promise<boolean> {
  const value = isEmail(contact) ? contact.trim().toLowerCase() : contact.replace(/[^0-9]/g, '');
  const { data, error } = await client.rpc('user_exists_by_contact', { p_contact: value });
  if (error) throw new Error(error.message);
  if (typeof data === 'boolean') return data;
  /* Older shape: a single row. Read the flag out of whichever column carries it. */
  if (Array.isArray(data) && data.length > 0) {
    const row = data[0] as Record<string, unknown>;
    return row.exists_ === true || row.exists === true;
  }
  return false;
}

/**
 * The party id for the session just established.
 *
 * `ensure_party()` is idempotent, and a session without a party id is a real state
 * the app can show rather than a failure to hide — so this returns null instead of
 * throwing when the backend does not answer.
 */
async function ensureParty(client: SupabaseLike): Promise<string | null> {
  try {
    const { data, error } = await client.rpc('ensure_party');
    if (error) return null;
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

function isWrongCredentials(message: string): boolean {
  return /invalid|wrong|bad|incorrect|credentials|not match/i.test(message);
}

function isAlreadyRegistered(message: string): boolean {
  return /already|registered|exists/i.test(message);
}

/** A sign-up the project will not let through until the contact is confirmed. */
function isUnconfirmed(message: string): boolean {
  return /not confirmed|confirm/i.test(message);
}
