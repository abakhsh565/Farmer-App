import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * Searching shops and stock from one box.
 *
 * The defect this replaces was quiet: the dealer list filtered by shop *name*
 * only, so a farmer who typed "urea" got an empty list and reasonably concluded
 * nobody nearby stocked it. The product half of the question had nowhere to be
 * answered. So these tests are about the two halves — suggestions for both, live
 * matching while typing, and two result types that keep the keyword when swapped.
 */

/** Long enough for the debounce plus a service read on a loaded machine. */
const READY = { timeout: 4000 };

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
});

/** Reaches the search page the way a farmer does: through the dealer list. */
async function openSearch() {
  await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));
  await screen.findByRole('region', { name: 'Your location' }, READY);
  await userEvent.click(screen.getByRole('button', { name: 'Search dealers or products' }));
  await screen.findByRole('heading', { name: 'Search' }, READY);
}

const searchbox = () => screen.getByRole('searchbox', { name: 'Search' });
const dealersTab = () => screen.getByRole('button', { name: /^Dealers · / });
const productsTab = () => screen.getByRole('button', { name: /^Products · / });

describe('the search page', () => {
  it('opens from the dealer list and suggests shops and products before anything is typed', async () => {
    render(<App />);
    await openSearch();

    // The field is where the farmer's attention is, and the page says what it
    // takes rather than leaving an empty box.
    expect(searchbox()).toHaveFocus();
    expect(screen.getByText('Type a shop, or a product like urea or Roundup.')).toBeInTheDocument();

    /*
     * Both kinds, before a keyword exists — and both real: the suggestions come
     * from the dealer service, so they cannot name a shop that has stopped trading
     * or a product nobody nearby carries.
     */
    expect(screen.getByText('Suggested dealers')).toBeInTheDocument();
    expect(screen.getByText('Suggested products')).toBeInTheDocument();
    expect((await screen.findAllByText('Ali Traders', {}, READY)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Roundup', {}, READY)).length).toBeGreaterThan(0);
  });

  it('matches while the farmer is still typing, without making them confirm', async () => {
    render(<App />);
    await openSearch();

    await userEvent.type(searchbox(), 'urea');

    // Still suggesting: no tabs until a keyword is confirmed.
    expect(screen.queryByRole('button', { name: /^Products · / })).not.toBeInTheDocument();

    // And the match is a product, which the old box could not find at all.
    expect(await screen.findByText('Urea', {}, READY)).toBeInTheDocument();
  });

  it('confirms into two result types and keeps the keyword when they are swapped', async () => {
    render(<App />);
    await openSearch();

    await userEvent.type(searchbox(), 'cotton');
    await userEvent.keyboard('{Enter}');

    // Two answers to one keyword, each saying how many it found.
    expect(await screen.findByRole('button', { name: /^Dealers · / }, READY)).toBeInTheDocument();
    expect(productsTab()).toBeInTheDocument();
    expect(searchbox()).toHaveValue('cotton');

    await userEvent.click(productsTab());
    expect(searchbox()).toHaveValue('cotton');
    expect(await screen.findByText('Bt cotton seed', {}, READY)).toBeInTheDocument();

    // Back the other way, still the same keyword.
    await userEvent.click(dealersTab());
    expect(searchbox()).toHaveValue('cotton');
    expect((await screen.findAllByText('Green Agro Store', {}, READY)).length).toBeGreaterThan(0);
  });

  it('takes a product suggestion straight to the product answer', async () => {
    render(<App />);
    await openSearch();

    await userEvent.click(await screen.findByRole('button', { name: /^Urea/ }, READY));

    // The suggestion becomes the keyword, and the page opens on the half that
    // answers it rather than making the farmer find the other tab.
    expect(searchbox()).toHaveValue('Urea');
    expect(productsTab()).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Green Agro Store · 3 km', {}, READY)).toBeInTheDocument();
  });

  it('goes back to suggesting when the keyword is edited after confirming', async () => {
    render(<App />);
    await openSearch();

    await userEvent.type(searchbox(), 'cotton');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('button', { name: /^Dealers · / }, READY);

    /*
     * Editing the keyword means the results on screen are about a word that is no
     * longer in the box. Showing them anyway is how a search box ends up lying
     * about what it found.
     */
    await userEvent.type(searchbox(), 'x');
    expect(screen.queryByRole('button', { name: /^Products · / })).not.toBeInTheDocument();

    // Both halves are offering matches again — under the typed-keyword heading
    // rather than the before-you-type one.
    expect(screen.getAllByText('Suggested for you')).toHaveLength(2);
  });
});
