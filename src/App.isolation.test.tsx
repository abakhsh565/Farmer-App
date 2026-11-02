import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The reported failure, asserted end to end: two farmers on one phone.
 *
 * A farmer signs out; the next person to pick up the phone must not find the
 * previous farmer's name, phone, conversations or credit — and the farmer who
 * signs back in must get their own work back. This suite drives the real
 * screens, the real gate and the real stores; no fixture is presented as a
 * farmer's own data anywhere.
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

/** The first header control on Home is the farmer's own avatar. */
const openProfile = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Home' }));
  const header = await screen.findByRole('banner');
  await userEvent.click(header.querySelectorAll('button')[0] as HTMLElement);
  await screen.findByText('Farm Details', {}, READY);
};

const openChat = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
  await screen.findByRole('heading', { name: 'Messages' }, READY);
};

/**
 * The first farmer's credit book, as it would be on this phone after they had
 * used the app: one accepted agreement with ten thousand still outstanding. It
 * is written under the *account's* key, because that is where an account's
 * document lives.
 */
const withCreditFor = (ownerId: string): void => {
  const now = Date.now();
  localStorage.setItem(
    `agri-shop.credit.${ownerId}`,
    JSON.stringify({
      requests: [
        {
          id: 'credit-order-urea-1',
          orderId: 'order-urea-1',
          dealerKey: 'dealer.aliTraders',
          productKey: 'product.urea',
          status: 'accepted',
          terms: [
            {
              version: 1,
              source: 'farmer',
              amount: 10_000,
              dueKey: 'credit.due.afterHarvest',
              fee: 0,
              feeNoteKey: null,
            },
          ],
          consents: [{ actor: 'farmer', termsVersion: 1, at: now - 86_400_000 }],
          events: [],
          counterofferUsed: false,
          createdAt: now - 86_400_000,
          expiresAt: null,
        },
      ],
      agreements: [
        {
          requestId: 'credit-order-urea-1',
          termsVersion: 1,
          farmerConsentAt: now - 86_400_000,
          shopOwnerApprovedAt: now - 86_000_000,
          paid: 0,
          payments: [],
          closedAt: null,
        },
      ],
    }),
  );
};

describe('two farmers on one phone', () => {
  it('shows the next person none of the previous farmer’s name, chat or credit', async () => {
    withCreditFor('phone:03001110001');
    render(<App />);

    /* First farmer: the gate turns their first message into an account. */
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Ali Traders' }, READY),
    );
    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'A ka paigham');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await signIn('03001110001');
    expect(await screen.findByText('A ka paigham')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openProfile();
    // Their own name and number, and their own debt — of course.
    expect(screen.getByText('03001110001')).toBeInTheDocument();
    expect(screen.getByText('Rs. 10,000')).toBeInTheDocument();

    /* Signing out: the identity is gone, and so is everything that was the
       account's, on the very same screen. */
    await userEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    expect(await screen.findByText('Guest farmer')).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.queryByText('03001110001')).not.toBeInTheDocument();
    expect(screen.getByText('No credit taken yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openChat();
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.queryByText('A ka paigham')).not.toBeInTheDocument();

    /* Second farmer on the same phone. Nothing of the first farmer's is theirs
       to see — not a conversation, not a rupee of debt, not a phone number. */
    await openProfile();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }, READY),
    );
    await signIn('03002220002');
    expect(await screen.findByText('03002220002')).toBeInTheDocument();
    expect(screen.queryByText('03001110001')).not.toBeInTheDocument();
    expect(screen.getByText('No credit taken yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openChat();
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.queryByText('A ka paigham')).not.toBeInTheDocument();

    /* And the first farmer signing back in gets their own work back — this is
       isolation, not deletion. */
    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }, READY),
    );
    await signIn('03001110001');
    expect(await screen.findByText('Rs. 10,000')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openChat();
    expect(await screen.findByText('A ka paigham')).toBeInTheDocument();
  });

  /**
   * The same defect one level down: not only *whose* data, but whose data at all.
   *
   * The Profile strip used to read "Cotton · 8 acres · Wazirabad" on every
   * install, from catalog strings rather than from any store. So on a phone that
   * changed hands, a second farmer opened the app and was shown a farm that had
   * never been asked of them — 8 acres of land no part of the app knows the
   * existence of. A hard-coded name is obviously somebody else's; a hard-coded
   * *farm* is exactly as wrong and reads as just as real.
   *
   * So the strip is asserted to carry only what a store actually reported, and
   * to say so when there is nothing to report.
   */
  it('shows a farm summary only from stored data, never a fixture', async () => {
    render(<App />);

    await openProfile();

    /*
     * With a clean install and no backend, the honest strip is the crop count
     * and a village the farmer has not saved. The three old fixtures are gone
     * from the catalog, so none of them can render at all.
     */
    expect(screen.getByText(/\d+ crops?/)).toBeInTheDocument();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    expect(screen.queryByText('8 acres')).not.toBeInTheDocument();
    expect(screen.queryByText('Wazirabad')).not.toBeInTheDocument();
  });

  /**
   * A second farmer with their own crops must see *their* crops, not a fixture
   * and not the previous farmer's — the strip follows the account's document.
   */
  it('gives each farmer their own crop summary after signing in', async () => {
    const withCropsFor = (ownerId: string): void => {
      localStorage.setItem(
        `agri-shop.insights.${ownerId}`,
        JSON.stringify({
          crops: [
            {
              id: 'crop-maize-a',
              nameKey: 'crop.maize',
              stageKey: 'crop.stage.growing',
              stageConfirmed: true,
              plantedAt: Date.now() - 20 * 86_400_000,
              primary: true,
            },
          ],
          insights: [],
          notifications: [],
        }),
      );
    };

    withCropsFor('phone:03003330003');
    render(<App />);

    await openProfile();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }, READY),
    );
    await signIn('03003330003');

    /* Their own crop, by name, from their own document. */
    expect(await screen.findByText('Maize')).toBeInTheDocument();
    expect(screen.getByText('1 crops')).toBeInTheDocument();
    // And not a crop the fixture wrote.
    expect(screen.queryByText('Cotton')).not.toBeInTheDocument();
  });
});
