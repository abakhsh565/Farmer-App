import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { clearPlaceCache } from '@/services/geocode';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The location rules, exercised through the real screens.
 *
 * Choosing and saving are two acts: tapping a place shows the circle it produces
 * and the range control, and “Save location” is the one write. A guest keeps the
 * place on the phone; a signed-in farmer's store writes it to the account.
 */

const READY = { timeout: 4000 };

const PLACE = {
  place_id: 73,
  lat: '32.1877',
  lon: '74.1945',
  display_name: 'Gujranwala, Punjab, Pakistan',
};

const fetchMock = vi.fn(
  async () => ({ ok: true, json: async () => [PLACE] }) as unknown as Response,
);

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  clearPlaceCache();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openDealers() {
  await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
  return screen.findByRole('region', { name: 'Current location' }, READY);
}

/** Opens the location page from the filter and picks a place. */
async function chooseArea(name: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Search settings' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Change' }, READY));
  await screen.findByRole('heading', { name: 'Your location' }, READY);

  await userEvent.type(screen.getByRole('searchbox', { name: /Search village or town/ }), name);
  await userEvent.click(await screen.findByText(PLACE.display_name, {}, READY));
}

async function saveArea(name: string) {
  await chooseArea(name);
  await userEvent.click(screen.getByRole('button', { name: 'Save location' }));
  expect(await screen.findByText('Saved on this phone only.', {}, READY)).toBeInTheDocument();
}

describe('a guest and their location', () => {
  it('says plainly that nothing is saved yet, and searches the default area anyway', async () => {
    render(<App />);
    const bar = await openDealers();

    expect(within(bar).getByText('Not set')).toBeInTheDocument();
    expect(
      within(bar).getByText('Set your location to see dealers and weather near you.'),
    ).toBeInTheDocument();

    // A guest is not blocked from the passive experience: the search still answers.
    expect(screen.getByText(/dealers within 10 km/)).toBeInTheDocument();
  });

  it('keeps a chosen area for a guest, with no account asked for', async () => {
    render(<App />);
    await openDealers();
    await saveArea('Gujranwala');

    /* Saving does not ask for an account. Choosing where you are is kept on the
       phone, the same way the guest's crops are. */
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    const kept = JSON.parse(localStorage.getItem('agri-shop.location') ?? '{}');
    expect(kept.label).toBe(PLACE.display_name);
    expect(await screen.findByText(PLACE.display_name, {}, READY)).toBeInTheDocument();
  });

  it('does not write the place merely because the farmer looked at it', async () => {
    render(<App />);
    await openDealers();
    await chooseArea('Gujranwala');

    // Picking fills the panel; it is not the write.
    expect(screen.getByText('Chosen place')).toBeInTheDocument();
    expect(localStorage.getItem('agri-shop.location')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save location' })).toBeEnabled();
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
   * the newer one. This is the restart where that used to happen.
   */
  it('is not undone by a saved location on the same phone', async () => {
    const first = render(<App />);
    await openDealers();

    // Save an area as a guest, with the range at its default of 10 km.
    await saveArea('Gujranwala');

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
