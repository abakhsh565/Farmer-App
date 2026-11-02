import { useState } from 'react';
import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CreditCard,
  HelpCircle,
  Languages,
  Layers,
  LogIn,
  MapPin,
  Pencil,
  Sprout,
  Store,
  SunMoon,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useCredit } from '@/credit/CreditProvider';
import { useInsights } from '@/insights/InsightProvider';
import { useLocation } from '@/location/LocationProvider';
import { CROP_CHOICES } from '@/onboarding/OnboardingFlow';
import { useSession } from '@/session/SessionProvider';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useLocale } from '@/i18n/LocaleProvider';
import type { Locale } from '@/i18n/catalog';
import { formatMoney } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { configurationReport } from '@/services/config';
import { useSyncHealth } from '@/services/persistence';
import { useTheme, type Theme } from '@/theme/ThemeProvider';

/**
 * Profile — who the farmer is, their farm at a glance, and everything that is
 * about *them* rather than about the crop.
 *
 * Language and appearance live here rather than in the home header, which was
 * carrying three controls inside the row that holds the farmer's own name. Both
 * are rows showing their current value, and tapping opens the choice: the value is
 * then visible before you open anything, which a segmented control hides.
 */
export function ProfileScreen({
  onBack,
  onOpenDealers,
  onOpenLocationSearch,
}: {
  onBack: () => void;
  onOpenDealers: () => void;
  onOpenLocationSearch: () => void;
}) {
  const { t, locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  const { account, signOut, prompt } = useSession();
  const credit = useCredit();
  const insights = useInsights();
  const location = useLocation();

  /*
   * No account yet. Everything the screen shows about a farmer is then something
   * they can still set: the crop and the area are theirs either way — they live
   * on the phone and are handed to the account when one is made — so the strip is
   * a control rather than a caption. What is not theirs yet is an account's own
   * record, and those rows ask for the account instead of showing a number that
   * would be somebody's.
   */
  const guest = account === null;
  const [setting, setSetting] = useState<'crops' | 'location' | null>(null);

  /*
   * These three used to be catalog strings — "Cotton", "8 acres", "Wazirabad" —
   * shown as the farmer's own farm on every install. That is the same defect as
   * the hard-coded name this screen already fixed: a figure that belongs to
   * nobody reads as the previous farmer's, and there is no way to correct it
   * because nothing in the app collects an acreage.
   *
   * So each is now read from the store that actually holds it, and says plainly
   * that it is unknown when that store has nothing. The strip is still three
   * figures; they are just true ones.
   */
  const mainCrop = insights.primary;
  const village = location.saved?.label ?? location.placeLabel;

  /*
   * What each of the three figures says, which depends on who is reading.
   *
   * Signed in, they are the account's own record and say so when they are
   * unknown. Before that, an answer the farmer never gave is left *empty* rather
   * than filled with a stand-in: a strip that reads "No crops yet" next to a
   * cotton icon reads as a fact about them, and the empty slot is the control
   * that fills it. A point without a name still gets the honest one — the app
   * knows where the phone is, it just has no village to call it.
   */
  const cropStat = mainCrop ? t(mainCrop.nameKey) : guest ? '' : t('farmer.noCrops');
  const countStat =
    guest && insights.crops.length === 0
      ? ''
      : t('farmer.cropCount', { count: insights.crops.length });
  const placeStat =
    village || (!guest || location.hasSaved || location.isTemporary ? t('location.current') : '');

  /*
   * The figure is read from the farmer's own credit book. It used to be a
   * constant copied from the home card, which happened to agree with the demo
   * fixture it came from — and would have kept saying 3,330 after the farmer
   * paid it off, or shown someone else's debt on a phone that changed hands.
   */
  const outstanding = credit.data.agreements.reduce(
    (sum, agreement) => (agreement.closedAt === null ? sum + credit.outstandingOf(agreement) : sum),
    0,
  );

  return (
    <div className="flex flex-col px-4 pt-4 pb-6">
      {/* The design opens on the farmer's own details with no title bar, so the
          heading is here for assistive technology rather than on screen. */}
      <h1 className="sr-only">{t('profile.title')}</h1>

      <button
        type="button"
        aria-label={t('common.back')}
        onClick={onBack}
        className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
      >
        <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
      </button>

      {/*
        The farmer's own name and contact, or the way in.

        A guest has no name to show, so the whole row *is* the sign-in control —
        avatar, label and all — rather than a name with a separate button beside
        it. That keeps the account out of Profile as its own section (which it no
        longer is) while leaving one obvious place to sign in.

        Never a fixture: a hard-coded name and number here read as the previous
        farmer still being signed in, which is the one thing this screen must not do.
        */}
      {account ? (
        <div className="mt-2 flex items-center gap-3.5">
          <span className="grid size-15 shrink-0 place-items-center rounded-full bg-brand text-title font-medium text-brand-foreground">
            {initialsOf(account.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-heading">{account.name}</span>
            <span className="mt-0.5 block truncate text-label text-muted-foreground">
              {account.phone ?? account.email ?? ''}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              signOut();
              toast.success(t('profile.account.signedOut'));
            }}
            className="shrink-0 rounded-full border border-border px-3.5 py-2 text-label text-muted-foreground"
          >
            {t('profile.logout')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => prompt('profile.account.createReason')}
          className="mt-2 flex w-full items-center gap-3.5 text-start"
        >
          <span className="grid size-15 shrink-0 place-items-center rounded-full bg-brand-soft text-title font-medium text-brand">
            {initialsOf(t('farmer.guestName'))}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-heading">{t('farmer.guestName')}</span>
            <span className="mt-0.5 block truncate text-label text-muted-foreground">
              {t('farmer.guestContact')}
            </span>
          </span>
          {/* `rtl:rotate-180` because the icon is a direction, not a decoration:
              a door with an arrow going in. In an Urdu screen the way in is to
              the left, and an arrow still pointing right points at nothing. */}
          <LogIn className="size-5 shrink-0 text-brand rtl:rotate-180" aria-hidden />
        </button>
      )}

      {/*
        The farmer's own three facts, and — before there is an account — the way
        to set them. What onboarding collected is what shows here, because it is
        read from the stores that hold it rather than from a fixture.
      */}
      <div className="mt-3.5 flex justify-around rounded-lg bg-surface-inverted p-3.5 text-center">
        <Stat
          icon={Sprout}
          label={cropStat}
          action={guest ? t('profile.crops') : undefined}
          onClick={guest ? () => setSetting('crops') : undefined}
        />
        <Divider />
        <Stat
          icon={Layers}
          label={countStat}
          action={guest ? t('profile.crops') : undefined}
          onClick={guest ? () => setSetting('crops') : undefined}
        />
        <Divider />
        <Stat
          icon={MapPin}
          label={placeStat}
          action={guest ? t('location.title') : undefined}
          onClick={guest ? () => setSetting('location') : undefined}
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-md border border-border bg-card">
        {/*
          Three rows that belong to an account, and therefore ask for one.
        
          Before sign-in they carry no value at all — the credit figure, the
          dealer list and the farm record are the account's, and showing the
          phone's local copy here would read as a debt or a shop list the farmer
          never entered. Tapping one opens the sign-in sheet with the reason
          rather than a dead row, which is the rule every other gated action in
          the app already follows.
        */}
        <Row
          icon={CreditCard}
          label={t('profile.credit')}
          value={
            guest
              ? undefined
              : outstanding > 0
                ? formatMoney(outstanding, locale, t)
                : t('credit.home.none')
          }
          valueTone={outstanding > 0 ? 'text-amber-600 dark:text-amber-100' : 'text-muted-foreground'}
          onClick={guest ? () => prompt('session.why.credit') : undefined}
        />
        <Row
          icon={Store}
          label={t('profile.dealers')}
          onClick={guest ? () => prompt('session.why.dealers') : onOpenDealers}
        />
        <Row
          icon={Pencil}
          label={t('profile.farmDetails')}
          onClick={guest ? () => prompt('session.why.farmDetails') : undefined}
        />
        <ChoiceRow
          icon={Languages}
          label={t('profile.language')}
          value={locale === 'en' ? t('lang.english') : t('lang.urdu')}
          sheetTitle={t('profile.language')}
          hint={t('profile.languageHint')}
          options={[
            { value: 'en', label: t('lang.english') },
            { value: 'ur', label: t('lang.urdu'), lang: 'ur' },
          ]}
          selected={locale}
          onSelect={(next) => setLocale(next as Locale)}
        />
        <ChoiceRow
          icon={SunMoon}
          label={t('profile.appearance')}
          value={theme === 'light' ? t('theme.light') : t('theme.dark')}
          sheetTitle={t('profile.appearance')}
          hint={t('profile.appearanceHint')}
          options={[
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
          selected={theme}
          onSelect={(next) => setTheme(next as Theme)}
        />
        <Row icon={Bell} label={t('profile.notifications')} />
        <Row icon={HelpCircle} label={t('profile.help')} last />
      </div>

      {/*
       * Where the farmer's data is, and whether it has been saved.
       *
       * Generated from the running configuration rather than written by hand, so
       * it cannot claim a service is connected when it is not — and it is the one
       * place the farmer can see the difference between "saved" and "written on
       * the phone, waiting for signal".
       */}
      <DataSection />

      {/* Opened by the strip above; nothing else on this screen reaches them. */}
      <CropsSheet open={setting === 'crops'} onOpenChange={(open) => setSetting(open ? 'crops' : null)} />
      <LocationSheet
        open={setting === 'location'}
        onOpenChange={(open) => setSetting(open ? 'location' : null)}
        onSearch={() => {
          setSetting(null);
          onOpenLocationSearch();
        }}
      />
    </div>
  );
}

/**
 * What is holding the data, and whether it is saved.
 *
 * Two questions a farmer is entitled to an answer to, and which this app can only
 * answer because the answer is measured: the service list comes from the running
 * configuration, and the sync line from the write queue the stores actually use.
 * A hard-coded "Everything is saved" would be the same green tick on a phone with
 * no signal, which is exactly the lie the whole persistence layer exists to avoid.
 */
function DataSection() {
  const { t } = useLocale();
  const { account } = useSession();
  const health = useSyncHealth();
  const services = configurationReport();

  /* Signed in, but with no party id — so there is no row on the server to write
   * to, and the farmer's documents are on this phone and nowhere else.
   *
   * "Everything is saved" would be a claim about the account, and the account
   * cannot receive anything until it has a party. The state is temporary and
   * self-healing (the session provider asks for the party id again on every
   * launch), which is what the copy says instead of reporting a sync that is not
   * happening.
   */
  const deviceOnly = account !== null && account.partyId === null;

  return (
    <>
      <p className="mt-5 text-overline text-muted-foreground uppercase">
        {t('profile.data.title')}
      </p>
      <div className="mt-2 overflow-hidden rounded-md border border-border bg-card">
        <div className={ROW_DIVIDED}>
          <Cloud
            className={`size-5 shrink-0 ${health.failing ? 'text-amber-700' : 'text-brand'}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block text-body">
              {health.pending > 0
                ? t('profile.data.pending', { count: health.pending })
                : health.failing
                  ? t('profile.data.failing')
                  : deviceOnly
                    ? t('profile.data.deviceOnly')
                    : t('profile.data.saved')}
            </span>
            {/* The backend's own words when there are any, and the promise that
                nothing was lost when there are not. */}
            <span className="mt-0.5 block text-label leading-relaxed text-muted-foreground">
              {health.message ??
                (deviceOnly ? t('profile.data.deviceOnlyBody') : t('profile.data.savedBody'))}
            </span>
          </span>
          {health.failing ? (
            <button
              type="button"
              onClick={health.flush}
              className="shrink-0 rounded-full py-1.5 text-label text-brand"
            >
              {t('common.tryAgain')}
            </button>
          ) : null}
        </div>

        {services.map(({ service, mode }, index) => (
          <div
            key={service}
            className={index === services.length - 1 ? ROW : ROW_DIVIDED}
          >
            <span className="flex-1 text-body capitalize">{service}</span>
            <span
              className={`text-label ${mode === 'remote' ? 'text-brand' : 'text-muted-foreground'}`}
            >
              {mode === 'remote' ? t('profile.data.live') : t('profile.data.development')}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  action,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** What tapping this figure does, used as its name when it has no words. */
  action?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <Icon className="mx-auto size-4.5 text-brand" aria-hidden />
      <span className="mt-1 block text-label text-cream-50">{label}</span>
    </>
  );

  /*
   * A figure that can be changed is a button, and it carries the action in its
   * name as well as the value — an empty slot has nothing to announce otherwise,
   * which is exactly the state a farmer who skipped the question at install time
   * is looking at.
   */
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ? `${action}: ${label}` : action}
      className="flex-1"
    >
      {inner}
    </button>
  ) : (
    <div className="flex-1">{inner}</div>
  );
}

/**
 * Choosing the farmer's main crop, or changing it.
 *
 * The same four crops the install flow offers, from the same list, so the two
 * screens cannot disagree about what is on offer. Tapping one is the whole
 * decision: it makes that crop the main one and adds it when the farmer skipped
 * the question at install time — which is why the write is `chooseCrop` rather
 * than an add followed by a set.
 */
function CropsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLocale();
  const insights = useInsights();
  const current = insights.primary;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t('profile.crops')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-body-sm text-muted-foreground">{t('profile.cropsHint')}</p>
          <ul className="flex flex-col gap-2">
            {CROP_CHOICES.map((choice) => {
              const active = current?.nameKey === choice.key;
              return (
                <li key={choice.key}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      insights.chooseCrop({ nameKey: choice.key, stageKey: choice.stage });
                      onOpenChange(false);
                    }}
                    className={[
                      'flex w-full items-center justify-between rounded-md border px-3.5 py-3 text-start',
                      active ? 'border-brand bg-brand-soft' : 'border-border bg-card',
                    ].join(' ')}
                  >
                    <span className="text-body">{t(choice.key)}</span>
                    {active ? <Check className="size-4 shrink-0 text-brand" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Setting or changing where the farmer is, before there is an account.
 *
 * No gate here, deliberately. A location is not said to anyone — nothing is
 * published by writing it down — so a guest's choice is kept on the phone and
 * handed to the account when one is made. Detecting writes it straight away;
 * searching hands over to the same screen the dealer filter uses, which saves on
 * the tap.
 */
function LocationSheet({
  open,
  onOpenChange,
  onSearch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSearch: () => void;
}) {
  const { t } = useLocale();
  const location = useLocation();
  const [locating, setLocating] = useState(false);
  const [failed, setFailed] = useState(false);

  const detect = () => {
    if (!('geolocation' in navigator)) {
      setFailed(true);
      return;
    }
    setLocating(true);
    setFailed(false);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void location
          .save({
            label: '',
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            source: 'gps',
            radiusKm: location.radiusKm,
          })
          .then(() => onOpenChange(false))
          .catch(() => setFailed(true))
          .finally(() => setLocating(false));
      },
      () => {
        setLocating(false);
        setFailed(true);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t('location.title')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-body-sm text-muted-foreground">{t('profile.locationHint')}</p>

          {/* A refused permission and an unavailable location are one sentence:
              the farmer's next move is the same either way — search for it. */}
          {failed ? (
            <p className="text-body-sm text-red-700 dark:text-red-100">
              {t('location.detectFailed')}
            </p>
          ) : null}

          <button
            type="button"
            onClick={detect}
            disabled={locating}
            className="flex h-12 items-center justify-center gap-2 rounded-full bg-primary text-body text-primary-foreground disabled:opacity-60"
          >
            <MapPin className="size-4" aria-hidden />
            {locating ? t('location.saving') : t('location.current')}
          </button>
          <button
            type="button"
            onClick={onSearch}
            className="flex h-12 items-center justify-center rounded-full border border-border bg-card text-body"
          >
            {t('location.searchBarHint')}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A hairline between the three farm figures, and never around them. */
function Divider() {
  return <div aria-hidden className="w-px bg-white/20" />;
}

const ROW = 'flex w-full items-center gap-3 px-3.5 py-3.5 text-start';
const ROW_DIVIDED = `${ROW} border-b border-border`;

function Row({
  icon: Icon,
  label,
  value,
  valueTone = 'text-muted-foreground',
  onClick,
  destructive,
  last,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  valueTone?: string;
  onClick?: () => void;
  destructive?: boolean;
  last?: boolean;
}) {
  const body = (
    <>
      <Icon className={`size-5 shrink-0 ${destructive ? 'text-destructive' : 'text-brand'}`} aria-hidden />
      <span className={`flex-1 text-body ${destructive ? 'text-destructive' : ''}`}>{label}</span>
      {value ? <span className={`shrink-0 text-label ${valueTone}`}>{value}</span> : null}
      {onClick ? (
        <ChevronRight className="size-4 shrink-0 text-ink-300 rtl:rotate-180" aria-hidden />
      ) : null}
    </>
  );

  const className = last ? ROW : ROW_DIVIDED;

  // A row without a destination is not a button. Rendering it as one would offer
  // a tap that does nothing, which is worse than showing it as plain information.
  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

type Option = { value: string; label: string; lang?: string };

/**
 * A row whose value is chosen in a sheet. One component for language and
 * appearance so the two cannot drift apart, and so both get the direction fix
 * from the shared ToggleGroup.
 */
function ChoiceRow({
  icon,
  label,
  value,
  sheetTitle,
  hint,
  options,
  selected,
  onSelect,
  last,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sheetTitle: string;
  hint: string;
  options: readonly Option[];
  selected: string;
  onSelect: (value: string) => void;
  last?: boolean;
}) {
  return (
    <Sheet>
      <SheetTriggerRow icon={icon} label={label} value={value} last={last} />
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{sheetTitle}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-body-sm text-muted-foreground">{hint}</p>
          <ToggleGroup
            type="single"
            variant="brand"
            value={selected}
            onValueChange={(next) => {
              if (next) onSelect(next);
            }}
            className="w-full"
          >
            {options.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} className="h-11 flex-1">
                {option.lang ? <span lang={option.lang}>{option.label}</span> : option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The trigger row, kept separate so the sheet can close around it. */
function SheetTriggerRow({
  icon: Icon,
  label,
  value,
  last,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <SheetTrigger asChild>
      {/* The label and its current value are both in the button, so the row
          announces as "Language, English" rather than as an unlabelled control. */}
      <button type="button" className={last ? ROW : ROW_DIVIDED}>
        <Icon className="size-5 shrink-0 text-brand" aria-hidden />
        <span className="flex-1 text-body">{label}</span>
        <span className="shrink-0 text-label text-muted-foreground">{value}</span>
        <ChevronRight className="size-4 shrink-0 text-ink-300 rtl:rotate-180" aria-hidden />
      </button>
    </SheetTrigger>
  );
}
