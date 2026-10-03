import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { ChatProvider } from '@/chat/ChatProvider';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createServices, ServicesProvider } from '@/services/registry';
import { SessionProvider } from '@/session/SessionProvider';
import { ChatScreen } from '@/screens/ChatScreen';
import type { Collection, Repository } from '@/services/types';

/** Long enough for a service read to land on a loaded machine. */
const READY = { timeout: 4000 };

beforeEach(() => {
  // Locale and theme are persisted, so a test that switches either must not leak
  // into the next one.
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
});

describe('App', () => {
  it('opens on Home and switches to Dealers', async () => {
    render(<App />);

    expect(screen.getByText('Assalam o Alaikum, Bilal')).toBeInTheDocument();
    expect(screen.getByText('Mandi rates · Wazirabad')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));

    expect(screen.getByRole('heading', { name: 'Dealers' })).toBeInTheDocument();
    expect(screen.getByText('5 dealers within 10 km')).toBeInTheDocument();
  });

  /**
   * The bottom bar is the product's whole navigation. A missing destination is
   * invisible to a unit test and obvious to a user, so the five tabs are asserted
   * by name — including that "Me" is not among them.
   */
  it('offers Home, Dealers, Scan, Chat and Community in the bottom bar', () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const labels = [...nav.querySelectorAll('button')].map(
      (button) => button.textContent?.trim() || button.getAttribute('aria-label'),
    );

    expect(labels).toEqual(['Home', 'Dealers', 'Scan a crop', 'Chat', 'Community']);
    expect(screen.queryByRole('button', { name: 'Me' })).not.toBeInTheDocument();
  });

  it('carries the farmer, notifications and the profile entry in the home header', () => {
    render(<App />);

    const header = screen.getByRole('banner');
    const controls = [...header.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
    );

    // The avatar is the profile entry — named for what it opens, showing the
    // farmer's initials — and the bell is the only other control. Language and
    // appearance moved to the profile screen, so the header is about the day
    // rather than about settings.
    expect(controls).toEqual(['Profile and settings', 'Notifications']);
    expect(header).toHaveTextContent('BA');
  });

  /**
   * The dealer rows on Home are the same conversations as the chat list — the
   * design draws a message button on each one, and a button that opens nothing is
   * worse than no button.
   */
  it('opens a dealer conversation from the home screen', async () => {
    render(<App />);

    /* The home list is a service read, so the row arrives a tick after the paint. */
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Ali Traders' }, READY),
    );

    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();
    expect(screen.getByText('Assalam o Alaikum. Do you have Roundup in stock?')).toBeInTheDocument();
  });

  it('sends the home dealer section to the Dealers screen', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'See all' }));

    expect(screen.getByRole('heading', { name: 'Dealers' })).toBeInTheDocument();
  });

  it('gives the weather card its spray advice in both languages at once', async () => {
    render(<App />);

    /* The advice appears only once a usable reading has arrived: advice without a
       reading behind it is the state this screen exists to avoid. */
    expect(await screen.findByText('Best time to spray: 6 to 9 AM', {}, READY)).toBeInTheDocument();
    // The same advice in the other script, so a farmer who reads one gets it
    // without switching the app.
    expect(screen.getByText('چھڑکاؤ کا بہترین وقت: صبح 6 سے 9 بجے')).toBeInTheDocument();
    // …and the figure carries the provider it came from and how old it is.
    expect(screen.getByText(/Source: Development weather/)).toBeInTheDocument();
  });

  it('shows the dealers the service returns, with their distance and what they carry', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));

    expect(await screen.findByText('Ali Traders', {}, READY)).toBeInTheDocument();
    expect(screen.getByText('Wazirabad Agri Center')).toBeInTheDocument();
    expect(screen.getByText('Punjab Seed Corner')).toBeInTheDocument();
    expect(screen.getByText('Malik Fertilizers')).toBeInTheDocument();
    /* The row says what the source verified — a category the shop stocks — rather
       than asserting a specific product is on the shelf. */
    expect(screen.getByText(/Stocks Pesticide/)).toBeInTheDocument();
    // The shop that is not taking requests is shown without a way to message it.
    expect(screen.queryByRole('button', { name: 'Chat with Malik Fertilizers' })).toBeNull();
    // The shop beyond the ceiling is never in the list, at any radius.
    expect(screen.queryByText('Far Mandi Depot')).toBeNull();
  });
});

describe('profile', () => {
  /** The first header control is the farmer's own avatar. */
  const openProfile = async () => {
    const header = screen.getByRole('banner');
    await userEvent.click(header.querySelectorAll('button')[0] as HTMLElement);
  };

  it('opens from the header and returns with back', async () => {
    render(<App />);

    await openProfile();

    expect(screen.getByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('0300 3333333')).toBeInTheDocument();
    // The farm at a glance, and the menu the design specifies.
    expect(screen.getByText('8 acres')).toBeInTheDocument();
    expect(screen.getByText('My Dealers')).toBeInTheDocument();
    expect(screen.getByText('Farm Details')).toBeInTheDocument();
    expect(screen.getByText('Help & Support')).toBeInTheDocument();
    /* A guest sees the way in, not the way out: signing out and deleting the
       account are authenticated-only controls. */
    expect(screen.getByText('Create an account')).toBeInTheDocument();
    expect(screen.queryByText('Log Out')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();
    // The tab bar is hidden while a pushed screen is open.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('sends My Dealers to the Dealers tab', async () => {
    render(<App />);

    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: /My Dealers/ }));

    expect(screen.getByRole('heading', { name: 'Dealers' })).toBeInTheDocument();
  });

  it('switches language from the profile and mirrors the direction', async () => {
    render(<App />);

    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: /Language/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'اردو' }));

    expect(document.documentElement.lang).toBe('ur');
    expect(document.documentElement.dir).toBe('rtl');

    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'واپس' }));

    expect(screen.getByText(/السلام علیکم/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ڈیلر' })).toBeInTheDocument();
  });

  /**
   * Dark mode is only real if a user can reach it. The tokens existed for a
   * while with nothing to switch them on, which is indistinguishable from
   * having no dark mode at all.
   */
  it('starts light and takes the appearance chosen on the profile', async () => {
    render(<App />);

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: /Appearance/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('agri-shop.theme')).toBe('dark');
  });
});

describe('chat', () => {
  it('lists the conversations with their dealer and last message', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));

    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ali Traders/ })).toBeInTheDocument();
    expect(screen.getByText('Yes bhai, Roundup available hai, aa jayen')).toBeInTheDocument();
    expect(screen.getByText('Your credit request is approved')).toBeInTheDocument();
    expect(screen.getByText('Shop khulay ga 8 baje')).toBeInTheDocument();
  });

  it('clears the unread badge once the conversation is read', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));

    const unread = screen.getByRole('button', { name: /Ali Traders.*2 unread messages/ });
    await userEvent.click(unread);
    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: /unread messages/ })).toBeNull();
  });

  it('opens a dealer thread from the Dealers screen', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Chat with Ali Traders' }));

    expect(screen.getByText('Assalam o Alaikum. Do you have Roundup in stock?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();
  });

  it('sends a message into the open thread', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    await userEvent.click(screen.getByRole('button', { name: /Ali Traders/ }));

    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'Bhai, kal bhej dein');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getByText('Bhai, kal bhej dein')).toBeInTheDocument();
  });

  it('keeps the conversation history when the language changes', async () => {
    render(<App />);

    const header = screen.getByRole('banner');
    await userEvent.click(header.querySelectorAll('button')[0] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: /Language/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'اردو' }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'واپس' }));
    await userEvent.click(screen.getByRole('button', { name: 'بات چیت' }));

    // The same threads, rendered in Urdu rather than lost or duplicated — which is
    // the whole reason a thread is keyed by message key instead of by text.
    expect(screen.getByText('جی بھائی، راؤنڈ اپ موجود ہے، آ جائیں')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /علی ٹریڈرز/ })).toBeInTheDocument();
  });
});

describe('scan', () => {
  it('walks from a photo to the assistant conversation', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Scan a crop' }));
    await userEvent.click(screen.getByRole('button', { name: /Take a photo/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Crop Assistant', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Pink Bollworm · 82% match/)).toBeInTheDocument();
    /* The treatment, with its registration evidence and the live shop stock that
       the matching chain ends at. */
    expect(screen.getByText('Roundup herbicide · 1 litre')).toBeInTheDocument();
    expect(screen.getByText(/Reg\. No\. DPP-PK-2019-0431/)).toBeInTheDocument();
    /*
     * The live listing is the dealer service's, so the price here is the price on
     * the shop's own page. Two copies of it used to exist — a fixture beside the
     * treatment and the shop's product row — and they disagreed, which is the kind
     * of contradiction a farmer cannot resolve.
     */
    expect(await screen.findByText(/Ali Traders · 1\.8 km · Rs\. 1,850/)).toBeInTheDocument();
    expect(screen.getByText(/Green Agro Store · 3\.4 km · Rs\. 1,880/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask a follow-up question')).toBeInTheDocument();

    // The same product on the same shop's page, at the same price.
    await userEvent.click(screen.getByRole('button', { name: 'Dealers' }));
    // The row body, not the chat button beside it — both name the shop.
    await userEvent.click(await screen.findByRole('button', { name: /^Ali Traders/ }, READY));
    expect(await screen.findByText('Roundup', {}, READY)).toBeInTheDocument();
    expect(screen.getByText(/Rs\. 1,850/)).toBeInTheDocument();
  });

  /**
   * Two refusals and one hand-off, on the screen the farmer actually sees. An
   * assistant that answers off-topic questions "just this once" is not the
   * assistant the rules describe.
   */
  it('refuses an off-topic question and hands an uncovered one to an expert', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Scan a crop' }));
    await userEvent.click(screen.getByRole('button', { name: /Take a photo/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    const box = await screen.findByPlaceholderText('Ask a follow-up question', {}, { timeout: 3000 });

    await userEvent.type(box, 'Who will win the cricket match tonight?');
    await userEvent.click(screen.getByRole('button', { name: 'Send question' }));
    expect(await screen.findByText('I can only help with farming')).toBeInTheDocument();

    await userEvent.type(box, 'Can I grow saffron on my roof?');
    await userEvent.click(screen.getByRole('button', { name: 'Send question' }));
    expect(await screen.findByText('Not in the knowledge base')).toBeInTheDocument();

    // Asking a person is an accountable action, so it is gated like the others.
    await userEvent.click(screen.getByRole('button', { name: 'Ask a verified expert' }));
    expect(await screen.findByText('Create your account')).toBeInTheDocument();
  });
});

/**
 * A phone that has used the app long enough to have written a chat document, and
 * has since removed every conversation.
 *
 * The empty state cannot be reached with the seed still in place — which is the
 * point: conversations exist from the first launch, and "no conversations yet" is
 * a state the farmer gets to by emptying the list, not by installing the app.
 */
class EmptyChatRepository implements Repository {
  readonly name = 'Empty chat document';
  readonly isRemote = true;

  /* The repository hands back the document itself; the document layer decides how
     to read its own bytes. */
  async read<T>(collection: Collection): Promise<T | null> {
    if (collection !== 'chat') return null;
    return { version: 1, threads: {}, unread: {} } as T;
  }

  async write(): Promise<void> {}
  async remove(): Promise<void> {}
}

describe('ChatScreen', () => {
  it('shows the empty state when there are no conversations', async () => {
    const base = createServices();
    render(
      <LocaleProvider>
        <ServicesProvider services={{ ...base, repository: new EmptyChatRepository() }}>
          <SessionProvider>
            <ChatProvider>
              <ChatScreen onBrowseDealers={vi.fn()} />
            </ChatProvider>
          </SessionProvider>
        </ServicesProvider>
      </LocaleProvider>,
    );

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dealers' })).toBeInTheDocument();
  });
});
