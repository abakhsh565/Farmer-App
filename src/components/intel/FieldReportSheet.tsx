import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/SectionLabel';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useLocale } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/catalog';
import { useInsights } from '@/insights/InsightProvider';
import { nearestDistrict } from '@/intel/districts';
import {
  REPORTABLE_CROPS,
  REPORT_BODY_MAX,
  REPORT_TITLE_MAX,
  REPORT_TOPICS,
  REPORT_TOPIC_KEYS,
  validateFieldReport,
  type FieldReportDraft,
  type FieldReportValue,
  type ReportTopic,
} from '@/intel/report';
import { useLocation } from '@/location/LocationProvider';
import { submitFieldReport } from '@/services/intelReports';
import { useSession } from '@/session/SessionProvider';

/**
 * "Something is wrong in my field."
 *
 * The three answers the form insists on are the three the database insists on:
 * what the problem looks like (a topic from the fixed set), one line saying what
 * it is, and a slightly longer line saying where and how much. A crop is offered
 * but may be left as "another crop", because a farmer can spot a problem on a
 * neighbour's field they have no crop record for.
 *
 * What it does *not* ask for is a location. The point comes from the area the
 * farmer has already chosen for the app and is rounded to a two-decimal cell
 * before it is sent, so the report can say "about 4 km from you" without the
 * farm's coordinates ever leaving the device. The privacy line at the top says
 * that in the farmer's own words, because a screen that collects location must
 * say what happens to it rather than leaving the farmer to assume.
 *
 * The identity gate wraps the send, not the form: nobody is asked to sign up
 * before they have written anything, and the words in the box are the words that
 * are posted once they have.
 */

export function FieldReportSheet({
  open,
  onOpenChange,
  onOpenLocation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenLocation: () => void;
}) {
  const { t } = useLocale();
  const insights = useInsights();
  const location = useLocation();
  const { requestIdentity } = useSession();

  const primary = insights.primary;
  const hasArea = location.hasSaved || location.isTemporary;

  /*
   * The farmer's own crops, when the app knows them, because a report is almost
   * always about a crop they planted. Anyone else — including a farmer with no
   * crop record yet — gets the whole catalogue, which is the honest default: the
   * problem still exists even if the app was never told what was in the field.
   */
  const ownCrops = insights.crops
    .map((crop) => REPORTABLE_CROPS.find((option) => option.nameKey === crop.nameKey))
    .filter((option): option is { code: string; nameKey: MessageKey } => Boolean(option));
  const cropOptions = ownCrops.length > 0 ? ownCrops : [...REPORTABLE_CROPS];

  const defaultCrop =
    cropOptions.find((option) => option.nameKey === primary?.nameKey)?.code ?? null;

  const [cropCode, setCropCode] = useState<string | null>(defaultCrop);
  const [topic, setTopic] = useState<ReportTopic | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const reset = () => {
    setTopic(null);
    setTitle('');
    setBody('');
    setProblem(null);
    setDetail(null);
  };

  const close = (next: boolean) => {
    if (next) {
      /*
       * The farmer's own crop is offered as the selected one, decided when the
       * sheet opens rather than when it mounted: crops arrive from the store after
       * the first render, and a default chosen at mount would be "another crop"
       * for a farmer whose cotton was read a moment later.
       */
      if (cropCode === null && defaultCrop !== null) setCropCode(defaultCrop);
    } else {
      reset();
    }
    onOpenChange(next);
  };

  /**
   * The draft and its origin, checked once.
   *
   * The district is attributed here, on the way in, so the value the farmer sees
   * refused and the value that gets sent are the same object — a second check at
   * send time could only disagree with the first.
   */
  const check = () => {
    const district = nearestDistrict(location.activePoint.lat, location.activePoint.lon);
    return validateFieldReport({ cropCode, topic, title, body } satisfies FieldReportDraft, {
      lat: location.activePoint.lat,
      lon: location.activePoint.lon,
      areaLabel: location.placeLabel,
      district: district?.district.code ?? null,
    });
  };

  const send = async (value: FieldReportValue) => {
    setSending(true);
    const result = await submitFieldReport(value);
    setSending(false);

    if (!result.ok) {
      setProblem(result.error);
      setDetail(result.detail);
      return;
    }

    toast.success(t('report.sent'));
    close(false);
  };

  /* Validation that needs no account runs first; then the same send runs after
     sign-in, so nothing the farmer typed is lost to the gate. */
  const submit = () => {
    const checked = check();
    if (!checked.ok) {
      setProblem(checked.problem);
      setDetail(null);
      return;
    }
    requestIdentity(() => void send(checked.value), 'session.why.report');
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="mx-auto max-h-[92dvh] w-full max-w-[430px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('report.sheet.title')}</SheetTitle>
          <SheetDescription>{t('report.privacy')}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 p-4 pt-0">
          {!hasArea ? (
            <div className="rounded-md bg-muted p-3">
              <p className="text-body-sm">{t('report.needsArea')}</p>
              <Button
                variant="outline"
                className="mt-2 h-10 rounded-full"
                onClick={() => {
                  close(false);
                  onOpenLocation();
                }}
              >
                {t('report.setArea')}
              </Button>
            </div>
          ) : (
            <p className="text-label text-muted-foreground">
              {t('report.from', { area: location.placeLabel })}
            </p>
          )}

          <SectionLabel>{t('report.field.crop')}</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {cropOptions.map((option) => (
              <Chip
                key={option.code}
                active={cropCode === option.code}
                label={t(option.nameKey)}
                onClick={() => setCropCode(cropCode === option.code ? null : option.code)}
              />
            ))}
            <Chip
              active={cropCode === null}
              label={t('report.crop.other')}
              onClick={() => setCropCode(null)}
            />
          </div>

          <SectionLabel>{t('report.field.topic')}</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {REPORT_TOPICS.map((option) => (
              <Chip
                key={option}
                active={topic === option}
                label={t(REPORT_TOPIC_KEYS[option])}
                onClick={() => {
                  setTopic(option);
                  setProblem(null);
                }}
              />
            ))}
          </div>

          <label className="sr-only" htmlFor="report-title">
            {t('report.field.title')}
          </label>
          <input
            id="report-title"
            value={title}
            maxLength={REPORT_TITLE_MAX}
            onChange={(event) => {
              setTitle(event.target.value);
              if (problem) setProblem(null);
            }}
            placeholder={t('report.placeholder.title')}
            className="h-11 w-full rounded-md bg-muted px-3.5 text-body placeholder:text-muted-foreground focus-visible:outline-none"
          />

          <label className="sr-only" htmlFor="report-body">
            {t('report.field.body')}
          </label>
          <textarea
            id="report-body"
            rows={4}
            value={body}
            maxLength={REPORT_BODY_MAX}
            onChange={(event) => {
              setBody(event.target.value);
              if (problem) setProblem(null);
            }}
            placeholder={t('report.placeholder.body')}
            className="w-full resize-none rounded-md bg-muted px-3.5 py-3 text-body placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <p className="text-end text-label text-muted-foreground">
            {body.trim().length}/{REPORT_BODY_MAX}
          </p>

          {problem ? (
            <div
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2.5 text-body-sm text-red-700 dark:bg-red-500/20 dark:text-red-100"
            >
              <p className="flex items-center gap-2">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                {t(problem)}
              </p>
              {/* The server's own sentence, kept rather than paraphrased: it is the
                  only part that says *why* a send was refused. */}
              {detail ? <p className="mt-1 text-label opacity-80">{detail}</p> : null}
            </div>
          ) : null}

          <Button
            className="h-11 rounded-full"
            disabled={sending || !hasArea}
            onClick={submit}
          >
            {sending ? t('report.sending') : t('report.submit')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Chip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-3.5 py-2 text-body-sm font-medium leading-none ${
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );
}
