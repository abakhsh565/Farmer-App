import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { resetPersistence } from '@/services/persistence';

/**
 * Two journeys that cross several screens each, driven from the outside.
 *
 * The field visit is the one flow that starts at a shop and ends at the dealer's
 * own answer, so it is the flow that proves the gate, the request, the dealer's
 * decision and the record all agree. The sign-out journey is the one that proves
 * the documents belong to an *account* rather than to a phone: a farmer who signs
 * out leaves their work behind, and gets it back by signing in again.
 */

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  resetPersistence();
  vi.restoreAllMocks();
});

const READY = { timeout: 5000 };

/** The code the development provider issued, read off the sheet it prints it on. */
const developmentCode = (): string => {
  const hint = screen.getByText(/Development build — the code is/).textContent ?? '';
  const match = hint.match(/(\d{3,8})/);
  if (!match?.[1]) throw new Error('the development sheet did not show a code');
  return match[1];
};

const signIn = async (number: string) => {
  await userEvent.type(screen.getByLabelText('Mobile number'), number);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Code');
  await userEvent.type(screen.getByLabelText('Code'), developmentCode());
  await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
};

/**
 * The first header control on Home is the farmer's own avatar, so the profile is
 * reached from Home rather than from whichever tab the farmer happens to be on.
 */
const openProfile = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Home' }));
  const header = await screen.findByRole('banner');
  await userEvent.click(header.querySelectorAll('button')[0] as HTMLElement);
  await screen.findByText('Farm Details', {}, READY);
};

const openDealer = async (name: string) => {
  await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }, READY));
};

describe('the field-visit journey', () => {
  it('asks for an account, sends the request, records the dealer’s answer, and survives a restart', async () => {
    const first = render(<App />);

    await openDealer('Ali Traders');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Request a field visit' }, READY),
    );

    /* A visit goes to one shop and is answered by a person, so it is accountable
       like every other write — gated, with the reason, and not lost. */
    expect(await screen.findByText('Create your account')).toBeInTheDocument();
    expect(
      screen.getByText(
        'A field visit request goes to a specific shop, so it needs your account.',
      ),
    ).toBeInTheDocument();

    await signIn('0300 9998887');

    expect(
      await screen.findByText('Field visit requested · waiting for an answer'),
    ).toBeInTheDocument();

    // The dealer answers. That is a change to the record, not a toast.
    await userEvent.click(screen.getByRole('button', { name: 'Dealer accepts' }));
    expect(await screen.findByText('Field visit accepted')).toBeInTheDocument();
    expect(screen.getByText('The dealer will call you to fix a day.')).toBeInTheDocument();

    /* The restart: the visit belongs to the account, so it is still there — and
       still accepted, because the dealer's answer is part of it. */
    first.unmount();
    render(<App />);
    await openDealer('Ali Traders');
    expect(await screen.findByText('Field visit accepted', {}, READY)).toBeInTheDocument();
  });
});

describe('signing out and back in', () => {
  it('leaves the account’s work behind on sign-out, and returns it on sign-in', async () => {
    const post = 'Cotton ke daam kab theek honge?';
    const first = render(<App />);

    // Write something as a guest: the gate turns it into an account and publishes.
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Write a post' }, READY));
    await userEvent.type(
      await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
      post,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    await screen.findByText('Create your account');
    await signIn('0300 2223334');

    expect(await screen.findAllByText(post)).toHaveLength(1);

    // Sign out from the profile.
    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    expect(await screen.findByText('Signed out. Your crops stay on this phone.')).toBeInTheDocument();

    /* As a guest the feed is the phone's own document again — the account's post
       is not left lying on a shared phone. */
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    await screen.findByRole('button', { name: 'Write a post' }, READY);
    expect(screen.queryByText(post)).not.toBeInTheDocument();

    /* The restart, as a guest, and then the same farmer signing in again on the
       same phone: their work comes back with the account. */
    first.unmount();
    render(<App />);
    await openProfile();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }, READY),
    );
    await signIn('0300 2223334');

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(await screen.findAllByText(post, {}, READY)).toHaveLength(1);
  });
});
