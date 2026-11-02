import { ArrowLeft, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import {
  canResend,
  codeSent,
  hasExpired,
  initialOtpState,
  otpErrorKey,
  otpFailureOf,
  requestFailed,
  requestStarted,
  resetOtpState,
  secondsUntilResend,
  verifyFailed,
  verifyStarted,
  verifySucceeded,
  type OtpState,
} from '@/services/otpFlow';
import { useServicesOrDefault } from '@/services/registry';
import type { OtpChannel } from '@/services/types';
import { useSession } from './SessionProvider';
import { validateContact } from './store';

/**
 * The sheet that turns a gated action into an account, without losing the action.
 *
 * It is one component for every gate in the product — posting, replying, sending
 * a message, asking for credit, asking for a field visit — because the promise is
 * identical each time: *this* is why an account is needed, *this* is who will see
 * it, and the thing you were doing is still waiting behind the sheet when you
 * finish. The reason differs; the contract does not.
 *
 * The account is now created the way a real one is: a code is sent, the farmer
 * enters it, and only then is there a session. The machine behind the screen is
 * `services/otpFlow`, and the sheet's job is to show exactly what it knows —
 * which is why "expired" and "wrong code" are two different sentences, why the
 * resend control is a countdown rather than a button that always looks ready, and
 * why a send that never reached the provider returns to the number/address step
 * instead of a code box nobody can fill.
 *
 * In development no SMS is sent and the code is shown on the sheet, labelled as a
 * development build. Presenting a mock login as a real one is the exact failure
 * the project rules call out; the honest fix is to say so.
 */
export function IdentitySheet() {
  const { t } = useLocale();
  const { pendingReason, signIn, dismiss } = useSession();
  /* The default rather than the strict lookup: without an OTP provider nothing in
     the app can be written to, so a missing one must not take the sheet down. */
  const { otp: provider } = useServicesOrDefault();

  const [method, setMethod] = useState<OtpChannel>('phone');
  const [contact, setContact] = useState('');
  const [name, setName] = useState('');
  const [contactError, setContactError] = useState<MessageKey | null>(null);

  const [otp, setOtp] = useState<OtpState>(() => initialOtpState());
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());

  /* Every gate is a fresh request: the previous attempt's digits are not reused. */
  useEffect(() => {
    if (pendingReason) {
      setMethod('phone');
      setContact('');
      setName('');
      setContactError(null);
      setCode('');
      setOtp(initialOtpState());
    }
  }, [pendingReason]);

  /* The countdown on the resend control has to actually count down. */
  useEffect(() => {
    if (otp.phase !== 'awaiting_code') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [otp.phase]);

  const onCodeStep = otp.phase === 'awaiting_code' || otp.phase === 'verifying';
  const busy = otp.phase === 'sending' || otp.phase === 'verifying';
  const expired = onCodeStep && hasExpired(otp, now);
  const resendReady = canResend(otp, now);
  const resendIn = secondsUntilResend(otp, now);

  const send = useCallback(
    async (channel: OtpChannel, destination: string) => {
      setOtp((current) => requestStarted(current));
      try {
        const sent = await provider.request(channel, destination);
        setCode('');
        setNow(Date.now());
        setOtp((current) =>
          codeSent(
            current,
            {
              expiresAt: sent.expiresAt,
              resendAfterSeconds: sent.resendAfterSeconds,
              developmentCode: sent.developmentCode,
            },
            Date.now(),
          ),
        );
      } catch (failure) {
        const { error, detail } = otpFailureOf(failure);
        setOtp((current) => requestFailed(current, error, detail));
      }
    },
    [provider],
  );

  const submitContact = () => {
    const problem = validateContact(method, contact);
    if (problem) {
      setContactError(problem);
      return;
    }
    setContactError(null);
    void send(method, contact.trim());
  };

  const submitCode = async () => {
    const entered = code.replace(/[^0-9]/g, '');
    /*
     * Checked against the clock before the network: if the code's window has
     * passed, the answer is already known, and asking the provider would only
     * delay a sentence the farmer needs now.
     */
    if (hasExpired(otp, Date.now())) {
      setOtp((current) => verifyFailed(current, 'expired'));
      return;
    }

    setOtp((current) => verifyStarted(current));
    try {
      const result = await provider.verify(method, contact.trim(), entered);
      if (result.ok) {
        setOtp((current) => verifySucceeded(current));
        /*
         * The session now exists, so the actor behind it can be asked for. This is
         * the exchange that makes the account a real one: the party id is what the
         * database matches every row-level policy against, and it is asked for
         * here rather than trusted from the contact the farmer typed.
         */
        const identity = (await provider.identity?.()) ?? null;
        /* The account is created only now, with a verified contact. */
        const signedIn = signIn({ method, contact, name, partyId: identity?.partyId ?? null });
        if (!signedIn.ok) setContactError(signedIn.error);
        return;
      }
      setOtp((current) => verifyFailed(current, result.reason));
    } catch (failure) {
      const { error, detail } = otpFailureOf(failure);
      setOtp((current) => requestFailed(current, error, detail));
    }
  };

  const backToContact = () => {
    setOtp((current) => resetOtpState(current));
    setCode('');
    setContactError(null);
  };

  const errorKey = useMemo<MessageKey | null>(() => {
    if (contactError) return contactError;
    if (otp.error) return otpErrorKey(otp.error);
    if (expired) return 'otp.expired';
    return null;
  }, [contactError, otp.error, expired]);

  /* A code that expired or ran out of attempts cannot be retried: the only way on
     is a new code, so the primary control becomes the resend. */
  const mustResend =
    onCodeStep &&
    (expired || otp.error === 'expired' || otp.error === 'too_many_attempts');

  return (
    <Sheet
      open={pendingReason !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t(onCodeStep ? 'otp.title' : 'session.title')}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-3 p-4 pt-0">
          {pendingReason ? (
            <p className="flex gap-2 rounded-md bg-brand-soft px-3 py-2.5 text-body-sm text-brand">
              <ShieldCheck className="size-4 shrink-0" aria-hidden />
              {t(pendingReason)}
            </p>
          ) : null}

          {onCodeStep ? (
            <>
              <p className="text-body-sm text-muted-foreground">
                {t('otp.sentTo', { destination: contact.trim() })}
              </p>

              <div>
                <Label htmlFor="session-code" className="text-label text-muted-foreground">
                  {t('otp.codeLabel')}
                </Label>
                <Input
                  id="session-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  /* Clearing the error on the first keystroke: a stale "not right"
                     under a box being retyped is noise, not information. */
                  onChange={(event) => {
                    setCode(event.target.value.replace(/[^0-9]/g, ''));
                    if (otp.error) setOtp((current) => ({ ...current, error: null }));
                  }}
                  className="mt-1.5 h-12 text-center text-title"
                  aria-describedby={errorKey ? 'session-code-error' : undefined}
                />
              </div>

              {otp.developmentCode ? (
                <p className="rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
                  {t('otp.developmentHint', { code: otp.developmentCode })}
                </p>
              ) : null}

              {/*
                The provider's own words, kept alongside the app's sentence rather
                than replacing it. The classified line is what the farmer acts on;
                the detail is what tells them (or us) that the failure was a
                missing SMS provider rather than their connection.
              */}
              {otp.detail ? (
                <p className="rounded-md bg-muted px-3 py-2.5 text-caption text-muted-foreground">
                  {otp.detail}
                </p>
              ) : null}

              {errorKey ? (
                <p
                  id="session-code-error"
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
                >
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {t(errorKey)}
                </p>
              ) : null}

              {mustResend ? (
                <Button className="h-12 rounded-full" onClick={() => void send(method, contact.trim())} disabled={!resendReady}>
                  <RefreshCw className="size-4" aria-hidden />
                  {resendReady ? t('otp.resend') : t('otp.resendIn', { seconds: resendIn })}
                </Button>
              ) : (
                <Button
                  className="h-12 rounded-full"
                  onClick={() => void submitCode()}
                  disabled={busy || code.length === 0}
                >
                  {t('otp.verify')}
                </Button>
              )}

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={backToContact}
                  className="flex items-center gap-1.5 rounded-full py-2 text-body-sm text-muted-foreground"
                >
                  {/* Going back is a direction: left in English, right in Urdu. */}
                  <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
                  {t('otp.change')}
                </button>
                {/* The resend is the primary control once the code has expired or
                    the attempts are gone, so it is not offered twice there. */}
                {mustResend ? null : (
                  <button
                    type="button"
                    onClick={() => void send(method, contact.trim())}
                    disabled={!resendReady || busy}
                    className="rounded-full py-2 text-body-sm text-muted-foreground disabled:opacity-50"
                  >
                    {resendReady ? t('otp.resend') : t('otp.resendIn', { seconds: resendIn })}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <ToggleGroup
                type="single"
                variant="brand"
                value={method}
                onValueChange={(next) => {
                  if (next) {
                    setMethod(next as OtpChannel);
                    setContact('');
                    setContactError(null);
                    setOtp(initialOtpState(next as OtpChannel));
                  }
                }}
                className="w-full"
              >
                <ToggleGroupItem value="phone" className="h-11 flex-1">
                  {t('session.method.phone')}
                </ToggleGroupItem>
                <ToggleGroupItem value="email" className="h-11 flex-1">
                  {t('session.method.email')}
                </ToggleGroupItem>
              </ToggleGroup>

              <div>
                <Label htmlFor="session-contact" className="text-label text-muted-foreground">
                  {t(method === 'phone' ? 'session.phone' : 'session.email')}
                </Label>
                <Input
                  id="session-contact"
                  type={method === 'phone' ? 'tel' : 'email'}
                  inputMode={method === 'phone' ? 'tel' : 'email'}
                  autoComplete={method === 'phone' ? 'tel' : 'email'}
                  value={contact}
                  onChange={(event) => {
                    setContact(event.target.value);
                    if (contactError) setContactError(null);
                  }}
                  placeholder={method === 'phone' ? '0300 0000000' : 'name@example.com'}
                  className="mt-1.5 h-11"
                />
              </div>

              <div>
                <Label htmlFor="session-name" className="text-label text-muted-foreground">
                  {t('session.name')}
                </Label>
                <Input
                  id="session-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('session.namePlaceholder')}
                  className="mt-1.5 h-11"
                />
              </div>

              {errorKey ? (
                <p
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
                >
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {t(errorKey)}
                </p>
              ) : null}

              {otp.detail ? (
                <p className="rounded-md bg-muted px-3 py-2.5 text-caption text-muted-foreground">
                  {otp.detail}
                </p>
              ) : null}

              <Button className="h-12 rounded-full" onClick={submitContact} disabled={busy}>
                {otp.phase === 'sending' ? t('otp.title') : t('session.continue')}
              </Button>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full py-2 text-body-sm text-muted-foreground"
              >
                {t('session.notNow')}
              </button>

              {/*
                Which sentence is true is decided by the provider, not by the build
                label. A provider that can establish a real session sends a real
                code, and telling that farmer the account is phone-only would be a
                lie about where their saved location is kept.
              */}
              <p className="text-caption leading-relaxed text-muted-foreground">
                {provider.identity ? t('session.liveNote') : t('session.demoNote')}
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
