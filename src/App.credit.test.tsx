import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';

/**
 * Credit, driven through the screens.
 *
 * The unit suite proves the state machine; this proves the farmer's path through
 * it — that a counteroffer is shown as *what changed*, that accepting needs an
 * account, that accepting does not commit anything, and that a request cannot be
 * sent without consenting to what is on the screen.
 */

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

const signIn = () =>
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      account: {
        id: 'phone:03003333333',
        name: 'Bilal Ahmed',
        phone: '0300 3333333',
        email: null,
        method: 'phone',
        verifiedAt: Date.now(),
      },
      contextMigrated: true,
    }),
  );

describe('answering a counteroffer', () => {
  it('shows what the shop owner changed, and needs an account to accept', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'One request needs your answer' }));

    // The change is spelled out, not summarised.
    expect(await screen.findByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Amount Rs. 12,000 → Rs. 12,400')).toBeInTheDocument();
    expect(screen.getByText('Fee Rs. 0 → Rs. 300')).toBeInTheDocument();
    expect(screen.getByText('The shop owner changed the offer. Accepting agrees to offer v2.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Accept offer v2' }));

    // Identity-on-action: accepting credit is accountable, so it is gated.
    expect(await screen.findByText('Create your account')).toBeInTheDocument();
    expect(
      screen.getByText('Credit requests and answers are recorded against your account.'),
    ).toBeInTheDocument();
  });

  it('moves to final approval after the farmer accepts, without committing', async () => {
    signIn();
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'One request needs your answer' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer v2' }));

    expect(
      await screen.findByText(
        'You accepted. Only the shop owner’s final approval completes the agreement.',
      ),
    ).toBeInTheDocument();
    // Nothing is committed yet: there is no agreement block to read.
    expect(screen.queryByText(/^Agreement v/)).not.toBeInTheDocument();
  });
});

describe('sending a request', () => {
  /** The credit sheet itself; the Home card has a button with the same label. */
  const sheet = () => within(screen.getByRole('dialog'));

  const openForm = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Request credit' }));
    await userEvent.click(await sheet().findByRole('button', { name: 'Request credit' }));
  };

  it('refuses to send without consent, and sends with it', async () => {
    signIn();
    render(<App />);

    await openForm();
    // A different order from the one already awaiting an answer.
    await userEvent.click(await sheet().findByRole('button', { name: /Roundup herbicide/ }));
    await userEvent.click(sheet().getByRole('button', { name: 'Send request' }));

    // The rule, on the screen, before anything is recorded.
    expect(
      await screen.findByText('Tick the box to confirm the request as shown'),
    ).toBeInTheDocument();

    await userEvent.click(sheet().getByRole('checkbox'));
    await userEvent.click(sheet().getByRole('button', { name: 'Send request' }));

    expect(await sheet().findByText('Sent')).toBeInTheDocument();
    expect(
      sheet().getByText(
        'Sent. The shop owner reviews it in their own system — the answer appears here.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The seeded counteroffer is already live for the DAP order, which is the order
   * the form opens on — so the duplicate rule is reachable without any setup.
   */
  it('refuses a second live request for the same order', async () => {
    signIn();
    render(<App />);

    await openForm();
    await userEvent.click(await sheet().findByRole('checkbox'));
    await userEvent.click(sheet().getByRole('button', { name: 'Send request' }));

    expect(
      await screen.findByText('There is already an open credit request for this order'),
    ).toBeInTheDocument();
  });
});
