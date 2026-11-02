import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocale } from '@/i18n/LocaleProvider';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import { InsightSheets } from '@/components/insights/Insights';
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

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<InsightValue>(
    () => ({
      data,
      crops: data.crops,
      primary: primaryCrop(data),
      forCrop: (cropId) => activeForCrop(data, cropId, now),
      topFor: (cropId) => activeForCrop(data, cropId, now)[0],
      openInsightId,
      open: (insightId) => {
        setNotificationsOpen(false);
        setOpenInsightId(insightId);
        setData((current) => markViewed(current, insightId));
      },
      close: () => setOpenInsightId(null),
      act: (insightId) => {
        setData((current) => markActed(current, insightId));
        setOpenInsightId(null);
      },
      dismiss: (insightId) => {
        setData((current) => dismissIn(current, insightId));
        setOpenInsightId(null);
      },
      makePrimary: (cropId) => setData((current) => makePrimaryIn(current, cropId)),
      addCrop: (input) => setData((current) => addCropIn(current, input, Date.now())),
      chooseCrop: (input) => setData((current) => chooseCropIn(current, input, Date.now())),
      notifications: visibleNotifications(data, now),
      unread: unreadCount(data, now),
      notificationsOpen,
      openNotifications: () => setNotificationsOpen(true),
      closeNotifications: () => setNotificationsOpen(false),
      readAll: () => setData((current) => markAllRead(current)),
    }),
    [data, now, openInsightId, notificationsOpen, t],
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
