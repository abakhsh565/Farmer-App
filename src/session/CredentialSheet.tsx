import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
 * The way into the app: who you are, prove it, then finish the account.
 *
 * Four steps, in the order the reference lays them out:
 *
 *   · contact — one field for a mobile number or an email address
 *   · otp     — six digits, a resend countdown, and a way to correct the contact
 *   · create  — a name and a password, for a contact the server has not seen
 *   · password — the password for a contact it has
 *
 * Verification used to be skipped entirely: whether the contact existed decided
 * the next screen, and no proof was ever asked for. That made "sign in" a claim
 * rather than a fact. The code is asked for first now, so the account that follows
 * belongs to somebody who can receive at that number or address.
 *
 * ## The code is a placeholder, on purpose
 *
 * There is no SMS gateway wired to this build yet, so the code is the fixed
 * `123456` and it is written on the sheet rather than pretending a message was
 * sent. That is the honest version of a mock: a screen that says "we sent a code"
 * and then accepts anything is worse than one that says which code this build
 * uses. When a real `OtpProvider` is connected, `submitCode` is the one function
 * that changes — the steps, countdown and errors stay as they are.
 *
 * ## The contact field
 *
 * One field, and the rule reads the *characters* rather than waiting for an `@`.
 * Anything made only of digits, spaces, `+`, dashes and brackets is treated as a
 * number — folded into the national form and capped at eleven — and the moment a
 * letter or an `@` appears the value is an address and is left exactly as typed.
 *
 * ## What the client cannot answer
 *
 * "Does this account exist?" is asked of the server, after the code has been
 * verified, because the next screen depends on it. Without a backend there is
 * nothing to ask, so the answer is "new" and the account is kept on the phone.
 */

type Step = 'contact' | 'otp' | 'password' | 'create';

/** The shortest password Supabase accepts by default; below it, sign-up fails. */
const MIN_PASSWORD = 6;

/** A number is at most 11 digits here (`0300 1234567`), so the field refuses more. */
const MAX_PHONE_DIGITS = 11;

/** The code this build accepts until an SMS gateway is connected. */
const PLACEHOLDER_CODE = '123456';

const CODE_LENGTH = 6;

/** The resend clock, in seconds. The reference starts it at one minute. */
const RESEND_SECONDS = 60;

/** Ties the field or step that failed to the sentence explaining it. */
const ERROR_ID = 'credential-error';

export function CredentialSheet() {
  const { t } = useLocale();
  const { pendingReason, signIn, dismiss } = useSession();

  const [step, setStep] = useState<Step>('contact');
  const [contact, setContact] = useState('');
  const [code, setCode] = useState<string[]>(emptyCode);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  /**
   * The provider's own words, when it explained something the app cannot.
   *
   * "Email address is invalid" and "sign-ups are disabled" are not failures the
   * app can classify, and replacing them with "try again" tells a farmer to
   * repeat a step that cannot succeed. The sentence is shown as-is.
   */
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  /* Every request starts clean: the previous farmer's typed number is not reused. */
  useEffect(() => {
    if (!pendingReason) return;
    setStep('contact');
    setContact('');
    setCode(emptyCode());
    setPassword('');
    setName('');
    setError(null);
    setDetail(null);
    setBusy(false);
    setSecondsLeft(RESEND_SECONDS);
  }, [pendingReason]);

  /* The resend clock has to actually tick, one second at a time. */
  useEffect(() => {
    if (step !== 'otp' || secondsLeft === 0) return;
    const timer = window.setTimeout(() => setSecondsLeft((left) => Math.max(0, left - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [step, secondsLeft]);

  /* The first digit is where a farmer starts typing on the code step. */
  useEffect(() => {
    if (step !== 'otp') return;
    const timer = window.setTimeout(() => digitRefs.current[0]?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [step]);

  const channel: 'phone' | 'email' = isEmail(contact) ? 'email' : 'phone';

  /**
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

  /**
   * The contact is checked for shape here, not for existence.
   *
   * Existence is asked after the code, because asking it first would let the
   * sheet reveal which numbers have accounts without proving anything.
   */
  const continueFromContact = () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setDetail(null);
    setCode(emptyCode());
    setSecondsLeft(RESEND_SECONDS);
    setStep('otp');
  };

  const enterDigit = (index: number, raw: string) => {
    const typed = raw.replace(/[^0-9]/g, '');
    if (typed === '') {
      setCode((current) => current.map((digit, at) => (at === index ? '' : digit)));
      return;
    }

    setCode((current) => {
      const next = [...current];
      for (let at = 0; at < typed.length && index + at < CODE_LENGTH; at += 1) {
        next[index + at] = typed[at] ?? '';
      }
      return next;
    });

    const nextIndex = Math.min(CODE_LENGTH - 1, index + typed.length);
    digitRefs.current[nextIndex]?.focus();
    if (error) setError(null);
  };

  const onDigitKey = (index: number, key: string) => {
    if (key === 'Backspace' && code[index] === '' && index > 0) {
      digitRefs.current[index - 1]?.focus();
    } else if (key === 'ArrowLeft' && index > 0) {
      digitRefs.current[index - 1]?.focus();
    } else if (key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      digitRefs.current[index + 1]?.focus();
    }
  };

  const pasteCode = (text: string) => {
    const pasted = text.replace(/[^0-9]/g, '').slice(0, CODE_LENGTH);
    if (pasted === '') return;
    setCode(Array.from({ length: CODE_LENGTH }, (_, index) => pasted[index] ?? ''));
    digitRefs.current[Math.min(CODE_LENGTH - 1, pasted.length - 1)]?.focus();
    if (error) setError(null);
  };

  const resendCode = () => {
    setCode(emptyCode());
    setSecondsLeft(RESEND_SECONDS);
    setError(null);
    digitRefs.current[0]?.focus();
  };

  /**
   * The code, then the one question only the server can answer.
   *
   * This is the function to replace when a real OTP provider is connected: the
   * placeholder check and the countdown remain the UI's, and the existence check
   * already happens after verification.
   */
  const submitCode = useCallback(async () => {
    const entered = code.join('');
    if (entered.length < CODE_LENGTH) {
      setError('credential.otpIncomplete');
      return;
    }
    if (entered !== PLACEHOLDER_CODE) {
      setError('credential.otpWrong');
      return;
    }

    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      /* No backend: nothing knows whether the contact exists, so it is new. */
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
  }, [code, contact]);

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

  const title =
    step === 'otp'
      ? t('credential.otpTitle')
      : step === 'create'
        ? t('session.title')
        : t('credential.signIn');

  return (
    <Sheet
      open={pendingReason !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {/* Tall sheets — the contact step with a gate reason, and a phone in
          landscape — must scroll rather than push their button below the screen. */}
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] w-full max-w-[430px] overflow-y-auto pb-2"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-5 pt-1 pb-10">
          {/* Why an account is being asked for, in the words of the action that
              asked. Without it a farmer tapping "Send report" is shown a form and
              no explanation of what it has to do with their field. */}
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
              <Input
                id="credential-contact"
                type="text"
                inputMode="email"
                autoComplete="username"
                value={contact}
                onChange={(event) => onContactChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') continueFromContact();
                }}
                placeholder={t('credential.contactPlaceholder')}
                className="mt-2 h-12 rounded-xl px-4"
                aria-invalid={fieldOf(error) === 'contact'}
                aria-describedby={error ? ERROR_ID : undefined}
              />
            </div>
          ) : null}

          {step === 'otp' ? (
            <>
              <p className="text-body-sm text-muted-foreground">
                {t('credential.otpSentTo', { destination: contact.trim() })}
              </p>

              <button
                type="button"
                onClick={() => {
                  setStep('contact');
                  setCode(emptyCode());
                  setError(null);
                  setDetail(null);
                }}
                className="-mt-2 self-start rounded-full py-1 text-label text-brand"
              >
                {t('credential.otpChange')}
              </button>

              <div
                role="group"
                aria-label={t('credential.otpTitle')}
                className="grid grid-cols-6 gap-2"
                onPaste={(event) => {
                  event.preventDefault();
                  pasteCode(event.clipboardData.getData('text'));
                }}
              >
                {code.map((digit, index) => (
                  <input
                    // eslint-disable-next-line react/no-array-index-key -- one box per digit, fixed count
                    key={index}
                    ref={(element) => {
                      digitRefs.current[index] = element;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? 'one-time-code' : 'off'}
                    maxLength={1}
                    value={digit}
                    aria-label={t('credential.otpDigit', { index: String(index + 1) })}
                    onChange={(event) => enterDigit(index, event.target.value)}
                    onKeyDown={(event) => {
                      onDigitKey(index, event.key);
                      if (event.key === 'Enter') void submitCode();
                    }}
                    className="h-14 w-full min-w-0 rounded-xl border border-border bg-muted text-center text-title focus:border-brand focus:ring-2 focus:ring-brand/30 focus:outline-none"
                  />
                ))}
              </div>

              <div className="flex flex-col items-center gap-0.5">
                <p className="text-caption tabular-nums text-muted-foreground">
                  {formatCountdown(secondsLeft)}
                </p>
                <button
                  type="button"
                  onClick={resendCode}
                  disabled={secondsLeft > 0}
                  className="rounded-full py-1 text-body-sm text-muted-foreground disabled:opacity-50"
                >
                  {t('credential.otpResend')}
                </button>
              </div>

              <p className="text-center text-caption text-muted-foreground">
                {t('credential.otpHint')}
              </p>
            </>
          ) : null}

          {step === 'password' ? (
            <>
              <p className="text-body-sm text-muted-foreground">
                {t('credential.passwordPrompt', { contact: contact.trim() })}
              </p>
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
                  className="mt-2 h-12 rounded-xl px-4"
                  aria-invalid={fieldOf(error) === 'password'}
                  aria-describedby={error ? ERROR_ID : undefined}
                  readOnly={busy}
                />
              </div>
            </>
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
                  className="mt-2 h-12 rounded-xl px-4"
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
                  className="mt-2 h-12 rounded-xl px-4"
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
            <Button className="mt-4 h-12 rounded-full" onClick={continueFromContact}>
              {t('credential.continue')}
            </Button>
          ) : null}

          {step === 'otp' ? (
            <Button
              className="h-12 rounded-full"
              onClick={() => void submitCode()}
              disabled={busy}
            >
              {busy ? t('credential.checking') : t('credential.continue')}
            </Button>
          ) : null}

          {step === 'password' ? (
            <Button
              className="mt-4 h-12 rounded-full"
              onClick={() => void continueWithPassword()}
              disabled={busy}
            >
              {busy ? t('credential.signingIn') : t('credential.signIn')}
            </Button>
          ) : null}

          {step === 'create' ? (
            <Button
              className="mt-4 h-12 rounded-full"
              onClick={() => void continueWithNewAccount()}
              disabled={busy}
            >
              {busy ? t('credential.creating') : t('credential.create')}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One empty box per digit of the code. */
function emptyCode(): string[] {
  return Array.from({ length: CODE_LENGTH }, () => '');
}

/** `1:00`, then `0:59`, down to `0:00`. */
function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
  return /^[0-9\s()+\-.\u0660-\u0669\u06f0-\u06f9]*$/.test(raw);
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
 * this needs. It is asked only after the code, so the sheet cannot be used to
 * enumerate accounts without receiving a code.
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
