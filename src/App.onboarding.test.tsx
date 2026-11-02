import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { isOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The first run, exercised through the real app.
 *
 * These assert what the brief promises: a brand-new device is walked through the
 * walkthrough → crops → location before it reaches the product, every optional
 * step can be skipped, the language control sits above the content and applies
 * immediately, and only Urdu and English are offered.
 *
 * The skip assertions matter more than they look. A farmer who declines a
 * location permission must still land on a working Home screen rather than stuck
 * at a gate, which is the failure mode a "required setup" flow has.
 *
 * The flag itself is asserted too. A flow that runs every launch is a bug that
 * only shows up on the second open, and nothing else in the suite would catch it.
 */

/** Long enough for the splash beat and a service read on a loaded machine. */
const READY = { timeout: 5000 };

/** The splash's own label, in the language a fresh device starts in. */
const SPLASH_LABEL = 'آگے بڑھیں';

/** A phone that has never opened the app. */
async function freshDevice() {
  localStorage.clear();
}

async function renderApp() {
  render(<App />);
  return userEvent.setup();
}

/** Past the splash beat, onto the walkthrough. */
async function throughSplash(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: SPLASH_LABEL }));
}

/** Switches the pinned control to English, so the assertions can read plainly. */
async function chooseEnglish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'English' }));
}

describe('first run', () => {
  beforeEach(async () => {
    await freshDevice();
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  });

  it('opens on the splash, then a walkthrough whose language control already has Urdu chosen', async () => {
    const user = await renderApp();

    // The splash is a beat with no control on it beyond tap-through.
    expect(screen.getByText('AgriShop')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'لوڈ ہو رہا ہے' })).toBeInTheDocument();

    await throughSplash(user);

    /*
     * The control is above the slides, not a step of its own — so the body of
     * slide one is on screen at the same time as the language choice, and the
     * default is Urdu.
     */
    const control = await screen.findByRole('group', { name: 'زبان' }, READY);
    expect(control).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'اردو' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('سب کچھ آپ کے ہاتھ میں')).toBeInTheDocument();
  });

  it('offers only Urdu and English, not the scaffold locales', async () => {
    const user = await renderApp();
    await throughSplash(user);
    await screen.findByRole('group', { name: 'زبان' }, READY);

    // Registered in the locale system, deliberately not offered here: their
    // onboarding copy is not reviewed, so the screen would fall back to Urdu.
    for (const name of [/پنجابی/, /Saraiki/, /Sindhi/, /Pashto/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('leaves the splash without waiting out its beat', async () => {
    const user = await renderApp();

    const splash = screen.getByRole('button', { name: SPLASH_LABEL });
    await user.click(splash);

    expect(await screen.findByRole('group', { name: 'زبان' }, READY)).toBeInTheDocument();
    expect(screen.queryByText('AgriShop')).not.toBeInTheDocument();
  });

  it('switches the whole flow into the chosen language as soon as it is picked', async () => {
    const user = await renderApp();
    await throughSplash(user);
    await screen.findByRole('group', { name: 'زبان' }, READY);

    expect(screen.getByText('سب کچھ آپ کے ہاتھ میں')).toBeInTheDocument();

    await chooseEnglish(user);

    // Same screen, different language — no need to go back a step.
    expect(await screen.findByText('Everything you need, in your hand')).toBeInTheDocument();
    expect(screen.queryByText('سب کچھ آپ کے ہاتھ میں')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('walks slides → crops → location and lands in Guest Mode with the crop kept', async () => {
    const user = await renderApp();
    await throughSplash(user);
    await screen.findByRole('group', { name: 'زبان' }, READY);
    await chooseEnglish(user);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Show a leaf, get the answer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Depend on your neighbourhood')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('What do you grow?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cotton' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Crops come first, location second — the order the brief sets out.
    expect(await screen.findByText('Where is your farm?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(await screen.findByText(/Assalam o Alaikum, Guest/, {}, READY)).toBeInTheDocument();

    /*
     * The crop has to survive into the product, not just be ticked. It is read
     * back out of the insights document the app actually writes, because a step
     * that collects a choice and then drops it looks identical on screen to one
     * that works.
     */
    expect(localStorage.getItem('agri-shop.insights')).toContain('crop.cotton');
    expect(isOnboardingComplete()).toBe(true);
  });

  it('lets every optional step be skipped, and does not come back on the second launch', async () => {
    const user = await renderApp();
    await throughSplash(user);
    await screen.findByRole('group', { name: 'زبان' }, READY);
    await chooseEnglish(user);

    // Skip the remaining slides, then both optional questions.
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByText('What do you grow?');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByText('Where is your farm?');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(await screen.findByText(/Assalam o Alaikum, Guest/, {}, READY)).toBeInTheDocument();
    expect(isOnboardingComplete()).toBe(true);

    /*
     * Reopening the app. The first run is unmounted first so the second launch is
     * genuinely a fresh mount against the storage the first one left behind —
     * which is the only version of this that can catch a flag written but never
     * read back.
     */
    cleanup();
    render(<App />);
    expect(await screen.findByText(/Assalam o Alaikum, Guest/, {}, READY)).toBeInTheDocument();
    expect(screen.queryByText('What do you grow?')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Language' })).not.toBeInTheDocument();
  });
});
