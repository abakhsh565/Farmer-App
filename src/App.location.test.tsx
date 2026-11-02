import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The location rules, exercised through the real screens.
 *
 * These are the behaviours that cannot be checked by reading a service: a farmer
 * who searches somewhere else must be able to *see* that their saved location has
 * not moved, must be offered a way to keep the new place, and must not have it
 * written just because they looked at it. Each of those is a sentence on the
 * screen and a control beside it, so they are asserted where the farmer reads them.
 *
 * The guest path is the one under test here. Nothing is written without an account
 * — saving is the accountable act — and declining the account must leave the
 * search exactly where it was, still temporary and still unsaved.
 */

/** Long enough for a service read to land on a loaded machine. */
const READY = { timeout: 4000 };

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
});

async function openDealers() {
  await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));
  return screen.findByRole('region', { name: 'Your location' }, READY);
}

/** Chooses a named area from the search-settings sheet and closes it. */
async function chooseArea(name: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));
  await userEvent.click(await screen.findByRole('button', { name }, READY));
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
}

describe('a guest and their location', () => {
  it('says plainly that nothing is saved yet, and searches the default area anyway', async () => {
    render(<App />);
    const bar = await openDealers();

    expect(within(bar).getByText('Not saved yet')).toBeInTheDocument();
    expect(
      within(bar).getByText('The default area for your district until you save one.'),
    ).toBeInTheDocument();

    // A guest is not blocked from the passive experience: the search still answers.
    expect(screen.getByText(/dealers within 10 km/)).toBeInTheDocument();
  });

  it('keeps a chosen area temporary, says so, and offers to save it', async () => {
    render(<App />);
    await openDealers();
    await chooseArea('Gujranwala');

    // The rule, in the farmer's words: looking somewhere else did not move the
    // saved location.
    expect(
      screen.getByText('Searching around Gujranwala. Your saved location stays Not saved yet.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save this location' })).toBeInTheDocument();
  });

  it('keeps a chosen area for a guest, with no account asked for', async () => {
    render(<App />);
    await openDealers();
    await chooseArea('Gujranwala');

    await userEvent.click(screen.getByRole('button', { name: 'Save this location' }));

    /*
     * Saving no longer asks for an account. The farmer who cannot sign up is
     * precisely the one who needs the shops near them, and choosing where you are
     * is not said *to* anyone — see LocationProvider for why it is kept on the
     * phone instead.
     */
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    const kept = JSON.parse(localStorage.getItem('agri-shop.location') ?? '{}');
    expect(kept.label).toBe('Gujranwala');

    /*
     * And it is the farmer's own location now, not a temporary area — said the way
     * it can actually be true, since there is no account to have saved it to.
     */
    expect(await screen.findByText('Saved on this phone.', {}, READY)).toBeInTheDocument();
  });

  it('names the place a temporary search will not replace', async () => {
    render(<App />);
    await openDealers();
    await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));

    // "My profile location" has to name what the account actually holds, rather
    // than a place written into the build.
    const profileRow = await screen.findByRole(
      'button',
      { name: /My profile location/ },
      READY,
    );
    expect(profileRow).toHaveTextContent('Not saved yet');

    await userEvent.click(screen.getByRole('button', { name: /Kot Ladha/ }));
    expect(
      screen.getByText('Temporary search area. Your profile location stays Not saved yet.'),
    ).toBeInTheDocument();
  });
});

/**
 * The search range — one number for the whole app.
 *
 * It used to be a local `10` on the dealer list, a second constant on the scan
 * screen and a third written into Home. They are one value now, so this asserts it
 * through what the list *says*: a range that only changes the control the farmer
 * touched, and not the answer underneath it, has not changed anything.
 */
describe('the search range', () => {
  it('is one number, kept on the device, and the list reads it', async () => {
    const first = render(<App />);
    await openDealers();

    expect(await screen.findByText(/dealers within 10 km/, {}, READY)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));
    await userEvent.click(await screen.findByRole('button', { name: '25 km' }, READY));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByText(/dealers within 25 km/, {}, READY)).toBeInTheDocument();
    expect(localStorage.getItem('agri-shop.radius')).toBe('25');

    // A restart: the range belongs to the farmer, not to the session.
    first.unmount();
    render(<App />);
    await openDealers();

    expect(await screen.findByText(/dealers within 25 km/, {}, READY)).toBeInTheDocument();
  });

  /**
   * A saved location does not get to overrule the range.
   *
   * Every saved location carries a radius, and one of them was winning at every
   * launch: the filter wrote the phone's preference, the saved record still held
   * whatever was in force when it was saved, and the older number kept overwriting
   * the newer one — so a range a farmer had chosen reverted the moment they
   * reopened the app. The record's radius is adopted from the *account*, where it is
   * the number the server searches with, and not from the phone's own copy.
   */
  it('is not undone by a saved location on the same phone', async () => {
    const first = render(<App />);
    await openDealers();

    // Save an area as a guest, with the range at its default of 10 km.
    await chooseArea('Gujranwala');
    await userEvent.click(screen.getByRole('button', { name: 'Save this location' }));
    await screen.findByText('Saved on this phone.', {}, READY);

    // Then widen it, which writes the phone's own preference.
    await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));
    await userEvent.click(await screen.findByRole('button', { name: '25 km' }, READY));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/dealers within 25 km/, {}, READY)).toBeInTheDocument();

    // The restart is where the saved record used to win.
    first.unmount();
    render(<App />);
    await openDealers();

    expect(await screen.findByText(/dealers within 25 km/, {}, READY)).toBeInTheDocument();
  });
});
