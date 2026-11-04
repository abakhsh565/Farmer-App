import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { createServices } from '@/services/registry';
import { resetPersistence } from '@/services/persistence';
import { FlakyRepository, UnreachableRepository } from '@/services/testing';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';

/**
 * The app against a backend that refuses writes, and one that cannot be reached
 * at all.
 *
 * These are the states a village phone spends most of its life in, and they are
 * the ones a suite that only ever runs against local storage never sees. The
 * property under test is not "it survives" but the two halves of the offline
 * requirement taken separately:
 *
 *   · anything the farmer writes is on the phone immediately, whether or not the
 *     backend took it — so the app keeps working, and nothing is lost
 *   · the app never *claims* it saved something it did not. The Data & services
 *     section on the profile is generated from the queue the stores actually use,
 *     which is why it is the surface these assertions read.
 */

const POST = 'Sawan ka pani ruk gya hai — kya main abhi sinchai karun?';

/**
 * The party id a real sign-in produces.
 *
 * The account id *is* the party id, because that is the row key the server stores
 * a document under. A fixture that signs in with the contact string instead is
 * not modelling a signed-in farmer at all — that state has its own test below,
 * and its own behaviour.
 */
const PARTY_ID = 'b0da419c-7763-44e1-886a-5e711ce9c113';

const signedIn = () =>
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      account: {
        id: PARTY_ID,
        name: 'Bilal Ahmed',
        phone: '0300 3333333',
        email: null,
        method: 'phone',
        verifiedAt: Date.now(),
        partyId: PARTY_ID,
      },
      contextMigrated: true,
    }),
  );

/**
 * A session that signed in before the database handed back a party id.
 *
 * The account and the token are real; the *row key* is not. `client_document_put`
 * takes a uuid, so a write addressed to `phone:03003333333` is refused by
 * PostgreSQL itself (`22P02 invalid input syntax for type uuid`) — a permanent
 * failure, not a bad connection. The app must therefore not attempt it, and must
 * not tell the farmer their work is on its way to an account it cannot reach yet.
 */
const signedInWithoutPartyId = () =>
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
        partyId: null,
      },
      contextMigrated: true,
    }),
  );

beforeEach(() => {
  localStorage.clear();
  markOnboardingComplete();
  signedIn();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  /* The queue and the last sync failure live outside React, so they outlive a
     test unless they are told not to. */
  resetPersistence();
  vi.restoreAllMocks();
});

const READY = { timeout: 5000 };

const openCommunity = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Community' }));
  await screen.findByRole('button', { name: 'Write a post' }, READY);
};

const publish = async (text: string) => {
  await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
  await userEvent.type(
    await screen.findByPlaceholderText('What do you want to ask nearby farmers?'),
    text,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Post' }));
};

/** The first header control is the farmer's own avatar. */
const openDataSection = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Home' }));
  const header = await screen.findByRole('banner');
  await userEvent.click(header.querySelectorAll('button')[0] as HTMLElement);
  await screen.findByText('Data & services', {}, READY);
};

describe('a backend that refuses the write', () => {
  it('retries, and says so while it has not landed', async () => {
    const base = createServices();
    /* The first write is refused; the retry is not. */
    const repository = new FlakyRepository(base.repository, 1);
    render(<App services={{ ...base, repository }} />);

    await openCommunity();
    await publish(POST);

    // Written here, and it is on the screen immediately — refused or not.
    expect(await screen.findByText(POST)).toBeInTheDocument();

    await waitFor(() => expect(repository.attempts).toBeGreaterThanOrEqual(1));

    /*
     * The queue retried on its own backoff and the document landed: `saved` is
     * only reachable once the repository accepted it and the entry was dropped.
     */
    await openDataSection();
    await waitFor(() => expect(screen.getByText('Everything is saved')).toBeInTheDocument(), {
      timeout: 8000,
    });
    expect(repository.attempts).toBeGreaterThanOrEqual(2);

    // And the farmer's words are still on the feed. (The tab bar is hidden while
    // the profile is open, so the way back is its own back control.)
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await openCommunity();
    expect(screen.getByText(POST)).toBeInTheDocument();
  });
});

describe('a session with no party id yet', () => {
  it('keeps the work on the phone and never queues a write that cannot succeed', async () => {
    const base = createServices();
    /* Zero failures: if the app attempts the write at all, the attempt is counted
       and this test fails. The assertion is about restraint, not about retrying. */
    const repository = new FlakyRepository(base.repository, 0);
    signedInWithoutPartyId();
    render(<App services={{ ...base, repository }} />);

    await openCommunity();
    await publish(POST);

    // On the phone immediately, as always: the farmer keeps working.
    expect(await screen.findByText(POST)).toBeInTheDocument();

    // Not sent anywhere, because there is nowhere to send it: no party id, no row.
    expect(repository.attempts).toBe(0);

    /* And the app says which of the two true things is happening. "Everything is
       saved" is not it — that would be a claim about the account, and the account
       cannot be written to yet. */
    await openDataSection();
    expect(screen.getByText('On this phone only')).toBeInTheDocument();
    expect(screen.queryByText('Everything is saved')).not.toBeInTheDocument();
  });
});

describe('a backend that cannot be reached at all', () => {
  it('shows the farmer their own phone\u2019s data instead of an error screen', async () => {
    const base = createServices();
    render(<App services={{ ...base, repository: new UnreachableRepository() }} />);

    await openCommunity();

    /* The posts are the phone's own, and they are on screen: the feed is not a
       failure page just because the backend is unreachable. */
    expect(
      screen.getByText(
        "Should I water this week? It's been raining on and off, not sure if the field needs more.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be reached/i)).not.toBeInTheDocument();
  });

  it('says plainly that it is not syncing, and keeps what is written anyway', async () => {
    const base = createServices();
    const first = render(
      <App services={{ ...base, repository: new UnreachableRepository() }} />,
    );

    await openCommunity();
    await publish(POST);
    expect(await screen.findByText(POST)).toBeInTheDocument();

    await openDataSection();

    /* One line, in the farmer's words, for the two facts that matter: the post is
       written here, and it has not gone anywhere. */
    expect(screen.getByText('1 waiting to sync')).toBeInTheDocument();
    // The backend's own complaint travels with the state, rather than a shrug.
    expect(screen.getByText(/unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    /* The restart, still with no backend. The post the farmer wrote is on the
       phone, so it is still there — which is the whole point of writing it to the
       phone first rather than to the network. */
    first.unmount();
    render(<App services={{ ...base, repository: new UnreachableRepository() }} />);
    await openCommunity();
    expect(await screen.findByText(POST)).toBeInTheDocument();
  });
});
