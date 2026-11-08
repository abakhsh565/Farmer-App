import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocale } from '@/i18n/LocaleProvider';
import { ownerFor, useOnline, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import { InsightSheets } from '@/components/insights/Insights';
import { track } from '@/intelligence/track';
import { getIntelligenceGateway } from '@/intelligence/client';
import { serviceConfig } from '@/services/config';
import {
  orderByServerRanking,
  recommendationForInsight,
  type RankedRecommendation,
} from '@/intelligence/feed';
import {
  usePersonalizedFeed,
  type PersonalizationStatus,
} from '@/intelligence/usePersonalizedFeed';
import { useAlerts, type AlertsStatus } from '@/intelligence/useAlerts';
import type { AlertRow } from '@/intelligence/alerts';
import {
  activeForCrop,
  addCrop as addCropIn,
  chooseCrop as chooseCropIn,
  createSeed,
  dismiss as dismissIn,
  hydrate,
  makePrimary as makePrimaryIn,
  markActed,
  markAllRead,
  markViewed,
  primaryCrop,
  serialise,
  unreadCount,
  visibleNotifications,
  type AddCropInput,
  type CropInstance,
  type Insight,
  type InsightData,
  type InsightNotification,
} from './store';

/**
 * Holds the crop instances and the canonical insights, plus which sheet is open.
 *
 * The feature, not the data, is what the lifecycle work serves: a farmer should
 * be able to open advice, act on it, dismiss it, and choose which crop is theirs
 * — and everything else must agree with that choice immediately. Hence one state
 * object with one writer, and screens that only read from it.
 */

export type InsightValue = {
  data: InsightData;
  crops: CropInstance[];
  primary: CropInstance | undefined;
  forCrop: (cropId: string) => Insight[];
  /** The one unambiguous server row behind an insight, when one exists. */
  recommendationFor: (insightId: string) => RankedRecommendation | null;
  /** Server-ranked rows; empty when the local document is the fallback. */
  personalized: RankedRecommendation[];
  personalizationStatus: PersonalizationStatus;
  refreshPersonalized: () => void;
  alerts: AlertRow[];
  alertStatus: AlertsStatus;
  unreadAlerts: number;
  refreshAlerts: () => void;
  readAlert: (notificationId: string) => Promise<boolean>;
  dismissAlert: (notificationId: string) => Promise<boolean>;
  readAllAlerts: () => Promise<number>;
  topFor: (cropId: string) => Insight | undefined;
  openInsightId: string | null;
  open: (insightId: string) => void;
  close: () => void;
  act: (insightId: string) => void;
  dismiss: (insightId: string) => void;
  makePrimary: (cropId: string) => void;
  /**
   * Adding a crop, the only way the list grows. Exposed on the provider so the
   * onboarding flow adds a crop through the same writer as every other screen
   * rather than reaching into the document itself.
   */
  addCrop: (input: AddCropInput) => void;
  /**
   * Names the farmer's main crop, adding it to the list first when they have not
   * mentioned it before. Profile's crop strip is the caller: choosing "Cotton"
   * there is both "I grow this" and "this is the one my home screen is about".
   */
  chooseCrop: (input: AddCropInput) => void;
  notifications: InsightNotification[];
  unread: number;
  notificationsOpen: boolean;
  openNotifications: () => void;
  closeNotifications: () => void;
  readAll: () => void;
};

const InsightContext = createContext<InsightValue | null>(null);

export const INSIGHT_STORAGE_KEY = 'agri-shop.insights';

/** How often "2h" is recomputed so a source line does not go quietly stale. */
const TICK_MS = 30_000;

export function InsightProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const { account } = useSession();
  /* Crops, advice and read state are the farmer's own record, so they follow the
     account as soon as there is one — his wheat does not disappear on sign-in. */
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const document = usePersistentDocument<InsightData>({
    collection: 'insights',
    ownerId,
    seed: () => createSeed(Date.now()),
    hydrate: (raw) => hydrate(raw),
    serialise,
  });
  const { data, setData } = document;
  const [now, setNow] = useState(() => Date.now());
  const [openInsightId, setOpenInsightId] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const online = useOnline();
  const personalization = usePersonalizedFeed({
    accountId: account?.id ?? null,
    enabled: Boolean(account),
    online,
    crops: data.crops,
  });
  const alertsState = useAlerts({
    accountId: account?.id ?? null,
    enabled: Boolean(account),
    online,
    crops: data.crops,
  });

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<InsightValue>(
    () => ({
      data,
      crops: data.crops,
      primary: primaryCrop(data),
      forCrop: (cropId) =>
        orderByServerRanking(activeForCrop(data, cropId, now), personalization.ranked),
      topFor: (cropId) =>
        orderByServerRanking(activeForCrop(data, cropId, now), personalization.ranked)[0],
      recommendationFor: (insightId) => {
        const insight = data.insights.find((entry) => entry.id === insightId);
        return insight
          ? recommendationForInsight(insight, data.insights, personalization.ranked)
          : null;
      },
      openInsightId,
      open: (insightId) => {
        const opened = data.insights.find((entry) => entry.id === insightId);
        if (opened) {
          track({ type: 'insight_open', subject: opened.kind, context: { screen: 'home', topic: opened.kind } });
        }
        setNotificationsOpen(false);
        setOpenInsightId(insightId);
        setData((current) => markViewed(current, insightId));
      },
      close: () => setOpenInsightId(null),
      act: (insightId) => {
        const acted = data.insights.find((entry) => entry.id === insightId);
        if (acted) {
          track({ type: 'insight_act', subject: acted.kind, context: { screen: 'home', topic: acted.kind } });
        }
        setData((current) => markActed(current, insightId));
        setOpenInsightId(null);
      },
      dismiss: (insightId) => {
        const dismissed = data.insights.find((entry) => entry.id === insightId);
        if (dismissed) {
          track({ type: 'insight_dismiss', subject: dismissed.kind, context: { screen: 'home', topic: dismissed.kind } });
        }
        if (dismissed) {
          const target = recommendationForInsight(
            dismissed,
            data.insights,
            personalization.ranked,
          );
          if (target) {
            void (async () => {
              try {
                const gateway = await getIntelligenceGateway(serviceConfig.supabase);
                await gateway?.sendFeedback({
                  key: `feedback:${target.recommendationId}:dismissed`,
                  verdict: 'dismissed',
                  recommendationId: target.recommendationId,
                  insightRef: dismissed.id,
                  context: { screen: 'home', topic: dismissed.kind },
                });
              } catch {
                /* The local dismissal is complete; feedback is best-effort. */
              }
            })();
          }
        }
        setData((current) => dismissIn(current, insightId));
        setOpenInsightId(null);
      },
      makePrimary: (cropId) => setData((current) => makePrimaryIn(current, cropId)),
      addCrop: (input) => setData((current) => addCropIn(current, input, Date.now())),
      chooseCrop: (input) => setData((current) => chooseCropIn(current, input, Date.now())),
      personalized: personalization.ranked,
      personalizationStatus: personalization.status,
      refreshPersonalized: personalization.refresh,
      alerts: alertsState.alerts,
      alertStatus: alertsState.status,
      unreadAlerts: alertsState.unread,
      refreshAlerts: alertsState.refresh,
      readAlert: alertsState.markRead,
      dismissAlert: alertsState.dismiss,
      readAllAlerts: alertsState.readAll,
      notifications: visibleNotifications(data, now),
      unread: unreadCount(data, now),
      notificationsOpen,
      openNotifications: () => setNotificationsOpen(true),
      closeNotifications: () => setNotificationsOpen(false),
      readAll: () => setData((current) => markAllRead(current)),
    }),
    [
      data,
      now,
      openInsightId,
      notificationsOpen,
      t,
      personalization.ranked,
      personalization.status,
      personalization.refresh,
      alertsState.alerts,
      alertsState.status,
      alertsState.unread,
      alertsState.refresh,
      alertsState.markRead,
      alertsState.dismiss,
      alertsState.readAll,
    ],
  );

  return (
    <InsightContext.Provider value={value}>
      {children}
      <InsightSheets />
    </InsightContext.Provider>
  );
}

export function useInsights() {
  const context = useContext(InsightContext);
  if (!context) {
    throw new Error('useInsights must be used inside an InsightProvider');
  }
  return context;
}
