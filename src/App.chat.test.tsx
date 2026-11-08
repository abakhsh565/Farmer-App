import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { completeSignIn } from '@/testing/credential';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The dealer conversations, driven the way a farmer drives them.
 *
 * Chat used to live in `App`'s own state, which meant every message a farmer sent
 * was gone the moment the app was reopened. These tests are about the property
 * that replaced it: the conversations are a document on the service layer, so they
 * survive a restart, they migrate into the account when the farmer signs in, and a
 * shop they have never written to gets an empty conversation rather than somebody
 * else's words.
 */

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

const READY = { timeout: 5000 };

/**
 * A phone that already carries these conversations, so the tests below are about
 * reading, searching and continuing history rather than about where the history
 * came from. The product starts a farmer with none.
 */
const withHistory = (): void => {
  localStorage.setItem(
    'agri-shop.chat',
    JSON.stringify({
      version: 1,
      threads: {
        'dealer.aliTraders': [
          { id: 1, from: 'me', key: 'chat.msg1' },
          { id: 2, from: 'dealer', key: 'chat.msg2' },
          { id: 3, from: 'dealer', key: 'chat.preview.ali' },
        ],
        'dealer.greenAgro': [{ id: 1, from: 'dealer', key: 'chat.preview.greenAgro' }],
        'dealer.wazirabadAgri': [{ id: 1, from: 'dealer', key: 'chat.preview.wazirabad' }],
        'dealer.malikFertilizers': [{ id: 1, from: 'dealer', key: 'chat.preview.malik' }],
      },
      unread: { 'dealer.aliTraders': 2 },
    }),
  );
};

const openChat = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
  await screen.findByRole('heading', { name: 'Messages' }, READY);
};

const signIn = completeSignIn;

const openAli = async () => {
  await userEvent.click(
    await screen.findByRole('button', { name: /Open conversation with Ali Traders/ }, READY),
  );
};

describe('chat', () => {
  it('reads a conversation without asking for an account, and the badge clears', async () => {
    withHistory();
    render(<App />);
    await openChat();

    // Two messages were waiting, and the list says so.
    expect(
      screen.getByRole('button', { name: /Ali Traders — 2 unread messages/ }),
    ).toBeInTheDocument();

    await openAli();
    expect(screen.getByText(/Roundup available/)).toBeInTheDocument();
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    // Read once, and it stays read: the badge is gone from the list.
    const row = screen.getByRole('button', { name: /Open conversation with Ali Traders/ });
    expect(row.getAttribute('aria-label')).not.toContain('unread');
  });

  it('starts an empty conversation with a shop the farmer has never written to', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Punjab Seed Corner' }, READY),
    );

    /* The thread is this shop's and empty. It used to be seeded with Ali Traders'
       messages, which put words in a shop's mouth the first time a farmer wrote
       to them. */
    expect(screen.getByText('No messages yet — say salam and ask what you need.')).toBeInTheDocument();
    expect(screen.queryByText(/Roundup available/)).not.toBeInTheDocument();
  });

  it('keeps what was sent after the app is reopened, and carries the history into the account', async () => {
    withHistory();
    const first = render(<App />);
    await openChat();
    await openAli();

    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'Two bags of urea please');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Sending is accountable, so it is gated — and the send is what resumes.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await signIn('0300 5556667');

    expect(await screen.findByText('Two bags of urea please')).toBeInTheDocument();
    expect((screen.getByPlaceholderText('Type a message') as HTMLTextAreaElement).value).toBe('');

    /* The restart. A new app instance, the same phone: the signed-in farmer opens
       the conversation and both the history and their own message are still in it. */
    first.unmount();
    render(<App />);
    await openChat();
    await openAli();

    expect(await screen.findByText(/Roundup available/)).toBeInTheDocument();
    expect(screen.getByText('Two bags of urea please')).toBeInTheDocument();
  });

  it('searches the conversations, and says so when nothing matches', async () => {
    withHistory();
    render(<App />);
    await openChat();

    const search = screen.getByLabelText('Search conversations');
    await userEvent.type(search, 'green');

    expect(screen.getByRole('button', { name: /Open conversation with Green Agro/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open conversation with Ali Traders/ }),
    ).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');

    // An empty result is a different sentence from an empty inbox.
    expect(screen.getByText('No conversations match')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
  });
});
