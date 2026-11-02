import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { createServices, type Services } from '@/services/registry';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';
import type { OtpProvider, OtpRequest, OtpVerifyResult } from '@/services/types';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * Identity-on-action, driven the way a farmer hits it.
 *
 * The locked rule is two-sided, so both sides are asserted here: browsing never
 * asks for an account, and the first accountable write does — once, with the
 * reason, without losing the thing the farmer was doing.
 *
 * Two things about this suite are deliberate, and both come from getting it wrong
 * first:
 *
 * · Signing in means *completing verification*. An earlier version of these tests
 *   stopped after the number was typed and then asserted the draft text was on
 *   the screen — which it was, still sitting in the composer. The test passed
 *   while proving nothing. The assertions below are about the state after the
 *   gate has actually been satisfied: the sheet closed, the account stored, the
 *   action resumed *and finished*.
 *
 * · The failure paths are driven through the real sheet. A provider that issues
 *   an already-expired code, and one that cannot be reached, are how "expired" and
 *   "network" are exercised here rather than being asserted from a unit test and
 *   assumed to be wired up.
 */

const POST1 =
  "Should I water this week? It's been raining on and off, not sure if the field needs more.";

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

const READY = { timeout: 4000 };

const openCommunity = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Community' }));
  await screen.findByText(POST1, {}, READY);
};

const sheet = () => screen.findByText('Create your account');

/** The code the development provider issued, read off the sheet it prints it on. */
const developmentCode = (): string => {
  const hint = screen.getByText(/Development build — the code is/).textContent ?? '';
  const match = hint.match(/(\d{3,8})/);
  if (!match?.[1]) throw new Error('the development sheet did not show a code');
  return match[1];
};

const startSignIn = async (number: string) => {
  await userEvent.type(screen.getByLabelText('Mobile number'), number);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Code');
};

const completeSignIn = async (number: string) => {
  await startSignIn(number);
  await userEvent.type(screen.getByLabelText('Code'), developmentCode());
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
};

describe('guest-first browsing', () => {
  it('lets a guest read the feed and open a thread without asking for an account', async () => {
    render(<App />);
    await openCommunity();

    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: new RegExp('Should I water this week') }),
    );
    expect(screen.getByText(POST1)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write a reply')).toBeInTheDocument();
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();
  });
});

describe('the identity gate', () => {
  it('asks once, for the right reason, and publishes the post after sign-in', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    const box = await screen.findByPlaceholderText('What do you want to ask nearby farmers?');
    await userEvent.type(box, 'Are the mandi rates good this week?');
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    await sheet();
    expect(
      screen.getByText('Posting to Community needs an account, so replies can reach you.'),
    ).toBeInTheDocument();

    await completeSignIn('0300 1234567');

    /*
     * The post the farmer wrote, and it is a *post*: one of them on the screen,
     * with the composer gone. Asserting "the text is somewhere" was how the first
     * version of this test managed to pass without publishing anything.
     */
    expect(await screen.findAllByText('Are the mandi rates good this week?')).toHaveLength(1);
    expect(
      screen.queryByPlaceholderText('What do you want to ask nearby farmers?'),
    ).not.toBeInTheDocument();

    /* And the account outlived the sheet, which is what makes it a session. */
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('"method":"phone"');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('0300 1234567');
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();
  });

  it('creates the account by email too, with the same code step', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Email question about urea',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await sheet();

    await userEvent.click(screen.getByRole('radio', { name: 'Email' }));
    await userEvent.type(screen.getByLabelText('Email'), 'bilal@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('We sent a code to bilal@example.com')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Code'), developmentCode());
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findAllByText('Email question about urea')).toHaveLength(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('bilal@example.com');
  });

  it('refuses an incomplete number without creating an account', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Question for the group',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await sheet();

    await userEvent.type(screen.getByLabelText('Mobile number'), '0300123');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('A Pakistani mobile number is 11 digits, like 0300 1234567'),
    ).toBeInTheDocument();
    expect(screen.getByText('Create your account')).toBeInTheDocument();
    // No code was sent for a number the app already knows is wrong.
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).not.toContain('0300123');
  });

  it('says a wrong code is wrong, and lets the farmer try again', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Wrong code question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await startSignIn('0300 1112223');

    const right = developmentCode();
    const wrong = right === '000000' ? '999999' : '000000';
    await userEvent.type(screen.getByLabelText('Code'), wrong);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(
      await screen.findByText('That code is not right. Check it and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');

    // The right code still works, in the same sheet.
    await userEvent.clear(screen.getByLabelText('Code'));
    await userEvent.type(screen.getByLabelText('Code'), right);
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findAllByText('Wrong code question')).toHaveLength(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('0300 1112223');
  });

  it('tells the farmer a code expired instead of calling it wrong', async () => {
    render(<App services={withOtp(shortLivedOtp)} />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Expired code question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await startSignIn('0300 4445556');

    /* The code was valid when it arrived and lapses while the farmer is typing,
       which is the real shape of this failure. */
    await userEvent.type(screen.getByLabelText('Code'), '123456');
    await new Promise((resolve) => setTimeout(resolve, 1_400));

    /*
     * Who notices the lapse first is a race between the sheet's one-second
     * countdown and the farmer's tap, and both orders are the product working:
     * sometimes the screen has already offered a new code by the time the tap
     * lands, sometimes the tap is what discovers the expiry. Asserting one order
     * made this test a check on the scheduler; it is a check on the screen now.
     */
    const verify = screen.queryByRole('button', { name: 'Verify' });
    if (verify) await userEvent.click(verify);

    expect(
      await screen.findByText('That code has expired. Send a new one.'),
    ).toBeInTheDocument();
    /* Answered from the clock: a code with no time left does not need a round trip
       to the provider to be refused, and the farmer should not wait for one. */
    expect(shortLivedOtp.verifyCalls).toBe(0);
    /* The only way on is a new code, so the resend is promoted to the primary
       control rather than leaving a Verify button that cannot succeed. */
    expect(screen.getByRole('button', { name: /Send a new code/ })).toBeEnabled();
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');
  });

  it('returns to the number when the code could not be sent at all', async () => {
    render(<App services={withOtp(unreachableOtp)} />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Unreachable question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    await userEvent.type(screen.getByLabelText('Mobile number'), '0300 7778889');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Could not reach the server. Try again.')).toBeInTheDocument();
    /* No code was sent, so there is no code box to fill in — the farmer retries
       the send from where they are. */
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    expect(screen.getByText('Create your account')).toBeInTheDocument();
  });

  it('lets the farmer keep browsing, with the draft still in the box', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Half-written question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await sheet();

    await userEvent.click(screen.getByRole('button', { name: 'Not now — keep browsing' }));
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    // No account was created…
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');

    // …the composer is still open, and the words are exactly where they were.
    const box = (await screen.findByPlaceholderText(
      'What do you want to ask nearby farmers?',
    )) as HTMLTextAreaElement;
    expect(box.value).toBe('Half-written question');
  });

  it('sends a dealer message only after the sign-in it asked for', async () => {
    render(<App />);

    /* There are no conversations yet: this one starts from the shop's row on
       Home, and the gate is what turns the first message into an account. */
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Ali Traders' }, READY),
    );

    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'Do you have urea?');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await sheet();
    expect(
      screen.getByText('Dealer messages stay private to your account.'),
    ).toBeInTheDocument();

    await completeSignIn('0300 7654321');

    // Sent: the message is in the thread, and the box it was typed into is empty.
    expect(await screen.findByText('Do you have urea?')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('Type a message') as HTMLInputElement).value).toBe('');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('0300 7654321');
  });
});

/* ── providers that misbehave, so the failure screens are reachable ───────── */

function withOtp(otp: OtpProvider): Services {
  return { ...createServices(), otp };
}

/**
 * Issues a code that lapses a moment after it arrives, and counts whether it was
 * ever asked to verify anything.
 */
const shortLivedOtp: OtpProvider & { verifyCalls: number } = {
  name: 'Short-lived-code provider',
  status: 'development',
  verifyCalls: 0,
  async request(): Promise<OtpRequest> {
    return {
      channel: 'phone',
      destination: '0300 4445556',
      deliveredVia: 'test',
      expiresAt: Date.now() + 1_200,
      resendAfterSeconds: 0,
      developmentCode: '123456',
    };
  },
  async verify(): Promise<OtpVerifyResult> {
    this.verifyCalls += 1;
    return { ok: true };
  },
};

/** Cannot be reached at all. */
const unreachableOtp: OtpProvider = {
  name: 'Unreachable provider',
  status: 'failing',
  async request(): Promise<OtpRequest> {
    throw new Error('network down');
  },
  async verify(): Promise<OtpVerifyResult> {
    throw new Error('network down');
  },
};
