import { useState } from 'react';
import { AppTabBar, type TabKey } from '@/components/AppTabBar';
import { Toaster } from '@/components/ui/sonner';
import { ChatProvider, useChat } from '@/chat/ChatProvider';
import { CommunityProvider } from '@/community/CommunityProvider';
import { CreditProvider } from '@/credit/CreditProvider';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { InsightProvider } from '@/insights/InsightProvider';
import { ServicesProvider, type Services } from '@/services/registry';
import { SessionProvider } from '@/session/SessionProvider';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { VisitProvider } from '@/visits/VisitProvider';
import { ChatScreen } from '@/screens/ChatScreen';
import { CommunityScreen } from '@/screens/CommunityScreen';
import { DealersScreen } from '@/screens/DealersScreen';
import { HomeScreen } from '@/screens/HomeScreen';
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
type View = 'tabs' | 'profile';

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
                      <Shell />
                    </ChatProvider>
                    <Toaster position="top-center" />
                  </CommunityProvider>
                </InsightProvider>
              </CreditProvider>
            </VisitProvider>
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
          />
        ) : null}

        {view === 'tabs' && tab === 'home' ? (
          <HomeScreen
            onScan={() => setTab('scan')}
            onOpenProfile={() => setView('profile')}
            onOpenChat={openThread}
            onOpenDealers={() => setTab('dealers')}
          />
        ) : null}
        {view === 'tabs' && tab === 'dealers' ? <DealersScreen onOpenChat={openThread} /> : null}
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
