import { lazy, Suspense, useState } from 'react';
import { AppTabBar, type TabKey } from '@/components/AppTabBar';
import { Toaster } from '@/components/ui/sonner';
import { ChatProvider, useChat } from '@/chat/ChatProvider';
import { CommunityProvider } from '@/community/CommunityProvider';
import { AiCreditsProvider } from '@/aiagent/AiCreditsProvider';
import { CreditProvider } from '@/credit/CreditProvider';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { InsightProvider } from '@/insights/InsightProvider';
import { LocationProvider } from '@/location/LocationProvider';
import {
  isOnboardingComplete,
  OnboardingFlow,
} from '@/onboarding/OnboardingFlow';
import { ServicesProvider, type Services } from '@/services/registry';
import { SessionProvider } from '@/session/SessionProvider';
import { SpeechProvider } from '@/speech/SpeechProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { VisitProvider } from '@/visits/VisitProvider';
import { ChatScreen } from '@/screens/ChatScreen';
import { CommunityScreen } from '@/screens/CommunityScreen';
import { DealersScreen } from '@/screens/DealersScreen';
import { HomeScreen } from '@/screens/HomeScreen';
import { AlertSettingsScreen } from '@/screens/AlertSettingsScreen';
import { InterestsScreen } from '@/screens/InterestsScreen';
import { LocationSearchScreen } from '@/screens/LocationSearchScreen';
import { SearchScreen } from '@/screens/SearchScreen';
import { ProfileScreen } from '@/screens/ProfileScreen';
import { AssistantScreen } from '@/screens/AssistantScreen';
import { ScanScreen } from '@/screens/ScanScreen';
import { DealerDetailScreen } from '@/screens/DealerDetailScreen';
import { ProductDetailScreen } from '@/screens/ProductDetailScreen';
import { WeatherScreen } from '@/screens/WeatherScreen';
import { ShopJoinDialog } from '@/shop/ShopJoinDialog';
import { ShopApiProvider, useShopApi } from '@/shop/ShopApiProvider';
import { useShopJoin } from '@/shop/useShopJoin';
import { useShopPush } from '@/shop/useShopPush';

/**
 * The reviewer workspace is the one screen a farmer never opens: it is gated by
 * a server-derived authority and reached from Profile by reviewers alone. Its
 * editor, dialogs and review forms are ~60 kB, so loading it on demand keeps
 * that work out of the first paint every farmer pays for.
 */
const ReviewScreen = lazy(() =>
  import('@/screens/ReviewScreen').then((module) => ({ default: module.ReviewScreen })),
);

/**
 * Two levels of navigation: the tab bar, and one pushed screen on top of it.
 *
 * Profile is deliberately not a sixth tab. The bar already carries the five
 * things a farmer does daily, and settings are not one of them — so it is reached
 * from the home header and pushes over the tabs, which is also why the bar is
 * hidden while it is open.
 */
type View =
  | 'tabs'
  | 'profile'
  | 'interests'
  | 'alerts'
  | 'review'
  | 'locationSearch'
  | 'search'
  | 'weather'
  /*
   * The camera flow, pushed rather than tabbed.
   *
   * It was the middle tab until the assistant took that slot. Scanning is now
   * reached from the one place a farmer already goes when a plant looks wrong —
   * the Home card's *Crop check* row — and from a photo attached to a question.
   * Pushed means the tab bar is out of the way while a photo is being taken, which
   * is also why Profile and Weather are pushed.
   */
  | 'scan';

/**
 * The two detail pages.
 *
 * They are pushed rather than shown in a sheet: a shop and a product both carry
 * more than a sheet can hold, and each links to the other. Which is exactly why
 * they are a stack — a shop's page lists products, a product's page lists shops,
 * and following that trail has to be walkable in both directions. Two "where did
 * I come from" variables could not do it: opening a shop from a product made the
 * shop's "back" point at the product, and the product's "back" point at the shop,
 * so Back bounced between the two pages forever instead of reaching the list.
 * A stack records the trail itself, so Back always unwinds one real step.
 */
type Detail =
  | { kind: 'dealer'; dealerId: string }
  | { kind: 'product'; canonicalProductId: string; dealerId: string | null };

/**
 * The whole app.
 *
 * `services` is an injection seam, not a feature: it lets a test run the real
 * screens, the real stores and the real rules against a backend that is slow,
 * offline or refusing writes. Without it the states that matter most — loading,
 * retry, a queue draining after a reconnect — could only be tested by pretending
 * they happened.
 *
 * Every store lives above the tab bar, in a fixed order, because each one owns
 * state that outlives the screen that shows it: a half-written reply survives a
 * trip to the mandi rates, a credit counteroffer opened from an alert is the same
 * sheet as the one opened from the Home card, and a sent message is still sent
 * after the app is reopened. Identity sits above all of them because every
 * accountable action asks it one question first.
 */
export function App({ services }: { services?: Services } = {}) {
  return (
    <ThemeProvider>
      <LocaleProvider>
        {/*
          Services sit above the stores on purpose. Each store reads and writes
          through this layer rather than reaching for localStorage, so the swap
          from device storage to the backend happens in one place and the screens
          never learn about it.
        */}
        <ServicesProvider services={services}>
          <SessionProvider>
            {/*
              Location sits directly under identity because it depends on it: the
              saved location belongs to an account, so it is loaded when there is
              one and dropped when there is not. Every location-dependent read
              (weather, dealers, the assistant's context) is above the tab bar for
              the same reason the stores are — switching tabs must not change the
              answer.
            */}
            <LocationProvider>
            <VisitProvider>
              <CreditProvider>
                <InsightProvider>
                  {/*
                   * The community feed sits above the screens rather than inside
                   * the tab, so a half-written reply survives a trip to the mandi
                   * rates and back — and so the feed's own state is one object
                   * instead of one per mount.
                   */}
                  <CommunityProvider>
                    {/*
                      The shop sits above the chat because the chat is one of its
                      faces: when a shop backend is configured, the conversation,
                      the offers and the notices all come from there. Above the
                      chat rather than inside it, so the shop survives a trip to
                      another tab the way every other store does.
                    */}
                    <ShopApiProvider>
                    {/* Conversations, same idea: one chat document, opened from
                        wherever the farmer happens to be standing. */}
                    <ChatProvider>
                      {/*
                        Read-aloud sits above the screens that offer it — the
                        weather card today — so the same voice reads whatever
                        they say, and leaving one screen can stop what it
                        started. It is a capability of the device, so it is
                        mounted here rather than inside a screen that would
                        then have to import the other one's.
                      */}
                      <SpeechProvider>
                        <AiCreditsProvider>
                          <Shell />
                        </AiCreditsProvider>
                      </SpeechProvider>
                    </ChatProvider>
                    </ShopApiProvider>
                    <Toaster position="top-center" />
                  </CommunityProvider>
                </InsightProvider>
              </CreditProvider>
            </VisitProvider>
            </LocationProvider>
          </SessionProvider>
        </ServicesProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}

/** The screens and the tab bar — the part that needs the stores above it. */
function Shell() {
  const chat = useChat();
  const { t } = useLocale();
  const [view, setView] = useState<View>('tabs');
  const [tab, setTab] = useState<TabKey>('home');
  /*
   * A scan arrives as a `?join=` parameter on the launch URL, so it is read here
   * — above the tab bar — and shown over whatever the farmer was doing. Opening
   * the app from a shop's sticker must not depend on which tab was last used.
   */
  const shopJoin = useShopJoin();
  /*
   * Where the place-search screen goes back to. It is opened from the dealer
   * filter and from Profile's own location slot, and it has to return the farmer
   * to the screen they left — landing on the dealer list after changing a village
   * from Profile would lose their place.
   */
  const [locationReturn, setLocationReturn] = useState<View>('tabs');
  /*
   * Which half of the Shop tab is showing. It lives here so it survives a trip
   * into a dealer or a product page — those are pushed screens, and the list under
   * them is unmounted while they are open.
   */
  const [shopSection, setShopSection] = useState<'products' | 'dealers'>('dealers');
  /*
   * The detail trail: the shop or product currently open, and everything it was
   * reached through. Back pops one entry, so shop → product → shop → Back lands
   * on the product that was actually visited, and the next Back keeps unwinding
   * towards the list — never back into the page it just left.
   */
  const [details, setDetails] = useState<Detail[]>([]);
  const detail: Detail | null = details.length > 0 ? (details[details.length - 1] ?? null) : null;

  /*
   * First run, before anything else. It sits here rather than in `App` because
   * the flow's last two steps choose a language and a crop through the locale
   * and insight providers — so it has to be *inside* them, not above them.
   *
   * Read once into state: the flag is a device preference, and re-reading it on
   * every render would restart the flow the moment it was written.
   */
  const [onboarded, setOnboarded] = useState(isOnboardingComplete);
  /*
   * A tap on the shop's notification opens the conversation — `data.route` is `/`,
   * which for a farmer means exactly this. It is wired above the early return so
   * the listener exists for the whole session, and it drives navigation through
   * the same tab and thread state the rest of the app uses rather than through a
   * URL the app has no router for.
   */
  const shop = useShopApi();
  useShopPush(() => {
    const shopId = shop.credential?.shopId;
    if (shopId) chat.openThread(shopId);
    setDetails([]);
    setView('tabs');
    setTab('chat');
  });

  /**
   * Opening a conversation from a dealer row, the chat list or the Scan result
   * lands on Chat with it already open — the same destination, whichever door the
   * farmer came through. Reading a thread is also what clears its unread count, so
   * the badge reflects something they actually did rather than a timer.
   */
  const openThread = (dealerId: string) => {
    chat.openThread(dealerId);
    /*
     * A conversation opened from a shop or a product leaves the detail trail: the
     * thread lives on the Chat tab, and setting the tab while a detail page was
     * still the visible screen changed nothing the farmer could see.
     */
    setDetails([]);
    setView('tabs');
    setTab('chat');
  };

  /** A shop's own page, pushed onto wherever the farmer already was. */
  const openDealer = (dealerId: string) => {
    setDetails((stack) => [...stack, { kind: 'dealer', dealerId }]);
  };

  /** One product's page, pushed the same way — which is what makes the two
      pages link in both directions without one of them owning the other. */
  const openProduct = (target: { canonicalProductId: string; dealerId: string | null }) => {
    setDetails((stack) => [...stack, { kind: 'product', ...target }]);
  };

  /** One step back along the trail; the list itself when it runs out. */
  const closeDetail = () => setDetails((stack) => stack.slice(0, -1));

  /*
   * First run, or the app. Not both.
   *
   * The flow is returned *instead of* the tabs rather than layered over them:
   * the screens beneath are data-driven, and letting them mount and fetch while
   * nobody can see them would have a first-run farmer's device asking the
   * backend questions for a screen they have not reached.
   */
  if (!onboarded) {
    return <OnboardingFlow onDone={() => setOnboarded(true)} />;
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] flex-col bg-background text-foreground">
      <main className="flex-1 overflow-y-auto">
        {view === 'profile' ? (
          <ProfileScreen
            onBack={() => setView('tabs')}
            onOpenDealers={() => {
              setView('tabs');
              setTab('dealers');
            }}
            onOpenInterests={() => setView('interests')}
            onOpenAlerts={() => setView('alerts')}
            onOpenReview={() => setView('review')}
            onOpenLocationSearch={() => {
              setLocationReturn('profile');
              setView('locationSearch');
            }}
          />
        ) : null}

        {/* Advice preferences, pushed from Profile so the tab bar stays out of
            the way and Back returns to the settings list the farmer left. */}
        {view === 'interests' ? (
          <InterestsScreen onBack={() => setView('profile')} />
        ) : null}

        {/* Alert preferences are account settings, pushed from Profile. */}
        {view === 'alerts' ? (
          <AlertSettingsScreen onBack={() => setView('profile')} />
        ) : null}

        {/* The reviewer workspace is pushed from Profile and is gated by the
            server-derived named authority, not by the presence of this route. */}
        {view === 'review' ? (
          <Suspense
            fallback={
              <div
                role="status"
                aria-live="polite"
                className="px-8 py-14 text-center text-body-sm text-muted-foreground"
              >
                {t('review.loading')}
              </div>
            }
          >
            <ReviewScreen onBack={() => setView('profile')} />
          </Suspense>
        ) : null}

        {/*
          Finding your area by name. It comes from the filter sheet rather than
          from a button beside it, and it returns to the list the moment a place
          is tapped — the save has already happened by then.
        */}
        {view === 'locationSearch' ? (
          <LocationSearchScreen onBack={() => setView(locationReturn)} />
        ) : null}

        {/*
          Search is a page rather than a box in the list, because the answer has
          two halves — a shop and a stock list — and the list could only show one
          of them.
        */}
        {/*
          Hidden rather than unmounted while a shop or product page sits on top:
          the keyword, which half of the answer is showing and what is typed in
          the box all survive the trip, so Back returns to the results that were
          left instead of to an empty search form.
        */}
        {view === 'search' ? (
          <div className={detail !== null ? 'hidden' : undefined}>
            <SearchScreen
              onBack={() => setView('tabs')}
              onOpenChat={(dealerId) => {
                openThread(dealerId);
                setView('tabs');
              }}
              onOpenDealer={openDealer}
              onOpenProduct={openProduct}
            />
          </div>
        ) : null}

        {/* The Home weather card at full size. A pushed screen, like Profile, so
            the tab bar is out of the way while the sky has the room. */}
        {view === 'weather' ? <WeatherScreen onBack={() => setView('tabs')} /> : null}

        {/* The camera flow, pushed from the Home card's *Crop check* row. Its own
            Back leaves the flow; *View dealers* leaves it too, and lands on the
            tab the treatment points at rather than on Home. */}
        {view === 'scan' ? (
          <ScanScreen
            onBack={() => setView('tabs')}
            onOpenDealers={() => {
              setView('tabs');
              setTab('dealers');
            }}
          />
        ) : null}

        {/* Whatever is on top of the detail trail: a shop in full, or one
            product with its catalogue entry above and the shops that list it
            below. Both read the services rather than a list held in a screen. */}
        {detail !== null ? (
          detail.kind === 'dealer' ? (
            <DealerDetailScreen
              dealerId={detail.dealerId}
              onBack={closeDetail}
              onOpenChat={openThread}
              onOpenProduct={openProduct}
            />
          ) : (
            <ProductDetailScreen
              canonicalProductId={detail.canonicalProductId}
              dealerId={detail.dealerId}
              onBack={closeDetail}
              onOpenDealer={openDealer}
              onOpenChat={openThread}
            />
          )
        ) : null}

        {view === 'tabs' && detail === null && tab === 'home' ? (
          <HomeScreen
            onScan={() => setView('scan')}
            onOpenProfile={() => setView('profile')}
            onOpenWeather={() => setView('weather')}
            onOpenLocationSearch={() => {
              setLocationReturn('tabs');
              setView('locationSearch');
            }}
            onOpenCommunity={() => setTab('community')}
          />
        ) : null}
        {view === 'tabs' && detail === null && tab === 'dealers' ? (
          <DealersScreen
            section={shopSection}
            onSectionChange={setShopSection}
            onOpenChat={openThread}
            onOpenShopChat={(shopId) => {
              openThread(shopId);
              setTab('chat');
            }}
            onOpenSearch={() => setView('search')}
            onOpenDealer={openDealer}
            onOpenProduct={openProduct}
            onOpenLocationSearch={() => {
              setLocationReturn('tabs');
              setView('locationSearch');
            }}
          />
        ) : null}
        {view === 'tabs' && detail === null && tab === 'assistant' ? (
          <AssistantScreen onBack={() => setTab('home')} />
        ) : null}
        {view === 'tabs' && detail === null && tab === 'chat' ? (
          <ChatScreen onBrowseDealers={() => setTab('dealers')} />
        ) : null}
        {view === 'tabs' && detail === null && tab === 'community' ? <CommunityScreen /> : null}
      </main>

      {/* Over the tabs, under nothing: a join is a single question and the app
          stays where it was once it is answered. */}
      <ShopJoinDialog
        state={shopJoin.state}
        onClose={shopJoin.dismiss}
        onOpenShop={(dealerId) => {
          setView('tabs');
          openDealer(dealerId);
        }}
      />

      {/* The assistant is the one tab that takes the whole screen: a conversation
          with a tab bar under the composer reads as a form. Back returns to the
          tab it was opened from, so nothing needs the bar to be escapable. */}
      {view === 'tabs' && detail === null && tab !== 'assistant' ? (
        <AppTabBar
          value={tab}
          onChange={(next) => {
            if (next !== 'chat') chat.closeThread();
            setTab(next);
          }}
        />
      ) : null}
    </div>
  );
}
