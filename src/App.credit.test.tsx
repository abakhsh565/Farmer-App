import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

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
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

const ACCOUNT_ID = 'phone:03003333333';

const signIn = () =>
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      account: {
        id: ACCOUNT_ID,
        name: 'Bilal Ahmed',
        phone: '0300 3333333',
        email: null,
        method: 'phone',
        verifiedAt: Date.now(),
      },
      contextMigrated: true,
    }),
  );

/**
 * A live counteroffer waiting on the farmer — the state the answer flow is
 * about. The product no longer ships a fixture like this, so the test brings its
 * own: v1 is what the farmer proposed, v2 is the shop owner's one counter, and
 * nothing is agreed until the shop owner's final approval.
 */
const withCounteroffer = (owner = ''): void => {
  const now = Date.now();
  localStorage.setItem(
    `agri-shop.credit${owner ? `.${owner}` : ''}`,
    JSON.stringify({
      requests: [
        {
          id: 'credit-order-dap-1',
          orderId: 'order-dap-1',
          dealerKey: 'dealer.aliTraders',
          productKey: 'product.dap',
          status: 'awaiting_farmer_decision',
          terms: [
            {
              version: 1,
              source: 'farmer',
              amount: 12_000,
              dueKey: 'credit.due.afterHarvest',
              fee: 0,
              feeNoteKey: null,
            },
            {
              version: 2,
              source: 'shop_owner',
              amount: 12_400,
              dueKey: 'credit.due.december',
              fee: 300,
              feeNoteKey: 'credit.fee.service',
            },
          ],
          consents: [{ actor: 'farmer', termsVersion: 1, at: now - 86_400_000 }],
          events: [],
          counterofferUsed: true,
          createdAt: now - 86_400_000,
          expiresAt: now + 5 * 86_400_000,
        },
      ],
      agreements: [],
    }),
  );
};

describe('answering a counteroffer', () => {
  it('shows the account holder what the shop owner changed', async () => {
    signIn();
    withCounteroffer(ACCOUNT_ID);
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'One request needs your answer' }));

    // The change is spelled out, not summarised.
    expect(await screen.findByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Amount Rs. 12,000 → Rs. 12,400')).toBeInTheDocument();
    expect(screen.getByText('Fee Rs. 0 → Rs. 300')).toBeInTheDocument();
    expect(screen.getByText('The shop owner changed the offer. Accepting agrees to offer v2.')).toBeInTheDocument();

    // The answer is available to the account that holds the request.
    expect(screen.getByRole('button', { name: 'Accept offer v2' })).toBeEnabled();
  });

  it('moves to final approval after the farmer accepts, without committing', async () => {
    signIn();
    withCounteroffer(ACCOUNT_ID);
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
    await userEvent.click(screen.getByRole('button', { name: 'Your shops and history' }));
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
   * The live counteroffer is for the DAP order, which is the order the form opens
   * on — so the duplicate rule is reachable the moment the farmer submits what
   * the form already shows.
   */
  it('refuses a second live request for the same order', async () => {
    signIn();
    withCounteroffer(ACCOUNT_ID);
    render(<App />);

    await openForm();
    await userEvent.click(await sheet().findByRole('checkbox'));
    await userEvent.click(sheet().getByRole('button', { name: 'Send request' }));

    expect(
      await screen.findByText('There is already an open credit request for this order'),
    ).toBeInTheDocument();
  });
});
