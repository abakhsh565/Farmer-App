import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { mirrorKey, ownerFor } from '@/services/persistence';
import { createServices } from '@/services/registry';
import { DelayedRepository } from '@/services/testing';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';

/**
 * The community feed, driven the way a farmer drives it.
 *
 * These are the things the unit suites cannot check: that the composer's refusal
 * is on the screen, that a block changes what the feed shows and can be undone,
 * that a half-written reply survives leaving the tab. Everything asserted here is
 * something a farmer would notice, and every rule under test is the product's.
 */

const POST1 =
  "Should I water this week? It's been raining on and off, not sure if the field needs more.";
const POST2 = 'Kya ye bimari phail sakti hai? Leaves are curling on a few plants.';
const POST3 = 'Alhamdulillah, first picking done this week';
const EXPERT_ANSWER =
  'Looks like leaf curl virus — isolate the plant and spray for the whitefly, which is what carries it.';

/*
 * Most of these tests are about what happens once a farmer is inside the app and
 * writing, so they start from a signed-in phone: identity-on-action is asserted
 * on its own in `App.identity.test.tsx`, where the guest paths live. Writing
 * without an account is supposed to be impossible now, so a suite that expects to
 * publish must not be a guest.
 */
const signedIn = () =>
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

beforeEach(() => {
  localStorage.clear();
  signedIn();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

/** Long enough for the feed's own loading state, which is real and reachable. */
const READY = { timeout: 4000 };

const asPattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const openCommunity = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Community' }));
  await screen.findByText(POST1, {}, READY);
};

/** The card (or reply row) a piece of text sits in — options menus are per card. */
const cardFor = (text: string | RegExp) =>
  screen.getByText(text).closest('li') as HTMLElement;

const openPost = async (text: string) => {
  await userEvent.click(
    screen.getByRole('button', { name: new RegExp(asPattern(text.slice(0, 30))) }),
  );
};

const choose = async (card: HTMLElement, name: string, label = 'Options for this post') => {
  await userEvent.click(within(card).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('button', { name }));
};

describe('community feed', () => {
  it('shows the posts with the numbers their threads actually hold', async () => {
    render(<App />);
    await openCommunity();

    expect(screen.getByText(POST2)).toBeInTheDocument();
    expect(screen.getByText(POST3)).toBeInTheDocument();

    // The counts are the threads, not captions: twelve replies open twelve.
    expect(screen.getByText('12 replies')).toBeInTheDocument();
    expect(screen.getByText('8 replies')).toBeInTheDocument();
    expect(screen.getByText('6 replies')).toBeInTheDocument();

    // Dr. Amna opens the leaf-curl thread, so that card quotes her.
    expect(screen.getByText(EXPERT_ANSWER)).toBeInTheDocument();
    // On the watering question she answered sixth, so the card says so instead.
    expect(screen.getByText('Expert answered')).toBeInTheDocument();

    // The farmer's own post carries its likes.
    expect(screen.getByRole('button', { name: '24 likes' })).toBeInTheDocument();

    // Three neighbours, and the farmer's own ring to add to.
    expect(screen.getByRole('button', { name: 'Story from Sajid' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Story from Rafiq' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Story from Dr. Amna' })).toBeInTheDocument();
  });

  /**
   * The loading state, against a backend that is genuinely slow.
   *
   * It used to be asserted against a staged 600 ms delay in the provider, which
   * proved only that a timer had been set. A real slow repository is what makes
   * the state reachable — and it is the same state a village phone on two bars of
   * signal sees.
   *
   * The delay is deliberately generous. At 800 ms the test was really asserting
   * that a click on the tab resolved faster than the network, which is a fact
   * about the machine running it, not about the app — and it failed on a loaded
   * one. Two seconds keeps the loading state genuinely observable while the
   * assertion stays about the screen.
   */
  it('shows the loading state while a slow backend is read, then the posts', async () => {
    const base = createServices();
    render(
      <App services={{ ...base, repository: new DelayedRepository(base.repository, 2_000) }} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(screen.getByText('Loading posts…')).toBeInTheDocument();

    await screen.findByText(POST1, {}, { timeout: 8_000 });
    expect(screen.queryByText('Loading posts…')).not.toBeInTheDocument();
  });

  it('filters to questions, and back to everything', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Questions' }));

    expect(screen.getByText(POST1)).toBeInTheDocument();
    expect(screen.getByText(POST2)).toBeInTheDocument();
    // The harvest update is not a question.
    expect(screen.queryByText(POST3)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText(POST3)).toBeInTheDocument();
  });

  it('likes a post once, and unlikes it by tapping again', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: '24 likes' }));
    const liked = screen.getByRole('button', { name: '25 likes' });
    expect(liked).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(liked);
    expect(screen.getByRole('button', { name: '24 likes' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('community threads', () => {
  it('opens a post and shows the whole conversation', async () => {
    render(<App />);
    await openCommunity();

    await openPost(POST1);

    expect(screen.getByText(/We got 40 mm here last night/)).toBeInTheDocument();
    expect(screen.getByText(/Rain on and off is not the same as a soak/)).toBeInTheDocument();
    expect(screen.getByText(/Eight acres, half of it cotton/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Community' })).toBeInTheDocument();
  });

  it('posts a reply and the count follows it', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    expect(screen.getByText('12 replies')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Write a reply'), 'Do din ruk jayen bhai');
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(screen.getByText('Do din ruk jayen bhai')).toBeInTheDocument();
    expect(screen.getByText('13 replies')).toBeInTheDocument();
    // The box is empty again, ready for the next person.
    expect(screen.getByPlaceholderText('Write a reply')).toHaveValue('');
  });

  it('answers a reply rather than the post, when that is what was tapped', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    // Twelve reply toggles and one send button: the toggle is named for who it
    // answers, so there is never a question about which one was tapped. Rafiq
    // answered twice in this thread, so the first is taken.
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply to Rafiq Chaudhry' })[0]!);
    expect(screen.getByText(/Replying to Rafiq Chaudhry/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Write a reply'), 'Sahi baat hai');
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(screen.getByText('Sahi baat hai')).toBeInTheDocument();
    // Answering somebody does not leave the box pointing at them.
    expect(screen.queryByText(/Replying to Rafiq Chaudhry/)).not.toBeInTheDocument();
  });

  it('refuses an empty reply, and says why', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Write something first');
  });

  it('refuses a reply that breaks the rules, and says which', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    await userEvent.type(screen.getByPlaceholderText('Write a reply'), 'ye advice stupid hai');
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(screen.getByRole('alert')).toHaveTextContent('This breaks the community rules');
    // Nothing was published.
    expect(screen.getByText('12 replies')).toBeInTheDocument();
  });

  it('keeps a half-written reply when the farmer leaves the tab', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    await userEvent.type(screen.getByPlaceholderText('Write a reply'), 'Pan');

    await userEvent.click(screen.getByRole('button', { name: 'Home' }));
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));
    await screen.findByText(POST1, {}, READY);
    await openPost(POST1);

    expect(screen.getByPlaceholderText('Write a reply')).toHaveValue('Pan');
  });
});

describe('community writing', () => {
  it('publishes a post and puts it at the top of the feed', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));

    await userEvent.type(
      screen.getByPlaceholderText('What do you want to ask nearby farmers?'),
      'Kapas ki patti peele ho rahe hain',
    );

    // The tips are the education half of the composer: asking well is taught.
    expect(screen.getByText('A good question gets a good answer')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Kapas ki patti peele ho rahe hain')).toBeInTheDocument();
    // Mine, new, and labelled the way the design labels the farmer's own posts.
    expect(screen.getByText(/You · Cotton · Wazirabad · Just now/)).toBeInTheDocument();
  });

  it('refuses an empty post and a post that is too long', async () => {
    render(<App />);
    await openCommunity();
    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));

    await userEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Write something first');

    // Set in one go rather than typed key by key: the rule under test is the
    // length check, not the keyboard.
    fireEvent.change(screen.getByPlaceholderText('What do you want to ask nearby farmers?'), {
      target: { value: 'a'.repeat(501) },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Too long — keep it under 500 characters');
  });

  it('refuses a file that is not a photo or a video', async () => {
    render(<App />);
    await openCommunity();
    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    // `accept` is a hint the picker honours and a drag-and-drop or an "all files"
    // pick does not, so the check the app relies on is the one in `validate.ts` —
    // which is what this drives, with the picker's filter switched off.
    await userEvent.upload(
      input as HTMLInputElement,
      [new File(['%PDF-1.4'], 'mandi-rates.pdf', { type: 'application/pdf' })],
      { applyAccept: false },
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Only photos and videos can be attached');
  });

  it('adds a story the farmer can then open in their own ring', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Your story' }));
    await userEvent.type(
      screen.getByPlaceholderText('Say something to your neighbours'),
      'Aaj ginner se baat hui',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Story from You' }));
    expect(await screen.findByText('Aaj ginner se baat hui')).toBeInTheDocument();
  });

  it('keeps an offline post on the phone and shares it when the network returns', async () => {
    render(<App />);
    await openCommunity();

    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));

    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      screen.getByPlaceholderText('What do you want to ask nearby farmers?'),
      'Sawan ka pani ruk gya hai',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    // Written on the phone, and honest that it has not gone anywhere yet.
    expect(await screen.findByText('Waiting to send')).toBeInTheDocument();

    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));

    // The queue drains in one tick; the assertion waits for it rather than
    // assuming the render has happened.
    await waitFor(() => expect(screen.queryByText('Waiting to send')).not.toBeInTheDocument());
    expect(screen.queryByText(/You are offline/)).not.toBeInTheDocument();
  });
});

describe('community moderation', () => {
  it('reports a post with a reason and confirms it', async () => {
    render(<App />);
    await openCommunity();

    await choose(cardFor(POST1), 'Report');

    expect(screen.getByText(/Tell us what is wrong/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Spam or advertising' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByText('Reported — our team will review it')).toBeInTheDocument();
  });

  it('blocks an author, hides their posts, and undoes it', async () => {
    render(<App />);
    await openCommunity();

    await choose(cardFor(POST1), 'Block Sajid Khan');

    expect(screen.queryByText(POST1)).not.toBeInTheDocument();
    expect(screen.getByText(/Hidden because you blocked Sajid Khan/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Unblock Sajid Khan' }));
    expect(screen.getByText(POST1)).toBeInTheDocument();
    expect(screen.queryByText(/Hidden because you blocked/)).not.toBeInTheDocument();
  });

  it('offers the empty state for a filter with nothing left in it', async () => {
    render(<App />);
    await openCommunity();

    // Block both people who asked a question, then go and look at the questions.
    await choose(cardFor(POST1), 'Block Sajid Khan');
    await choose(cardFor(POST2), 'Block Rafiq Chaudhry');

    await userEvent.click(screen.getByRole('button', { name: 'Questions' }));

    expect(screen.getByText('No posts here yet')).toBeInTheDocument();
    expect(screen.getByText('Nothing has been posted under this filter yet.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show all posts' }));
    expect(screen.getByText(POST3)).toBeInTheDocument();
  });

  it('deletes the farmer\u2019s own post, leaving the answers written to it', async () => {
    render(<App />);
    await openCommunity();

    await choose(cardFor(POST3), 'Delete');
    expect(screen.getByText(/Replies from other farmers stay visible/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('This post was removed')).toBeInTheDocument();
  });

  it('deletes the farmer’s own reply from a thread', async () => {
    render(<App />);
    await openCommunity();
    await openPost(POST1);

    await userEvent.type(screen.getByPlaceholderText('Write a reply'), 'Meri baat wapas lein');
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByText('Meri baat wapas lein')).toBeInTheDocument();

    await choose(cardFor('Meri baat wapas lein'), 'Delete', 'Options for this reply');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.queryByText('Meri baat wapas lein')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('12 replies')).toBeInTheDocument();
  });

  it('shows the rules and the terms behind the shield', async () => {
    render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Community rules and terms' }));

    expect(screen.getByText('Keep it about farming')).toBeInTheDocument();
    expect(screen.getByText(/Selling is not allowed here/)).toBeInTheDocument();
    expect(screen.getByText('If a rule is broken')).toBeInTheDocument();
    expect(screen.getByText(/Your phone number is never shown/)).toBeInTheDocument();
  });
});

describe('community stories', () => {
  it('opens a story, marks it read, and advances to the next', async () => {
    render(<App />);
    await openCommunity();

    const sajid = screen.getByRole('button', { name: 'Story from Sajid' });
    expect(sajid.className).toContain('bg-gradient-to-br');

    await userEvent.click(sajid);
    expect(await screen.findByText(/Picking starts tomorrow/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next story' }));
    expect(await screen.findByText(/Rain last night/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close story' }));
    expect(screen.queryByText(/Rain last night/)).not.toBeInTheDocument();

    // Read is read: the ring is no longer new.
    expect(screen.getByRole('button', { name: 'Story from Sajid' }).className).toContain(
      'bg-ink-200',
    );
  });
});

describe('community storage', () => {
  it('says so when the phone will not open its storage, and recovers on retry', async () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Community' }));

    expect(await screen.findByText('Could not load posts')).toBeInTheDocument();

    blocked.mockRestore();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(POST1, {}, READY)).toBeInTheDocument();
  });

  it('keeps what the farmer wrote across a reload', async () => {
    const first = render(<App />);
    await openCommunity();

    await userEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    await userEvent.type(
      screen.getByPlaceholderText('What do you want to ask nearby farmers?'),
      'Bijai ka waqt kya hai',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    await screen.findByText('Bijai ka waqt kya hai');
    /*
     * The phone's copy, under *this account's* key. It is per-owner because an
     * unscoped key meant the next person to open the app on a shared phone was
     * shown the previous farmer's posts.
     */
    expect(
      localStorage.getItem(mirrorKey('community', ownerFor('phone:03003333333'))),
    ).toContain('Bijai ka waqt kya hai');

    first.unmount();

    render(<App />);
    await openCommunity();
    expect(await screen.findByText('Bijai ka waqt kya hai')).toBeInTheDocument();
  });
});
