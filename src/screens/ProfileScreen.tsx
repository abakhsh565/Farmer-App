import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CreditCard,
  HelpCircle,
  Languages,
  LogIn,
  LogOut,
  MapPin,
  Pencil,
  Ruler,
  ShieldCheck,
  Sprout,
  Store,
  SunMoon,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSession } from '@/session/SessionProvider';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useLocale } from '@/i18n/LocaleProvider';
import type { Locale } from '@/i18n/catalog';
import { formatDay, formatMoney } from '@/i18n/format';
import { initialsOf } from '@/lib/initials';
import { configurationReport } from '@/services/config';
import { useSyncHealth } from '@/services/persistence';
import { useTheme, type Theme } from '@/theme/ThemeProvider';

/** The same figure the home card shows, since it is the same debt. */
const CREDIT_DUE = 3_330;

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
}: {
  onBack: () => void;
  onOpenDealers: () => void;
}) {
  const { t, locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  const { account, isGuest, signOut, prompt } = useSession();

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

      <div className="mt-2 flex items-center gap-3.5">
        <span className="grid size-15 shrink-0 place-items-center rounded-full bg-brand text-title font-medium text-brand-foreground">
          {initialsOf(t('farmer.name'))}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-heading">{t('farmer.name')}</span>
          <span className="mt-0.5 block truncate text-label text-muted-foreground">
            {t('farmer.phone')}
          </span>
        </span>
      </div>

      <dl className="mt-3.5 flex justify-around rounded-lg bg-surface-inverted p-3.5 text-center">
        <Stat icon={Sprout} label={t('crop.cotton')} />
        <Divider />
        <Stat icon={Ruler} label={t('farmer.acres')} />
        <Divider />
        <Stat icon={MapPin} label={t('farmer.village')} />
      </dl>

      <div className="mt-4 overflow-hidden rounded-md border border-border bg-card">
        <Row
          icon={CreditCard}
          label={t('profile.credit')}
          value={formatMoney(CREDIT_DUE, locale, t)}
          valueTone="text-amber-600 dark:text-amber-100"
        />
        <Row icon={Store} label={t('profile.dealers')} onClick={onOpenDealers} />
        <Row icon={Pencil} label={t('profile.farmDetails')} />
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

      {/* Who you are, kept separate from what you grow. A guest sees only the way
          in; signing out and deleting the account are authenticated-only, which
          is the rule the module is built around. */}
      <p className="mt-5 text-overline text-muted-foreground uppercase">
        {t('profile.account.title')}
      </p>
      <div className="mt-2 overflow-hidden rounded-md border border-border bg-card">
        {isGuest ? (
          <>
            <div className={ROW_DIVIDED}>
              <UserRound className="size-5 shrink-0 text-brand" aria-hidden />
              <span className="flex-1 text-body text-muted-foreground">
                {t('profile.account.guest')}
              </span>
            </div>
            <Row
              icon={LogIn}
              label={t('profile.account.create')}
              onClick={() => prompt('profile.account.createReason')}
              last
            />
          </>
        ) : (
          <>
            <div className={ROW_DIVIDED}>
              <ShieldCheck className="size-5 shrink-0 text-brand" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-body">
                  {t('profile.account.signedIn', { name: account?.name ?? '' })}
                </span>
                <span className="mt-0.5 block text-label text-muted-foreground">
                  {t('profile.account.contact', {
                    contact: account?.phone ?? account?.email ?? '',
                    date: formatDay(new Date(account?.verifiedAt ?? Date.now()), locale),
                  })}
                </span>
              </span>
            </div>
            <DeleteAccount />
            <Row
              icon={LogOut}
              label={t('profile.logout')}
              destructive
              onClick={() => {
                signOut();
                toast.success(t('profile.account.signedOut'));
              }}
              last
            />
          </>
        )}
      </div>
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
  const health = useSyncHealth();
  const services = configurationReport();

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
                  : t('profile.data.saved')}
            </span>
            {/* The backend's own words when there are any, and the promise that
                nothing was lost when there are not. */}
            <span className="mt-0.5 block text-label leading-relaxed text-muted-foreground">
              {health.message ?? t('profile.data.savedBody')}
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

/**
 * Deleting the account, in two steps and with the retention rule stated.
 *
 * It closes the account and removes the farmer's own details; it does not touch
 * credit agreements or dealer records, because those are not the farmer's alone
 * to delete. The copy says that before the button is pressed, not after.
 */
function DeleteAccount() {
  const { t } = useLocale();
  const { signOut } = useSession();

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" className={ROW_DIVIDED}>
          <Trash2 className="size-5 shrink-0 text-destructive" aria-hidden />
          <span className="flex-1 text-start text-body text-destructive">
            {t('profile.account.delete')}
          </span>
          <ChevronRight className="size-4 shrink-0 text-ink-300 rtl:rotate-180" aria-hidden />
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto w-full max-w-[430px]">
        <SheetHeader>
          <SheetTitle>{t('profile.account.delete')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-4 pt-0">
          <p className="text-body-sm leading-relaxed text-muted-foreground">
            {t('profile.account.deleteBody')}
          </p>
          <p className="rounded-md bg-muted px-3.5 py-3 text-body-sm text-muted-foreground">
            {t('profile.account.keep')}
          </p>
          <SheetClose asChild>
            <Button
              variant="destructive"
              className="h-12 rounded-full"
              onClick={() => {
                signOut();
                toast.success(t('profile.account.deleted'));
              }}
            >
              {t('profile.account.deleteConfirm')}
            </Button>
          </SheetClose>
          <SheetClose asChild>
            <Button variant="outline" className="h-11 rounded-full">
              {t('common.cancel')}
            </Button>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex-1">
      <Icon className="mx-auto size-4.5 text-brand" aria-hidden />
      <dd className="mt-1 text-label text-cream-50">{label}</dd>
    </div>
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
