import { useState } from 'react';
import { AppTabBar, type TabKey } from '@/components/AppTabBar';
import { Toaster } from '@/components/ui/sonner';
import { ChatProvider, useChat } from '@/chat/ChatProvider';
import { CommunityProvider } from '@/community/CommunityProvider';
import { CreditProvider } from '@/credit/CreditProvider';
import { LocaleProvider } from '@/i18n/LocaleProvider';
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
import { LocationSearchScreen } from '@/screens/LocationSearchScreen';
import { SearchScreen } from '@/screens/SearchScreen';
import { ProfileScreen } from '@/screens/ProfileScreen';
import { ScanScreen } from '@/screens/ScanScreen';

/**
 * Two levels of navigation: the tab bar, and one pushed screen on top of it.
 *
 * Profile is deliberately not a sixth tab. The bar already carries the five
 * things a farmer does daily, and settings are not one of them — so it is reached
 * from the home header and pushes over the tabs, which is also why the bar is
 * hidden while it is open.
 */
type View = 'tabs' | 'profile' | 'locationSearch' | 'search';

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
                        <Shell />
                      </SpeechProvider>
                    </ChatProvider>
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
  const [view, setView] = useState<View>('tabs');
  const [tab, setTab] = useState<TabKey>('home');
  /*
   * Where the place-search screen goes back to. It is opened from the dealer
   * filter and from Profile's own location slot, and it has to return the farmer
   * to the screen they left — landing on the dealer list after changing a village
   * from Profile would lose their place.
   */
  const [locationReturn, setLocationReturn] = useState<View>('tabs');

  /*
   * First run, before anything else. It sits here rather than in `App` because
   * the flow's last two steps choose a language and a crop through the locale
   * and insight providers — so it has to be *inside* them, not above them.
   *
   * Read once into state: the flag is a device preference, and re-reading it on
   * every render would restart the flow the moment it was written.
   */
  const [onboarded, setOnboarded] = useState(isOnboardingComplete);

  /**
   * Opening a conversation from a dealer row, the chat list or the Scan result
   * lands on Chat with it already open — the same destination, whichever door the
   * farmer came through. Reading a thread is also what clears its unread count, so
   * the badge reflects something they actually did rather than a timer.
   */
  const openThread = (dealerId: string) => {
    chat.openThread(dealerId);
    setTab('chat');
  };

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
            onOpenLocationSearch={() => {
              setLocationReturn('profile');
              setView('locationSearch');
            }}
          />
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
        {view === 'search' ? (
          <SearchScreen
            onBack={() => setView('tabs')}
            onOpenChat={(dealerId) => {
              openThread(dealerId);
              setView('tabs');
            }}
          />
        ) : null}

        {view === 'tabs' && tab === 'home' ? (
          <HomeScreen
            onScan={() => setTab('scan')}
            onOpenProfile={() => setView('profile')}
            onOpenLocationSearch={() => {
              setLocationReturn('tabs');
              setView('locationSearch');
            }}
            onOpenCommunity={() => setTab('community')}
          />
        ) : null}
        {view === 'tabs' && tab === 'dealers' ? (
          <DealersScreen
            onOpenChat={openThread}
            onOpenSearch={() => setView('search')}
            onOpenLocationSearch={() => {
              setLocationReturn('tabs');
              setView('locationSearch');
            }}
          />
        ) : null}
        {view === 'tabs' && tab === 'scan' ? (
          <ScanScreen onOpenDealers={() => setTab('dealers')} />
        ) : null}
        {view === 'tabs' && tab === 'chat' ? (
          <ChatScreen onBrowseDealers={() => setTab('dealers')} />
        ) : null}
        {view === 'tabs' && tab === 'community' ? <CommunityScreen /> : null}
      </main>

      {view === 'tabs' ? (
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
