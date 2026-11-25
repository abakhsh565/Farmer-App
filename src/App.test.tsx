import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { SESSION_STORAGE_KEY } from '@/session/SessionProvider';
import { markOnboardingComplete } from '@/onboarding/OnboardingFlow';
import { createServices } from '@/services/registry';
import type { AiAnswer, AiProvider } from '@/services/types';

/** Long enough for a service read to land on a loaded machine. */
const READY = { timeout: 4000 };

/**
 * A phone that already has conversations — the state the chat list is drawn
 * from. The product starts a farmer with none, so tests that are about
 * *reading* a conversation provide one rather than relying on a fixture the app
 * itself would never create.
 */
const CHAT_HISTORY = {
  version: 1,
  threads: {
    'dealer.aliTraders': [
      { id: 1, from: 'me', key: 'chat.msg1' },
      { id: 2, from: 'dealer', key: 'chat.msg2' },
      { id: 3, from: 'dealer', key: 'chat.preview.ali' },
    ],
    'dealer.greenAgro': [{ id: 1, from: 'dealer', key: 'chat.preview.greenAgro' }],
    'dealer.wazirabadAgri': [{ id: 1, from: 'dealer', key: 'chat.preview.wazirabad' }],
    'dealer.malikFertilizers': [{ id: 1, from: 'dealer', key: 'chat.preview.malik' }],
  },
  unread: { 'dealer.aliTraders': 2 },
};

const withChatHistory = (owner = ''): void => {
  localStorage.setItem(`agri-shop.chat${owner ? `.${owner}` : ''}`, JSON.stringify(CHAT_HISTORY));
};

/** A returning farmer's phone: the session document that says who is signed in. */
const ACCOUNT_ID = 'phone:03003333333';
const withSignedInFarmer = (): void => {
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
        partyId: null,
      },
      contextMigrated: true,
    }),
  );
};

beforeEach(() => {
  // Locale and theme are persisted, so a test that switches either must not leak
  // into the next one.
  localStorage.clear();
  markOnboardingComplete();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  document.documentElement.classList.remove('dark');
});

describe('App', () => {
  it('opens on Home and switches to Shop', async () => {
    render(<App />);

    // With no account yet the greeting names the guest, not a fixture farmer.
    expect(screen.getByText('Welcome back, Guest')).toBeInTheDocument();
    // Home no longer carries a mandi rates strip: every tile it could draw came
    // from the labelled non-authoritative `research_feed`, so the section showed
    // prices the app was at the same time telling the farmer not to trust. The
    // rate service still exists and is tested on its own; the surface is gone
    // (docs/UX-DECISIONS.md, "Mandi rates — the strip is gone").
    expect(screen.queryByText('Mandi rates')).toBeNull();
    expect(screen.queryByText('Rs. per 40 kg')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));

    expect(screen.getByRole('heading', { name: 'Shop' })).toBeInTheDocument();
    expect(screen.getByText('5 dealers within 10 km')).toBeInTheDocument();
  });

  /**
   * The bottom bar is the product's whole navigation. A missing destination is
   * invisible to a unit test and obvious to a user, so the five tabs are asserted
   * by name — including that "Me" is not among them.
   */
  it('offers Home, Shop, Scan, Chat and Community in the bottom bar', () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const labels = [...nav.querySelectorAll('button')].map(
      (button) => button.textContent?.trim() || button.getAttribute('aria-label'),
    );

    expect(labels).toEqual(['Home', 'Shop', 'Assistant', 'Chat', 'Community']);
    expect(screen.queryByRole('button', { name: 'Me' })).not.toBeInTheDocument();
  });

  it('carries the farmer, notifications and the profile entry in the home header', () => {
    render(<App />);

    const header = screen.getByRole('banner');
    const controls = [...header.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
    );

    // The avatar is the profile entry — named for what it opens, showing the
    // farmer's initials. The place line is a control too: it opens the
    // change-area sheet, so it is named for the screen it opens and the place it
    // currently holds. Language and appearance moved to the profile screen, so
    // the bell is the last thing in the header and the header is about the day
    // rather than about settings.
    expect(controls).toEqual([
      'Profile and settings',
      'Your location: Not set',
      'Notifications',
    ]);
    // The avatar carries the guest's initials until there is a farmer to name.
    expect(header).toHaveTextContent('Gf');
  });

  /**
   * The dealer rows on Home are the same conversations as the chat list — the
   * design draws a message button on each one, and a button that opens nothing is
   * worse than no button.
   */
  it('opens a dealer conversation from the shop list', async () => {
    render(<App />);

    /* The dealer row is a service read, so it arrives a tick after the paint. */
    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Chat with Ali Traders' }, READY),
    );

    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();
    // A shop the farmer has never written to gets an empty conversation, not
    // somebody else's words.
    expect(
      screen.getByText('No messages yet — say salam and ask what you need.'),
    ).toBeInTheDocument();
  });

  it('sends the home community section to Community', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'See all' }));

    expect(await screen.findByRole('button', { name: 'Write a post' }, READY)).toBeInTheDocument();
  });

  it('gives the weather card its spray advice in the app’s own language', async () => {
    render(<App />);

    /* The advice appears only once a usable reading has arrived: advice without a
       reading behind it is the state this screen exists to avoid. */
    expect(await screen.findByText('Best time to spray: 6 to 9 AM', {}, READY)).toBeInTheDocument();
    /* And in one language only. The card used to print the same sentence in the
       other script underneath; the absence is asserted rather than assumed, so
       the change cannot silently come back. */
    expect(screen.queryByText('چھڑکاؤ کا بہترین وقت: صبح 6 سے 9 بجے')).not.toBeInTheDocument();
    // …and the figure carries how old it is, with a way to ask for a newer
    // reading. The provider credit that used to be printed here was removed by
    // request; the age and the refresh control are what replaced it.
    expect(screen.getByText(/^updated /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('shows the dealers the service returns, with their distance and what they carry', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));

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

    // No account: the profile says so instead of showing a name and a number
    // that belong to nobody — or, after logging out, to the previous farmer.
    expect(screen.getByText('Guest farmer')).toBeInTheDocument();
    expect(screen.getByText('Tap to sign in')).toBeInTheDocument();
    /*
     * The farm at a glance, read from the farmer's own stores. On a clean install
     * the farmer has told this app nothing, so the strip says so: no crops, none
     * counted, and no village saved. It used to assert "8 acres" — a fixture
     * rendered as this farmer's land, on a phone where nothing had ever asked
     * them for an acreage and nothing could correct it.
     */
    expect(screen.queryByText('No crops yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ crops?/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'My Crops' })).toHaveLength(2);
    expect(screen.queryByText('8 acres')).not.toBeInTheDocument();
    expect(screen.getByText('My Dealers')).toBeInTheDocument();
    expect(screen.getByText('Farm Details')).toBeInTheDocument();
    expect(screen.getByText('Help & Support')).toBeInTheDocument();
    /* A guest sees the way in, not the way out: signing out and deleting the
       account are authenticated-only controls. */
    expect(screen.queryByText('Create an account')).not.toBeInTheDocument();
    expect(screen.queryByText('Log Out')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();
    // The tab bar is hidden while a pushed screen is open.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('sends My Dealers to the Shop tab', async () => {
    withSignedInFarmer();
    render(<App />);

    await openProfile();
    await userEvent.click(screen.getByRole('button', { name: /My Dealers/ }));

    expect(screen.getByRole('heading', { name: 'Shop' })).toBeInTheDocument();
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

    expect(screen.getByText(/دوبارہ خوش آمدید/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دکان' })).toBeInTheDocument();
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
    withChatHistory();
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
    withChatHistory();
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));

    const unread = screen.getByRole('button', { name: /Ali Traders.*2 unread messages/ });
    await userEvent.click(unread);
    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: /unread messages/ })).toBeNull();
  });

  it('opens a dealer thread from the Shop screen', async () => {
    withChatHistory();
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Chat with Ali Traders' }));

    expect(screen.getByText('Assalam o Alaikum. Do you have Roundup in stock?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a message')).toBeInTheDocument();
  });

  it('sends a message into the open thread', async () => {
    withSignedInFarmer();
    withChatHistory(ACCOUNT_ID);
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    await userEvent.click(screen.getByRole('button', { name: /Ali Traders/ }));

    await userEvent.type(screen.getByPlaceholderText('Type a message'), 'Bhai, kal bhej dein');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getByText('Bhai, kal bhej dein')).toBeInTheDocument();
  });

  it('keeps the conversation history when the language changes', async () => {
    withChatHistory();
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
  /*
   * The camera flow, reached the way a farmer reaches it now: the Home card's
   * *Crop check* row. It used to be the middle tab, and the tab is the assistant's.
   */
  it('walks from the Crop check row on Home through a photo to a diagnosis', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: /Crop check/ }));
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

    /*
     * The conversation is not here any more. The scanner is a photo flow that
     * ends in a verdict, and the proof is that the screen which used to end in a
     * composer has no composer at all.
     */
    expect(screen.queryByPlaceholderText('Ask a follow-up question')).toBeNull();
    /* A pushed screen, so the tab bar is out of the way while it is open. */
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    // Back leaves the result for the start of the flow, and Back again leaves it.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Shop' }));

    // The same product on the same shop's page, at the same price.
    await userEvent.click(await screen.findByRole('button', { name: /^Ali Traders/ }, READY));
    expect(await screen.findByText('Roundup', {}, READY)).toBeInTheDocument();
    expect(screen.getByText(/Rs\. 1,850/)).toBeInTheDocument();
  });
});

describe('assistant', () => {
  /** The tab, and the composer it opens on. */
  const openAssistant = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    return screen.findByPlaceholderText('Ask about your crop…');
  };

  /**
   * A conversation, not a tab. Opening the assistant hides the tab bar and the
   * back button is the way out — and the allowance, which used to be a line of
   * small print under the title, is now a control that explains the rule behind
   * the number instead of leaving "97 of 100" to be guessed at.
   */
  it('takes the whole screen, explains the credits, and goes back to its tab', async () => {
    render(<App />);
    await openAssistant();

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'AI credits today' }));
    expect(
      await screen.findByText('A question costs 1 · a photo costs 5', {}, READY),
    ).toBeInTheDocument();
    expect(screen.getByText(/Allowance returns after/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('navigation', {}, READY)).toBeInTheDocument();
  });

  /**
   * The answer is the server assistant's, and the crop is not guessed: the
   * assistant asks without a crop code and the gateway adds the farmer's own
   * crops, district and interests from the session.
   */
  it('sends a question to the server assistant and renders its answer', async () => {
    const ask = vi.fn(async () => ({
      gate: 'agriculture' as const,
      confidence: 88,
      text: 'Scout the field first, then treat only if you find the pest.',
      citations: [],
      escalate: false,
      caveats: [],
      metadata: {
        scoring_version: 2,
        farmer_context_available: true,
        context_categories: ['crops' as const],
        knowledge_sources: ['cotton-pink-bollworm'],
      },
    }));
    const fakeAi: AiProvider = {
      name: 'Test assistant',
      ask,
      diagnose: async () => {
        throw new Error('diagnosis is not used by this test');
      },
    };
    const services = createServices();
    services.ai = fakeAi;
    render(<App services={services} />);

    const box = await openAssistant();
    await userEvent.type(box, 'How do I treat bollworm?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(
      await screen.findByText('Scout the field first, then treat only if you find the pest.'),
    ).toBeInTheDocument();
    expect(ask).toHaveBeenCalledWith('How do I treat bollworm?', { language: 'en' });
  });

  /**
   * The evidence under an answer, and the honesty label above it: a retrieval-only
   * answer says so rather than passing itself off as the model's own words.
   */
  it('shows source trust and labels a retrieval-only answer', async () => {
    const answer: AiAnswer = {
      gate: 'agriculture',
      confidence: 86,
      text: 'Count 5 larvae per 100 bolls before deciding to spray.',
      citations: [
        {
          kind: 'knowledge',
          label: 'Pink bollworm economic threshold',
          version: 1,
          slug: 'cotton-pink-bollworm-etl',
          source: 'Punjab Agriculture Department',
          sourceUrl: 'https://agripunjab.gov.pk/pw_economic',
          evidenceTier: 'verified',
          accessedOn: '2026-11-03',
        },
        {
          kind: 'knowledge',
          label: 'Pink bollworm in cotton',
          version: 3,
          slug: 'cotton-pink-bollworm',
          source: 'Farmer App editorial notes',
          evidenceTier: 'supplementary',
          accessedOn: '2026-11-03',
        },
      ],
      escalate: false,
      caveats: ['The AI model is unavailable.'],
      generation: 'retrieval',
      metadata: {
        scoring_version: null,
        farmer_context_available: false,
        context_categories: [],
        knowledge_sources: ['cotton-pink-bollworm-etl'],
      },
    };
    const fakeAi: AiProvider = {
      name: 'Retrieval fallback',
      ask: async () => answer,
      diagnose: async () => {
        throw new Error('diagnosis is not used by this test');
      },
    };
    const services = createServices();
    services.ai = fakeAi;
    render(<App services={services} />);

    const box = await openAssistant();
    await userEvent.type(box, 'How many pink bollworm should trigger a spray?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(
      await screen.findByText('Published guidance only · the AI model is unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByText('Pink bollworm economic threshold')).toBeInTheDocument();
    expect(screen.getByText('Source-verified')).toBeInTheDocument();
    expect(screen.getByText('Supplementary')).toBeInTheDocument();
    expect(screen.getByText('Punjab Agriculture Department')).toBeInTheDocument();
    expect(screen.getByText('Farmer App editorial notes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute(
      'href',
      'https://agripunjab.gov.pk/pw_economic',
    );
  });

  /**
   * The live call failing must not read as the assistant having nothing to say.
   * The deterministic gate still answers, and the screen says which of the two
   * spoke — that sentence is the difference between degraded and broken.
   */
  it('falls back to the offline gate when the assistant cannot be reached', async () => {
    let rejectAsk: ((error: Error) => void) | null = null;
    const ask = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectAsk = reject;
        }),
    );
    const fakeAi: AiProvider = {
      name: 'Offline assistant',
      ask,
      diagnose: async () => {
        throw new Error('diagnosis is not used by this test');
      },
    };
    const services = createServices();
    services.ai = fakeAi;
    render(<App services={services} />);

    const box = await openAssistant();
    await userEvent.type(box, 'Who will win the cricket match tonight?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The thinking state says what it is doing, in words beside the dots.
    expect((await screen.findAllByText('Looking that up…')).length).toBeGreaterThan(0);
    await act(async () => {
      rejectAsk?.(new Error('offline'));
    });

    expect(
      await screen.findByText('The live assistant could not be reached. This is the offline guidance.'),
    ).toBeInTheDocument();
    expect(screen.getByText('I can only help with farming')).toBeInTheDocument();
  });

  /**
   * A question and its answer are kept. This is the store working rather than the
   * screen: the app is unmounted and opened again, and the conversation is still
   * there because it went to the phone's own document.
   */
  it('keeps the conversation after the app is reopened', async () => {
    const open = render(<App />);

    const box = await openAssistant();
    await userEvent.type(box, 'What is the weather like today?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByText(/Right now it is|The weather could not be read/),
    ).toBeInTheDocument();

    open.unmount();
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Assistant' }));

    expect(screen.getByText('What is the weather like today?')).toBeInTheDocument();
  });

  it('answers in Urdu, right to left, when the app is in Urdu', async () => {
    localStorage.setItem('agri-shop.locale', 'ur');
    render(<App />);

    expect(document.documentElement.dir).toBe('rtl');
    await userEvent.click(screen.getByRole('button', { name: 'معاون' }));

    expect(await screen.findByText('اپنی فصل کے بارے میں پوچھیں')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('اپنی فصل کے بارے میں پوچھیں…')).toBeInTheDocument();
  });

  /** Two refusals and one hand-off, on the screen the farmer actually sees. */
  it('refuses an off-topic question and hands an uncovered one to an expert', async () => {
    render(<App />);

    const box = await openAssistant();

    await userEvent.type(box, 'Who will win the cricket match tonight?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('I can only help with farming')).toBeInTheDocument();

    await userEvent.type(box, 'Can I grow saffron on my roof?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not in the knowledge base')).toBeInTheDocument();

    // Asking a person is an accountable action, so it is gated like the others.
    await userEvent.click(screen.getByRole('button', { name: 'Ask a verified expert' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('ChatScreen', () => {
  /**
   * The empty state is the first launch now, not a state a farmer reaches by
   * emptying the list: a conversation is private correspondence, and nobody
   * starts with one.
   */
  it('shows the empty state when there are no conversations', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));

    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    // The nav tab ("Shop") and the empty state's own action ("Dealers") both lead there.
    expect(screen.getByRole('button', { name: 'Dealers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shop' })).toBeInTheDocument();
  });
});
