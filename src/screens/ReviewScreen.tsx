import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  Clock3,
  ExternalLink,
  FileSearch,
  Plus,
  Search,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDay } from '@/i18n/format';
import type { Locale, MessageKey } from '@/i18n/catalog';
import {
  type CreateEvidenceInput,
  type EvidenceDetail,
  type ReviewAuthority,
  type ReviewAuthorityRow,
  type ReviewCandidate,
  type ReviewQueueRow,
  type ReviewStatus,
  type ReviewTargetKind,
} from '@/intelligence/review';
import { useReviewWorkspace, type ReviewWorkspace } from '@/intelligence/useReview';
import { useOnline } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';

const STATUS_KEY: Readonly<Record<ReviewStatus, MessageKey>> = {
  draft: 'review.status.draft',
  submitted: 'review.status.submitted',
  under_review: 'review.status.under_review',
  correction_requested: 'review.status.correction_requested',
  approved: 'review.status.approved',
  rejected: 'review.status.rejected',
  published: 'review.status.published',
  expired: 'review.status.expired',
  superseded: 'review.status.superseded',
};

const KIND_KEY: Readonly<Record<ReviewTargetKind, MessageKey>> = {
  knowledge_entry: 'review.kind.knowledge_entry',
  official_advisory: 'review.kind.official_advisory',
  forecast_rule: 'review.kind.forecast_rule',
};

const SOURCE_TYPE_KEY: Readonly<Record<string, MessageKey>> = {
  official_government: 'review.sourceType.official_government',
  official_extension: 'review.sourceType.official_extension',
  regulator: 'review.sourceType.regulator',
  university: 'review.sourceType.university',
  peer_reviewed: 'review.sourceType.peer_reviewed',
  qualified_expert: 'review.sourceType.qualified_expert',
  supplementary_editorial: 'review.sourceType.supplementary_editorial',
  community: 'review.sourceType.community',
  unknown: 'review.sourceType.unknown',
};

const CLASS_KEY: Readonly<Record<string, MessageKey>> = {
  official_government: 'review.class.official_government',
  peer_reviewed_research: 'review.class.peer_reviewed_research',
  qualified_expert: 'review.class.qualified_expert',
  supplementary_editorial: 'review.class.supplementary_editorial',
  unverified_submission: 'review.class.unverified_submission',
};

const CHECK_KEY: Readonly<Record<string, MessageKey>> = {
  pending: 'review.check.pending',
  authentic: 'review.check.authentic',
  not_authentic: 'review.check.not_authentic',
  applicable: 'review.check.applicable',
  not_applicable: 'review.check.not_applicable',
  approved: 'review.check.approved',
  rejected: 'review.check.rejected',
};

const ACTION_KEY: Readonly<Record<string, MessageKey>> = {
  create: 'review.action.create',
  submit: 'review.action.submit',
  start_review: 'review.action.start_review',
  source_check: 'review.action.source_check',
  applicability_check: 'review.action.applicability_check',
  approve: 'review.action.approve',
  reject: 'review.action.reject',
  request_correction: 'review.action.request_correction',
  resubmit: 'review.action.resubmit',
  publish: 'review.action.publish',
  expire: 'review.action.expire',
  supersede: 'review.action.supersede',
};

const AUTHORITY_KEY: Readonly<Record<ReviewAuthority, MessageKey>> = {
  evidence_reviewer: 'review.authority.evidence_reviewer',
  content_manager: 'review.authority.content_manager',
};

type Filter = 'all' | 'submitted' | 'under_review' | 'approved' | 'published' | 'closed' | 'rejected';

const FILTERS: ReadonlyArray<{ id: Filter; key: MessageKey }> = [
  { id: 'all', key: 'review.all' },
  { id: 'submitted', key: 'review.queue' },
  { id: 'under_review', key: 'review.reviewing' },
  { id: 'approved', key: 'review.approved' },
  { id: 'published', key: 'review.published' },
  { id: 'closed', key: 'review.closed' },
  { id: 'rejected', key: 'review.rejected' },
];

const SOURCE_TYPES = [
  'official_government',
  'official_extension',
  'regulator',
  'university',
  'peer_reviewed',
  'qualified_expert',
  'supplementary_editorial',
  'community',
  'unknown',
] as const;

const CLASSIFICATIONS = [
  'official_government',
  'peer_reviewed_research',
  'qualified_expert',
  'supplementary_editorial',
  'unverified_submission',
] as const;

type DraftForm = {
  targetKind: ReviewTargetKind;
  targetRef: string;
  sourceOrganization: string;
  sourceType: string;
  classification: string;
  documentTitle: string;
  sourceUrl: string;
  sourceCode: string;
  documentRef: string;
  publishedOn: string;
  language: string;
  districts: string;
  stages: string;
  validUntil: string;
  confidence: string;
};

const EMPTY_FORM: DraftForm = {
  targetKind: 'knowledge_entry',
  targetRef: '',
  sourceOrganization: '',
  sourceType: 'official_government',
  classification: 'official_government',
  documentTitle: '',
  sourceUrl: '',
  sourceCode: '',
  documentRef: '',
  publishedOn: '',
  language: 'en',
  districts: '',
  stages: '',
  validUntil: '',
  confidence: '',
};

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
}

function dateLabel(value: string | null, locale: Locale): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDay(date, locale) : '—';
}

function statusClass(status: ReviewStatus): string {
  if (status === 'published' || status === 'approved') return 'bg-brand-soft text-brand';
  if (status === 'rejected' || status === 'expired' || status === 'superseded') {
    return 'bg-destructive/10 text-destructive';
  }
  if (status === 'under_review' || status === 'correction_requested') {
    return 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100';
  }
  return 'bg-muted text-muted-foreground';
}

function targetStateLabel(detail: EvidenceDetail): string {
  const value =
    detail.target.verification_status ??
    detail.target.evidence_tier ??
    (detail.target.is_active === true ? 'active' : undefined) ??
    detail.target.state;
  return typeof value === 'string' ? value : '—';
}

/**
 * The reviewer workspace.
 *
 * This is not reachable by role in the HTML: Profile asks the server for the
 * signed-in person's named authority, and this screen repeats that gate. A hidden
 * button is not an authorization boundary, which is why every button below also
 * maps to a security-definer RPC that re-checks the same authority and scope.
 */
function AuthorityDialog({
  open,
  onClose,
  review,
}: {
  open: boolean;
  onClose: () => void;
  review: ReviewWorkspace;
}) {
  const { t } = useLocale();
  const [rows, setRows] = useState<ReviewAuthorityRow[]>([]);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [authority, setAuthority] = useState<ReviewAuthority>('evidence_reviewer');
  const [crops, setCrops] = useState('');
  const [districts, setDistricts] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async (needle: string) => {
    const [list, people] = await Promise.all([
      review.authorities(),
      review.candidates(needle),
    ]);
    if (list) setRows(list);
    if (people) setCandidates(people);
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelected('');
    void reload('');
    // The roster is not a live feed: it is read when the dialog opens.
  }, [open]);

  const grant = async () => {
    if (!selected) {
      setError(t('review.authoritySelectPerson'));
      return;
    }
    if (selected === review.context?.partyId) {
      setError(t('review.authoritySelf'));
      return;
    }
    if (note.trim() === '') {
      setError(t('review.authorityReasonRequired'));
      return;
    }
    setBusy(true);
    const ok = await review.grantAuthority({
      partyId: selected,
      authority,
      scopeCrops: splitList(crops),
      scopeDistricts: splitList(districts),
      note: note.trim(),
    });
    setBusy(false);
    if (!ok) {
      setError(t('review.authorityFailed'));
      return;
    }
    setNote('');
    toast.success(t('review.authorityGranted'));
    await reload(search);
  };

  const revoke = async (row: ReviewAuthorityRow) => {
    if (note.trim() === '') {
      setError(t('review.authorityReasonRequired'));
      return;
    }
    setBusy(true);
    const ok = await review.revokeAuthority(row.partyId, row.authority, note.trim());
    setBusy(false);
    if (!ok) {
      setError(t('review.authorityFailed'));
      return;
    }
    setNote('');
    toast.success(t('review.authorityRevokedToast'));
    await reload(search);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('review.authorities')}</DialogTitle>
          <DialogDescription>{t('review.authoritiesIntro')}</DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void reload(search);
          }}
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('review.authoritySearch')}
            className="h-11"
          />
          <Button type="submit" className="h-11 shrink-0 rounded-full">
            {t('review.authoritySearch')}
          </Button>
        </form>

        {rows.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t('review.authorityEmpty')}</p>
        ) : (
          <ul className="overflow-hidden rounded-md border border-border">
            {rows.map((row) => (
              <li
                key={`${row.partyId}:${row.authority}`}
                className="border-b border-border p-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium">{row.displayName}</p>
                    <p className="mt-0.5 text-label text-muted-foreground">
                      {t(AUTHORITY_KEY[row.authority])} ·{' '}
                      {row.isActive ? t('review.authorityActive') : t('review.authorityRevoked')}
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {row.scopeCrops.length === 0 && row.scopeDistricts.length === 0
                        ? t('review.authorityAll')
                        : [row.scopeCrops.join(', '), row.scopeDistricts.join(', ')]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                    {row.grantedByName ? (
                      <p className="mt-1 text-caption text-muted-foreground">
                        {t('review.authorityGrantedBy', { name: row.grantedByName })}
                      </p>
                    ) : null}
                  </div>
                  {row.isActive ? (
                    <Button
                      type="button"
                      className="h-9 shrink-0 rounded-full"
                      disabled={busy}
                      onClick={() => void revoke(row)}
                    >
                      {t('review.authorityRevoke')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 grid gap-2 border-t border-border pt-3">
          <h3 className="text-subheading">{t('review.authorityGrant')}</h3>
          <FormField label={t('review.authoritySelectPerson')}>
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
            >
              <option value="">—</option>
              {candidates.map((person) => (
                <option key={person.partyId} value={person.partyId}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={t('review.authority')}>
            <select
              value={authority}
              onChange={(event) => setAuthority(event.target.value as ReviewAuthority)}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
            >
              <option value="evidence_reviewer">{t('review.authority.evidence_reviewer')}</option>
              <option value="content_manager">{t('review.authority.content_manager')}</option>
            </select>
          </FormField>
          <FormField label={t('review.authorityCrops')}>
            <Input value={crops} onChange={(event) => setCrops(event.target.value)} className="h-11" />
          </FormField>
          <FormField label={t('review.authorityDistricts')}>
            <Input
              value={districts}
              onChange={(event) => setDistricts(event.target.value)}
              className="h-11"
            />
          </FormField>
          <FormField label={t('review.authorityNote')}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          {error ? (
            <p role="alert" className="text-body-sm text-red-700 dark:text-red-100">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              className="h-11 rounded-full"
              disabled={busy}
              onClick={() => void grant()}
            >
              {t('review.authorityGrant')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewScreen({ onBack }: { onBack: () => void }) {
  const { t, locale } = useLocale();
  const { account, prompt } = useSession();
  const online = useOnline();
  const review = useReviewWorkspace({
    accountId: account?.id ?? null,
    enabled: Boolean(account),
    online,
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [authorityOpen, setAuthorityOpen] = useState(false);
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState('');
  const [alertLevel, setAlertLevel] = useState('watch');
  const [pendingConfirm, setPendingConfirm] = useState<{ label: string; run: () => Promise<boolean> } | null>(null);
  const [trace, setTrace] = useState<Record<string, unknown> | null>(null);
  const [correction, setCorrection] = useState({
    documentTitle: '',
    sourceUrl: '',
    documentRef: '',
    classification: 'qualified_expert',
    validUntil: '',
    note: '',
  });
  const [correctionLoadedFor, setCorrectionLoadedFor] = useState<string | null>(null);

  const selectedTargets = useMemo(
    () => review.targets.filter((target) => target.targetKind === form.targetKind),
    [review.targets, form.targetKind],
  );
  const selectedTarget = useMemo(
    () => selectedTargets.find((target) => target.targetRef === form.targetRef) ?? null,
    [selectedTargets, form.targetRef],
  );

  useEffect(() => {
    if (selectedTargets.length === 0) {
      if (form.targetRef !== '') setForm((current) => ({ ...current, targetRef: '' }));
      return;
    }
    if (!selectedTargets.some((target) => target.targetRef === form.targetRef)) {
      const first = selectedTargets[0];
      if (!first) return;
      setForm((current) => ({
        ...current,
        targetRef: first.targetRef,
        sourceType: first.targetKind === 'official_advisory' ? 'official_government' : current.sourceType,
        classification:
          first.targetKind === 'official_advisory' ? 'official_government' : current.classification,
      }));
    }
  }, [selectedTargets, form.targetRef]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void review.readDetail(selectedId).then((loaded) => {
      if (cancelled) return;
      setDetail(loaded);
      setDetailLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, review.readDetail]);

  useEffect(() => {
    if (!detail || detail.evidence.status !== 'correction_requested') return;
    if (correctionLoadedFor === detail.evidence.id) return;
    setCorrection({
      documentTitle: detail.evidence.documentTitle,
      sourceUrl: detail.evidence.sourceUrl ?? '',
      documentRef: detail.evidence.documentRef ?? '',
      classification: detail.evidence.classification,
      validUntil: detail.evidence.validUntil ? detail.evidence.validUntil.slice(0, 10) : '',
      note: '',
    });
    setCorrectionLoadedFor(detail.evidence.id);
  }, [detail, correctionLoadedFor]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return review.queue.filter((row) => {
      if (filter === 'closed') {
        if (row.status !== 'expired' && row.status !== 'superseded') return false;
      } else if (filter !== 'all' && row.status !== filter) {
        return false;
      }
      if (needle === '') return true;
      return [row.targetLabel, row.documentTitle, row.sourceOrganization, row.targetRef]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [review.queue, filter, search]);

  const refreshDetail = async () => {
    if (!selectedId) return;
    const loaded = await review.readDetail(selectedId);
    setDetail(loaded);
  };

  const runDetailAction = async (run: () => Promise<boolean>) => {
    const ok = await run();
    if (!ok) {
      toast.error(t('review.actionFailed'));
      return false;
    }
    toast.success(t('review.actionDone'));
    setNote('');
    await refreshDetail();
    return true;
  };

  const submitForm = async (submit: boolean) => {
    if (!selectedTarget) {
      setFormError(t('review.target'));
      return;
    }
    if (!form.sourceOrganization.trim() || !form.documentTitle.trim()) {
      setFormError(t('review.actionFailed'));
      return;
    }
    if (submit && !form.validUntil) {
      setFormError(t('review.validUntil'));
      return;
    }
    const confidence = form.confidence.trim() === '' ? null : Number(form.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      setFormError(t('review.confidence'));
      return;
    }
    const input: CreateEvidenceInput = {
      targetKind: form.targetKind,
      targetRef: form.targetRef,
      sourceOrganization: form.sourceOrganization.trim(),
      sourceType: form.sourceType,
      classification: form.classification,
      documentTitle: form.documentTitle.trim(),
      topic: selectedTarget.topic,
      sourceUrl: form.sourceUrl.trim() || null,
      sourceCode: form.sourceCode.trim() || null,
      documentRef: form.documentRef.trim() || null,
      publishedOn: form.publishedOn || null,
      accessedAt: new Date().toISOString(),
      language: form.language,
      cropCode: selectedTarget.cropCode,
      districts: splitList(form.districts),
      stages: splitList(form.stages),
      confidence,
      validFrom: new Date().toISOString(),
      validUntil: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).toISOString() : null,
      submit,
    };
    const ok = await review.create(input);
    if (!ok) {
      setFormError(t('review.actionFailed'));
      return;
    }
    setForm(EMPTY_FORM);
    setFormError(null);
    setAddOpen(false);
    toast.success(t('review.created'));
    review.refresh();
  };

  const openDetail = (row: ReviewQueueRow) => {
    setSelectedId(row.id);
    setDetail(null);
    setNote('');
    setTrace(null);
  };

  return (
    <div className="flex flex-col px-4 pt-4 pb-8">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="-ms-2 grid size-9 shrink-0 place-items-center rounded-full"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 text-heading">{t('review.title')}</h1>
        {review.context?.canGrant ? (
          <button
            type="button"
            aria-label={t('review.authorities')}
            onClick={() => setAuthorityOpen(true)}
            className="grid size-9 shrink-0 place-items-center rounded-full border border-border"
          >
            <Users className="size-5" aria-hidden />
          </button>
        ) : null}

        {review.context?.canManage ? (
          <Button className="h-10 rounded-full" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            {t('review.add')}
          </Button>
        ) : null}
      </div>

      <p className="mt-3 max-w-[52ch] text-body-sm leading-relaxed text-muted-foreground">
        {t('review.intro')}
      </p>

      {!account ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('review.signIn')}
          body={t('review.signInBody')}
          action={
            <Button className="h-11 rounded-full" onClick={() => prompt('session.why.alerts')}>
              {t('profile.account.signIn')}
            </Button>
          }
        />
      ) : null}

      {account && (review.status === 'loading' || review.status === 'idle') ? (
        <LoadingState label={t('review.loading')} />
      ) : null}
      {account && review.status === 'error' ? (
        <ErrorState
          title={t('review.error')}
          body={t('review.error')}
          onRetry={review.refresh}
          retryLabel={t('common.tryAgain')}
        />
      ) : null}
      {account && review.status === 'offline' ? (
        <EmptyState
          icon={Clock3}
          title={t('review.offline')}
          body={t('review.offline')}
        />
      ) : null}
      {account && review.status === 'ready' && review.context && !review.context.canReview && !review.context.canManage ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('review.noAccess')}
          body={t('review.noAccessBody')}
        />
      ) : null}

      {account && review.status === 'ready' && review.context && (review.context.canReview || review.context.canManage) ? (
        <>
          <section className="mt-5" aria-labelledby="review-overview">
            <h2 id="review-overview" className="text-subheading">{t('review.overview')}</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {([
                ['review.count.submitted', review.context.counts.submitted],
                ['review.count.under_review', review.context.counts.underReview],
                ['review.count.correction_requested', review.context.counts.correctionRequested],
                ['review.count.approved', review.context.counts.approved],
                ['review.count.published', review.context.counts.published],
                ['review.count.closed', review.context.counts.closed],
              ] as const).map(([key, count]) => (
                <div key={key} className="rounded-md border border-border bg-card px-3 py-2.5">
                  <p className="text-caption text-muted-foreground">{t(key)}</p>
                  <p className="mt-0.5 text-title">{count}</p>
                </div>
              ))}
            </div>
          </section>

          <label className="mt-4 flex h-11 items-center gap-2 rounded-md border border-border bg-card px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">{t('review.search')}</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('review.search')}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t('review.title')}>
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
                className={`min-h-9 rounded-full border px-3 text-body-sm ${
                  filter === entry.id
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-border bg-background text-muted-foreground'
                }`}
              >
                {t(entry.key)}
              </button>
            ))}
          </div>

          {review.actionFailed ? (
            <p role="alert" className="mt-3 text-body-sm text-red-700 dark:text-red-100">
              {t('review.actionFailed')}
            </p>
          ) : null}

          {visible.length === 0 ? (
            <EmptyState
              icon={FileSearch}
              title={t('review.emptyTitle')}
              body={t('review.emptyBody')}
            />
          ) : (
            <ul className="mt-3 overflow-hidden rounded-md border border-border bg-card">
              {visible.map((row) => (
                <li key={row.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openDetail(row)}
                    className="w-full px-3.5 py-3.5 text-start"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-body font-medium">
                        {row.documentTitle || row.targetLabel}
                      </span>
                      <Badge className={statusClass(row.status)}>{t(STATUS_KEY[row.status])}</Badge>
                    </div>
                    <p className="mt-1 truncate text-label text-muted-foreground">
                      {row.sourceOrganization} · {t(KIND_KEY[row.targetKind])}
                    </p>
                    <p className="mt-1 truncate text-caption text-muted-foreground">
                      {row.targetLabel} · {t('review.version', { version: row.version })}
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {t('review.validUntil')}: {dateLabel(row.validUntil, locale)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <AuthorityDialog
        open={authorityOpen}
        onClose={() => setAuthorityOpen(false)}
        review={review}
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('review.addTitle')}</DialogTitle>
            <DialogDescription>{t('review.classificationHint')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <FormField label={t('review.targetKind')}>
              <select
                value={form.targetKind}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    targetKind: event.target.value as ReviewTargetKind,
                    targetRef: '',
                  }))
                }
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
              >
                {(Object.keys(KIND_KEY) as ReviewTargetKind[]).map((kind) => (
                  <option key={kind} value={kind}>{t(KIND_KEY[kind])}</option>
                ))}
              </select>
            </FormField>
            <FormField label={t('review.target')}>
              <select
                value={form.targetRef}
                onChange={(event) => setForm((current) => ({ ...current, targetRef: event.target.value }))}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
              >
                {selectedTargets.length === 0 ? <option value="">—</option> : null}
                {selectedTargets.map((target) => (
                  <option key={target.targetRef} value={target.targetRef}>
                    {target.label} · {target.currentState}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={t('review.sourceOrganization')}>
              <Input
                value={form.sourceOrganization}
                onChange={(event) => setForm((current) => ({ ...current, sourceOrganization: event.target.value }))}
                className="h-11"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-2">
              <FormField label={t('review.sourceType')}>
                <select
                  value={form.sourceType}
                  onChange={(event) => setForm((current) => ({ ...current, sourceType: event.target.value }))}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
                >
                  {SOURCE_TYPES.map((entry) => (
                    <option key={entry} value={entry}>{t(SOURCE_TYPE_KEY[entry] ?? 'review.sourceType.unknown')}</option>
                  ))}
                </select>
              </FormField>
              <FormField label={t('review.classification')}>
                <select
                  value={form.classification}
                  onChange={(event) => setForm((current) => ({ ...current, classification: event.target.value }))}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-body"
                >
                  {CLASSIFICATIONS.map((entry) => (
                    <option key={entry} value={entry}>{t(CLASS_KEY[entry] ?? 'review.class.unverified_submission')}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField label={t('review.documentTitle')}>
              <Input
                value={form.documentTitle}
                onChange={(event) => setForm((current) => ({ ...current, documentTitle: event.target.value }))}
                className="h-11"
              />
            </FormField>
            <FormField label={t('review.sourceUrl')}>
              <Input
                type="url"
                value={form.sourceUrl}
                onChange={(event) => setForm((current) => ({ ...current, sourceUrl: event.target.value }))}
                className="h-11"
                placeholder="https://"
              />
            </FormField>
            <FormField label={t('review.documentRef')}>
              <Input
                value={form.documentRef}
                onChange={(event) => setForm((current) => ({ ...current, documentRef: event.target.value }))}
                className="h-11"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-2">
              <FormField label={t('review.publishedOn')}>
                <Input
                  type="date"
                  value={form.publishedOn}
                  onChange={(event) => setForm((current) => ({ ...current, publishedOn: event.target.value }))}
                  className="h-11"
                />
              </FormField>
              <FormField label={t('review.validUntil')}>
                <Input
                  type="date"
                  value={form.validUntil}
                  onChange={(event) => setForm((current) => ({ ...current, validUntil: event.target.value }))}
                  className="h-11"
                />
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FormField label={t('review.districts')}>
                <Input
                  value={form.districts}
                  onChange={(event) => setForm((current) => ({ ...current, districts: event.target.value }))}
                  className="h-11"
                />
              </FormField>
              <FormField label={t('review.stages')}>
                <Input
                  value={form.stages}
                  onChange={(event) => setForm((current) => ({ ...current, stages: event.target.value }))}
                  className="h-11"
                />
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FormField label={t('review.sourceCode')}>
                <Input
                  value={form.sourceCode}
                  onChange={(event) => setForm((current) => ({ ...current, sourceCode: event.target.value }))}
                  className="h-11"
                />
              </FormField>
              <FormField label={t('review.confidence')}>
                <Input
                  inputMode="decimal"
                  value={form.confidence}
                  onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
                  className="h-11"
                />
              </FormField>
            </div>
            {formError ? <p role="alert" className="text-body-sm text-red-700 dark:text-red-100">{formError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setAddOpen(false)}>
              {t('review.cancel')}
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={review.actionPending || !selectedTarget}
              onClick={() => void submitForm(false)}
            >
              {t('review.saveDraft')}
            </Button>
            <Button
              className="h-11"
              disabled={review.actionPending || !selectedTarget}
              onClick={() => void submitForm(true)}
            >
              {t('review.submitEvidence')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('review.detail')}</DialogTitle>
            {detail ? (
              <DialogDescription>{detail.evidence.documentTitle}</DialogDescription>
            ) : null}
          </DialogHeader>

          {detailLoading ? <LoadingState label={t('review.loading')} /> : null}
          {!detailLoading && !detail ? (
            <p className="text-body-sm text-muted-foreground">{t('review.error')}</p>
          ) : null}
          {detail ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={statusClass(detail.evidence.status)}>
                  {t(STATUS_KEY[detail.evidence.status])}
                </Badge>
                <Badge variant="outline">{t(KIND_KEY[detail.evidence.targetKind])}</Badge>
                <span className="text-caption text-muted-foreground">
                  {t('review.version', { version: detail.evidence.version })}
                </span>
              </div>

              <section className="rounded-md border border-border bg-card p-3.5">
                <h3 className="text-subheading">{t('review.source')}</h3>
                <p className="mt-1 text-body">{detail.evidence.sourceOrganization}</p>
                <p className="text-label text-muted-foreground">
                  {t(SOURCE_TYPE_KEY[detail.evidence.sourceType] ?? 'review.sourceType.unknown')} ·{' '}
                  {t(CLASS_KEY[detail.evidence.classification] ?? 'review.class.unverified_submission')}
                </p>
                <p className="mt-2 text-body-sm">{detail.evidence.documentTitle}</p>
                {detail.evidence.documentRef ? (
                  <p className="mt-1 text-caption text-muted-foreground">{detail.evidence.documentRef}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-label">
                  {detail.evidence.sourceUrl ? (
                    <a
                      href={detail.evidence.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-8 items-center gap-1 text-brand underline underline-offset-2"
                    >
                      {t('review.openSource')}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : null}
                  <span className="text-muted-foreground">
                    {t('review.accessedAt')}: {dateLabel(detail.evidence.accessedAt, locale)}
                  </span>
                </div>
                <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
                  {t('review.sourceInspection')}
                </p>
              </section>

              <section className="rounded-md border border-border bg-card p-3.5">
                <h3 className="text-subheading">{t('review.applicability')}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-label">
                  <dt className="text-muted-foreground">{t('review.crop')}</dt>
                  <dd>{detail.evidence.cropCode ?? '—'}</dd>
                  <dt className="text-muted-foreground">{t('review.districts')}</dt>
                  <dd>{detail.evidence.districts.join(', ') || '—'}</dd>
                  <dt className="text-muted-foreground">{t('review.stages')}</dt>
                  <dd>{detail.evidence.stages.join(', ') || '—'}</dd>
                  <dt className="text-muted-foreground">{t('review.validity')}</dt>
                  <dd>{dateLabel(detail.evidence.validUntil, locale)}</dd>
                  <dt className="text-muted-foreground">{t('review.evidenceState')}</dt>
                  <dd>{t(STATUS_KEY[detail.evidence.status])}</dd>
                  <dt className="text-muted-foreground">{t('review.targetState')}</dt>
                  <dd>{targetStateLabel(detail)}</dd>
                </dl>
              </section>

              <section className="rounded-md border border-border bg-card p-3.5">
                <h3 className="text-subheading">{t('review.checks')}</h3>
                <ul className="mt-2 flex flex-col gap-2 text-body-sm">
                  <li className="flex items-center justify-between gap-2">
                    <span>{t('review.sourceCheck')}</span>
                    <Badge variant="outline">
                      {t(CHECK_KEY[detail.evidence.sourceCheckStatus] ?? 'review.check.pending')}
                    </Badge>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span>{t('review.applicabilityCheck')}</span>
                    <Badge variant="outline">
                      {t(CHECK_KEY[detail.evidence.applicabilityStatus] ?? 'review.check.pending')}
                    </Badge>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span>{t('review.agronomicCheck')}</span>
                    <Badge variant="outline">
                      {t(CHECK_KEY[detail.evidence.agronomicStatus] ?? 'review.check.pending')}
                    </Badge>
                  </li>
                </ul>
                {detail.evidence.reviewNote ? (
                  <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
                    {detail.evidence.reviewNote}
                  </p>
                ) : null}
              </section>

              {detail.access.canStartReview ||
              detail.access.canCheck ||
              detail.access.canApprove ||
              detail.access.canPublish ||
              detail.access.canExpire ||
              detail.evidence.status === 'draft' ||
              detail.evidence.status === 'correction_requested' ? (
                <section className="rounded-md border border-brand/30 bg-brand-soft/40 p-3.5">
                  <h3 className="text-subheading">{t('review.checks')}</h3>
                  <label className="mt-2 block text-label">
                    {t('review.note')}
                    <Textarea
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      className="mt-1 min-h-20 bg-background"
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {detail.access.canStartReview ? (
                      <Button
                        className="h-10 rounded-full"
                        disabled={review.actionPending}
                        onClick={() => void runDetailAction(() => review.start(detail.evidence.id))}
                      >
                        {t('review.startReview')}
                      </Button>
                    ) : null}
                    {detail.access.canCheck ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            void runDetailAction(() =>
                              review.sourceCheck(detail.evidence.id, 'authentic', note),
                            )
                          }
                        >
                          <CheckCircle2 className="size-4" aria-hidden />
                          {t('review.authentic')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            void runDetailAction(() =>
                              review.sourceCheck(detail.evidence.id, 'not_authentic', note),
                            )
                          }
                        >
                          <XCircle className="size-4" aria-hidden />
                          {t('review.notAuthentic')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            void runDetailAction(() =>
                              review.applicabilityCheck(detail.evidence.id, 'applicable', note),
                            )
                          }
                        >
                          {t('review.applicable')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            void runDetailAction(() =>
                              review.applicabilityCheck(detail.evidence.id, 'not_applicable', note),
                            )
                          }
                        >
                          {t('review.notApplicable')}
                        </Button>
                      </>
                    ) : null}
                    {detail.access.canApprove ? (
                      <>
                        <Button
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            setPendingConfirm({
                              label: t('review.approve'),
                              run: () => review.approve(detail.evidence.id, note),
                            })
                          }
                        >
                          {t('review.approve')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            void runDetailAction(() =>
                              review.requestCorrection(detail.evidence.id, note),
                            )
                          }
                        >
                          {t('review.submitCorrection')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={review.actionPending || !note.trim()}
                          onClick={() =>
                            setPendingConfirm({
                              label: t('review.reject'),
                              run: () => review.reject(detail.evidence.id, note),
                            })
                          }
                        >
                          {t('review.reject')}
                        </Button>
                      </>
                    ) : null}
                    {detail.access.canPublish ? (
                      <>
                        {detail.evidence.targetKind === 'official_advisory' ? (
                          <label className="flex items-center gap-2 text-label">
                            {t('review.alertLevel')}
                            <select
                              value={alertLevel}
                              onChange={(event) => setAlertLevel(event.target.value)}
                              className="h-9 rounded-md border border-input bg-background px-2"
                            >
                              <option value="info">{t('alerts.level.info')}</option>
                              <option value="watch">{t('alerts.level.watch')}</option>
                              <option value="urgent">{t('alerts.level.urgent')}</option>
                            </select>
                          </label>
                        ) : null}
                        <Button
                          size="sm"
                          disabled={review.actionPending}
                          onClick={() =>
                            setPendingConfirm({
                              label: t('review.publish'),
                              run: () =>
                                review.publish(
                                  detail.evidence.id,
                                  detail.evidence.targetKind === 'official_advisory' ? alertLevel : null,
                                ),
                            })
                          }
                        >
                          {t('review.publish')}
                        </Button>
                      </>
                    ) : null}
                    {detail.access.canExpire ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={review.actionPending || !note.trim()}
                        onClick={() =>
                          setPendingConfirm({
                            label: t('review.expire'),
                            run: () => review.expire(detail.evidence.id, note),
                          })
                        }
                      >
                        {t('review.expire')}
                      </Button>
                    ) : null}
                    {detail.evidence.status === 'draft' && detail.access.canManage ? (
                      <Button
                        size="sm"
                        disabled={review.actionPending}
                        onClick={() => void runDetailAction(() => review.submit(detail.evidence.id))}
                      >
                        {t('review.submit')}
                      </Button>
                    ) : null}
                  </div>
                  {detail.evidence.status === 'correction_requested' && detail.access.canManage ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <h4 className="text-body-sm font-medium">{t('review.correctionTitle')}</h4>
                      <div className="mt-2 grid gap-2">
                        <FormField label={t('review.documentTitle')}>
                          <Input
                            className="h-10 bg-background"
                            value={correction.documentTitle}
                            onChange={(event) =>
                              setCorrection((current) => ({ ...current, documentTitle: event.target.value }))
                            }
                          />
                        </FormField>
                        <FormField label={t('review.sourceUrl')}>
                          <Input
                            className="h-10 bg-background"
                            value={correction.sourceUrl}
                            onChange={(event) =>
                              setCorrection((current) => ({ ...current, sourceUrl: event.target.value }))
                            }
                          />
                        </FormField>
                        <div className="grid grid-cols-2 gap-2">
                          <FormField label={t('review.classification')}>
                            <select
                              value={correction.classification}
                              onChange={(event) =>
                                setCorrection((current) => ({ ...current, classification: event.target.value }))
                              }
                              className="h-10 w-full rounded-md border border-input bg-background px-2 text-body-sm"
                            >
                              {CLASSIFICATIONS.map((entry) => (
                                <option key={entry} value={entry}>
                                  {t(CLASS_KEY[entry] ?? 'review.class.unverified_submission')}
                                </option>
                              ))}
                            </select>
                          </FormField>
                          <FormField label={t('review.validUntil')}>
                            <Input
                              type="date"
                              className="h-10 bg-background"
                              value={correction.validUntil}
                              onChange={(event) =>
                                setCorrection((current) => ({ ...current, validUntil: event.target.value }))
                              }
                            />
                          </FormField>
                        </div>
                        <FormField label={t('review.note')}>
                          <Textarea
                            className="min-h-16 bg-background"
                            value={correction.note}
                            onChange={(event) =>
                              setCorrection((current) => ({ ...current, note: event.target.value }))
                            }
                          />
                        </FormField>
                        <Button
                          size="sm"
                          disabled={
                            review.actionPending ||
                            !correction.note.trim() ||
                            !correction.documentTitle.trim() ||
                            !correction.validUntil
                          }
                          onClick={() =>
                            void runDetailAction(() =>
                              review.updateAndResubmit(detail.evidence.id, {
                                documentTitle: correction.documentTitle.trim(),
                                sourceUrl: correction.sourceUrl.trim() || null,
                                documentRef: correction.documentRef.trim() || null,
                                classification: correction.classification,
                                validUntil: new Date(`${correction.validUntil}T23:59:59`).toISOString(),
                                note: correction.note.trim(),
                              }),
                            )
                          }
                        >
                          {t('review.correctAndResubmit')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {review.actionFailed ? (
                    <p role="alert" className="mt-2 text-body-sm text-red-700 dark:text-red-100">
                      {t('review.actionFailed')}
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section className="rounded-md border border-border bg-card p-3.5">
                <h3 className="text-subheading">{t('review.reviewHistory')}</h3>
                {detail.reviewHistory.length === 0 ? (
                  <p className="mt-1 text-body-sm text-muted-foreground">{t('review.noHistory')}</p>
                ) : (
                  <ol className="mt-2 flex flex-col gap-2">
                    {detail.reviewHistory.map((entry) => (
                      <li key={entry.id} className="border-s-2 border-border ps-3">
                        <p className="text-body-sm">
                          {t(ACTION_KEY[entry.action] ?? 'review.action.create')}
                          {entry.note ? ` — ${entry.note}` : ''}
                        </p>
                        <p className="text-caption text-muted-foreground">
                          {entry.actorName ?? entry.actorRole} · {dateLabel(entry.createdAt, locale)}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="rounded-md border border-border bg-card p-3.5">
                <h3 className="text-subheading">{t('review.usage')}</h3>
                <p className="mt-1 text-body-sm text-muted-foreground">
                  {detail.usage.liveDecisions === 0
                    ? t('review.noUsage')
                    : `${detail.usage.liveDecisions}`}
                </p>
                {detail.usage.latest[0] ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      const latest = detail.usage.latest[0];
                      if (!latest) return;
                      void review.decisionTrace(latest.id).then((loaded) => {
                        setTrace(loaded);
                        if (!loaded) toast.error(t('review.traceEmpty'));
                      });
                    }}
                  >
                    {t('review.viewTrace')}
                  </Button>
                ) : null}
              </section>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={trace !== null} onOpenChange={(open) => { if (!open) setTrace(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('review.traceTitle')}</DialogTitle>
            <DialogDescription>{t('review.intro')}</DialogDescription>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-caption leading-relaxed">
            {trace ? JSON.stringify(trace, null, 2) : t('review.traceEmpty')}
          </pre>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setTrace(null)}>
              {t('review.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingConfirm !== null} onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('review.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('review.confirmBody')}</DialogDescription>
          </DialogHeader>
          <p className="text-body">{pendingConfirm?.label}</p>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setPendingConfirm(null)}>
              {t('review.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={review.actionPending}
              onClick={() => {
                const action = pendingConfirm;
                setPendingConfirm(null);
                if (action) {
                  void runDetailAction(action.run).then((ok) => {
                    if (ok && detail && (action.label === t('review.publish') || action.label === t('review.expire'))) {
                      review.refresh();
                    }
                  });
                }
              }}
            >
              {t('review.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-label">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
