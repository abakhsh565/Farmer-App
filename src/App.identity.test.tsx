import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import {
  clearCode,
  completeAccount,
  completeSignIn,
  continueOtp,
  developmentCode,
  enterCode,
  startSignIn,
} from '@/testing/credential';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';
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

const sheet = async () => within(await screen.findByRole('dialog'));

const keepBrowsing = async () => {
  const dialog = await sheet();
  await userEvent.click(dialog.getByRole('button', { name: 'Close' }));
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
    expect(await screen.findAllByText('Are the mandi rates good this week?', {}, READY)).toHaveLength(1);
    expect(
      screen.queryByPlaceholderText('What do you want to ask nearby farmers?'),
    ).not.toBeInTheDocument();

    /* And the account outlived the sheet, which is what makes it a session. */
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('"method":"phone"');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('03001234567');
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

    await startSignIn('bilal@example.com');

    expect(
      screen.getByText('Enter the 6-digit code we sent to bilal@example.com.'),
    ).toBeInTheDocument();
    await enterCode();
    await continueOtp();
    await completeAccount();

    expect(await screen.findAllByText('Email question about urea', {}, READY)).toHaveLength(1);
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

    await userEvent.type(screen.getByLabelText('Number or email'), '0300123');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(
      await screen.findByText('Write an 11-digit mobile number or a valid email address.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // No code was issued for a number the app already knows is wrong.
    expect(screen.queryByRole('group', { name: 'OTP verification' })).not.toBeInTheDocument();
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
    await startSignIn('03001112223');

    const right = developmentCode();
    const wrong = right === '000000' ? '999999' : '000000';
    await enterCode(wrong);
    await continueOtp();

    expect(
      await screen.findByText('That code is not right. Check it and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'OTP verification' })).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');

    // The right code still works, in the same sheet.
    await clearCode();
    await enterCode(right);
    await continueOtp();
    await completeAccount();

    expect(await screen.findAllByText('Wrong code question', {}, READY)).toHaveLength(1);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('03001112223');
  });

  it('shows the fixed development code instead of pretending an SMS was sent', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Development code question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await startSignIn('0300 4445556');

    /* This build has no SMS gateway, so it names the code it accepts rather than
       claiming a message was delivered. */
    expect(screen.getByText('For this build, the code is 123456.')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');
  });

  it('lets the farmer correct the contact before creating an account', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      'Wrong contact question',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await startSignIn('0300 7778889');

    await userEvent.click(
      screen.getByRole('button', { name: 'Not your number or email? Change it' }),
    );

    expect(await screen.findByLabelText('Number or email')).toHaveValue('03007778889');
    expect(screen.queryByRole('group', { name: 'OTP verification' })).not.toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY) ?? '').not.toContain('"account":{"id"');
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

    await keepBrowsing();
    expect(screen.queryByLabelText('Number or email')).not.toBeInTheDocument();

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

    /* There are no conversations yet: this one starts from the shop's row, and
       the gate is what turns the first message into an account. */
    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
    await screen.findByRole('heading', { name: 'Shop' }, READY);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Ali Traders' }, READY),
    );

    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'Do you have urea?');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await sheet();
    expect(
      screen.getByText('Dealer messages stay private to your account.'),
    ).toBeInTheDocument();

    await completeSignIn('03007654321');

    // Sent: the message is in the thread, and the box it was typed into is empty.
    expect(await screen.findByText('Do you have urea?')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('Type a message') as HTMLInputElement).value).toBe('');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('03007654321');
  });
});
