/**
 * Reviewer workspace data access.
 *
 * One RPC per act. The server derives the reviewer and submitter from the JWT;
 * this hook has no parameter for either. A failed action never changes the list
 * optimistically: the whole point of the review ledger is that what is on screen
 * came back from the database.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceConfig } from '@/services/config';
import { getSupabaseClient } from '@/services/supabaseClient';
import {
  parseAuthorities,
  parseCandidates,
  parseEvidenceDetail,
  parseQueue,
  parseReviewContext,
  parseTargets,
  type CreateEvidenceInput,
  type EvidenceDetail,
  type GrantAuthorityInput,
  type ReviewAuthority,
  type ReviewAuthorityRow,
  type ReviewCandidate,
  type ReviewContext,
  type ReviewQueueRow,
  type ReviewTarget,
} from './review';

export type ReviewLoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

type ReviewApi = {
  context: () => Promise<ReviewContext | null>;
  queue: () => Promise<ReviewQueueRow[] | null>;
  targets: () => Promise<ReviewTarget[] | null>;
  detail: (id: string) => Promise<EvidenceDetail | null>;
  create: (input: CreateEvidenceInput) => Promise<boolean>;
  submit: (id: string) => Promise<boolean>;
  start: (id: string) => Promise<boolean>;
  sourceCheck: (id: string, status: 'authentic' | 'not_authentic', note: string) => Promise<boolean>;
  applicabilityCheck: (
    id: string,
    status: 'applicable' | 'not_applicable',
    note: string,
  ) => Promise<boolean>;
  approve: (id: string, note: string) => Promise<boolean>;
  reject: (id: string, reason: string) => Promise<boolean>;
  requestCorrection: (id: string, note: string) => Promise<boolean>;
  updateAndResubmit: (
    id: string,
    input: {
      documentTitle: string;
      sourceUrl: string | null;
      documentRef: string | null;
      classification: string;
      validUntil: string | null;
      note: string;
    },
  ) => Promise<boolean>;
  publish: (id: string, alertLevel: string | null) => Promise<boolean>;
  expire: (id: string, reason: string) => Promise<boolean>;
  decisionTrace: (recommendationId: string) => Promise<Record<string, unknown> | null>;
  authorities: () => Promise<ReviewAuthorityRow[] | null>;
  candidates: (search: string) => Promise<ReviewCandidate[] | null>;
  grantAuthority: (input: GrantAuthorityInput) => Promise<boolean>;
  revokeAuthority: (partyId: string, authority: ReviewAuthority, note: string) => Promise<boolean>;
};

async function client() {
  return getSupabaseClient(serviceConfig.supabase);
}

const defaultApi: ReviewApi = {
  async context() {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_review_context', {});
    return error ? null : parseReviewContext(data);
  },
  async queue() {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_review_queue', {
      p_status: null,
      p_target_kind: null,
      p_search: null,
      p_limit: 200,
    });
    return error ? null : parseQueue(data);
  },
  async targets() {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_review_targets', { p_target_kind: null });
    return error ? null : parseTargets(data);
  },
  async detail(id) {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_evidence_detail', { p_evidence_id: id });
    return error ? null : parseEvidenceDetail(data);
  },
  async create(input) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_create_evidence', {
      p_target_kind: input.targetKind,
      p_target_ref: input.targetRef,
      p_source_organization: input.sourceOrganization,
      p_source_type: input.sourceType,
      p_classification: input.classification,
      p_document_title: input.documentTitle,
      p_topic: input.topic,
      p_source_url: input.sourceUrl,
      p_source_code: input.sourceCode,
      p_document_ref: input.documentRef,
      p_published_on: input.publishedOn,
      p_accessed_at: input.accessedAt,
      p_language: input.language,
      p_crop_code: input.cropCode,
      p_districts: input.districts,
      p_stages: input.stages,
      p_confidence: input.confidence,
      p_valid_from: input.validFrom,
      p_valid_until: input.validUntil,
      p_supersedes_id: null,
      p_submit: input.submit,
    });
    return error === null;
  },
  async submit(id) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_submit_evidence', { p_evidence_id: id });
    return error === null;
  },
  async start(id) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_start_review', { p_evidence_id: id });
    return error === null;
  },
  async sourceCheck(id, status, note) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_set_source_check', {
      p_evidence_id: id,
      p_status: status,
      p_note: note,
    });
    return error === null;
  },
  async applicabilityCheck(id, status, note) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_set_applicability_check', {
      p_evidence_id: id,
      p_status: status,
      p_note: note,
    });
    return error === null;
  },
  async approve(id, note) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_approve_evidence', {
      p_evidence_id: id,
      p_note: note,
    });
    return error === null;
  },
  async reject(id, reason) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_reject_evidence', {
      p_evidence_id: id,
      p_reason: reason,
    });
    return error === null;
  },
  async requestCorrection(id, note) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_request_correction', {
      p_evidence_id: id,
      p_note: note,
    });
    return error === null;
  },
  async updateAndResubmit(id, input) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_update_and_resubmit', {
      p_evidence_id: id,
      p_document_title: input.documentTitle,
      p_source_url: input.sourceUrl,
      p_document_ref: input.documentRef,
      p_classification: input.classification,
      p_valid_until: input.validUntil,
      p_note: input.note,
    });
    return error === null;
  },
  async publish(id, alertLevel) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_publish_evidence', {
      p_evidence_id: id,
      p_alert_level: alertLevel,
    });
    return error === null;
  },
  async expire(id, reason) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('agri_expire_evidence', {
      p_evidence_id: id,
      p_reason: reason,
    });
    return error === null;
  },
  async decisionTrace(recommendationId) {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('recommendation_decision_trace', {
      p_recommendation_id: recommendationId,
    });
    if (error || data === null || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  },
  async authorities() {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_review_authorities_list', {});
    return error ? null : parseAuthorities(data);
  },
  async candidates(search) {
    const supabase = await client();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('agri_review_authority_candidates', {
      p_search: search.trim() || null,
    });
    return error ? null : parseCandidates(data);
  },
  async grantAuthority(input) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('grant_agri_review_authority', {
      p_party_id: input.partyId,
      p_authority: input.authority,
      p_scope_crops: input.scopeCrops,
      p_scope_districts: input.scopeDistricts,
      p_note: input.note,
    });
    return error === null;
  },
  async revokeAuthority(partyId, authority, note) {
    const supabase = await client();
    if (!supabase) return false;
    const { error } = await supabase.rpc('revoke_agri_review_authority', {
      p_party_id: partyId,
      p_authority: authority,
      p_note: note,
    });
    return error === null;
  },
};

export type ReviewWorkspace = {
  context: ReviewContext | null;
  queue: ReviewQueueRow[];
  targets: ReviewTarget[];
  status: ReviewLoadStatus;
  actionPending: boolean;
  actionFailed: boolean;
  refresh: () => void;
  readDetail: (id: string) => Promise<EvidenceDetail | null>;
  create: (input: CreateEvidenceInput) => Promise<boolean>;
  submit: (id: string) => Promise<boolean>;
  start: (id: string) => Promise<boolean>;
  sourceCheck: (id: string, status: 'authentic' | 'not_authentic', note: string) => Promise<boolean>;
  applicabilityCheck: (
    id: string,
    status: 'applicable' | 'not_applicable',
    note: string,
  ) => Promise<boolean>;
  approve: (id: string, note: string) => Promise<boolean>;
  reject: (id: string, reason: string) => Promise<boolean>;
  requestCorrection: (id: string, note: string) => Promise<boolean>;
  updateAndResubmit: ReviewApi['updateAndResubmit'];
  publish: (id: string, alertLevel: string | null) => Promise<boolean>;
  expire: (id: string, reason: string) => Promise<boolean>;
  decisionTrace: (recommendationId: string) => Promise<Record<string, unknown> | null>;
  authorities: () => Promise<ReviewAuthorityRow[] | null>;
  candidates: (search: string) => Promise<ReviewCandidate[] | null>;
  grantAuthority: (input: GrantAuthorityInput) => Promise<boolean>;
  revokeAuthority: (partyId: string, authority: ReviewAuthority, note: string) => Promise<boolean>;
};

export function useReviewWorkspace(params: {
  accountId: string | null;
  enabled: boolean;
  online: boolean;
  api?: ReviewApi;
}): ReviewWorkspace {
  const { accountId, enabled, online } = params;
  const api = params.api ?? defaultApi;
  const latest = useRef(api);
  latest.current = api;
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [queue, setQueue] = useState<ReviewQueueRow[]>([]);
  const [targets, setTargets] = useState<ReviewTarget[]>([]);
  const [status, setStatus] = useState<ReviewLoadStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const requested = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !accountId) {
      setContext(null);
      setQueue([]);
      setTargets([]);
      setStatus('idle');
      return;
    }
    if (!online) {
      setStatus('offline');
      return;
    }
    const key = `${accountId}:${attempt}`;
    if (requested.current === key) return;
    requested.current = key;
    let cancelled = false;
    setStatus('loading');
    setActionFailed(false);

    void (async () => {
      try {
        const loadedContext = await latest.current.context();
        if (cancelled) return;
        if (loadedContext === null) {
          setStatus('error');
          return;
        }
        setContext(loadedContext);
        if (!loadedContext.canReview && !loadedContext.canManage) {
          setQueue([]);
          setTargets([]);
          setStatus('ready');
          return;
        }
        const [rows, targetRows] = await Promise.all([
          latest.current.queue(),
          latest.current.targets(),
        ]);
        if (cancelled) return;
        if (rows === null || targetRows === null) {
          setStatus('error');
          return;
        }
        setQueue(rows);
        setTargets(targetRows);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (requested.current === key) requested.current = null;
    };
  }, [accountId, enabled, online, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  /*
   * A revocation happens on the server while this tab is still open. Re-reading
   * on focus is what makes the workspace disappear for the revoked reviewer
   * without a reload; the RPCs themselves already refuse every act.
   */
  useEffect(() => {
    if (!enabled || !accountId) return;
    const onFocus = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, accountId, refresh]);

  const act = useCallback(async (run: () => Promise<boolean>) => {
    setActionPending(true);
    setActionFailed(false);
    const ok = await run().catch(() => false);
    setActionPending(false);
    if (!ok) setActionFailed(true);
    // Reload either way: a refusal may be a revocation, and the context is what
    // decides whether the workspace may still be shown.
    refresh();
    return ok;
  }, [refresh]);

  return {
    context,
    queue,
    targets,
    status,
    actionPending,
    actionFailed,
    refresh,
    readDetail: useCallback((id: string) => latest.current.detail(id), []),
    create: useCallback((input) => act(() => latest.current.create(input)), [act]),
    submit: useCallback((id) => act(() => latest.current.submit(id)), [act]),
    start: useCallback((id) => act(() => latest.current.start(id)), [act]),
    sourceCheck: useCallback(
      (id, state, note) => act(() => latest.current.sourceCheck(id, state, note)),
      [act],
    ),
    applicabilityCheck: useCallback(
      (id, state, note) => act(() => latest.current.applicabilityCheck(id, state, note)),
      [act],
    ),
    approve: useCallback((id, note) => act(() => latest.current.approve(id, note)), [act]),
    reject: useCallback((id, reason) => act(() => latest.current.reject(id, reason)), [act]),
    requestCorrection: useCallback(
      (id, note) => act(() => latest.current.requestCorrection(id, note)),
      [act],
    ),
    updateAndResubmit: useCallback(
      (id, input) => act(() => latest.current.updateAndResubmit(id, input)),
      [act],
    ),
    publish: useCallback(
      (id, alertLevel) => act(() => latest.current.publish(id, alertLevel)),
      [act],
    ),
    expire: useCallback((id, reason) => act(() => latest.current.expire(id, reason)), [act]),
    decisionTrace: useCallback(
      (recommendationId) => latest.current.decisionTrace(recommendationId),
      [],
    ),
    authorities: useCallback(() => latest.current.authorities(), []),
    candidates: useCallback((search: string) => latest.current.candidates(search), []),
    grantAuthority: useCallback(
      (input) => act(() => latest.current.grantAuthority(input)),
      [act],
    ),
    revokeAuthority: useCallback(
      (partyId, authority, note) => act(() => latest.current.revokeAuthority(partyId, authority, note)),
      [act],
    ),
  };
}

/** Profile only needs the gate, not the queue. */
export function useReviewAccess(params: {
  accountId: string | null;
  enabled: boolean;
}): {
  canReview: boolean;
  canManage: boolean;
  canGrant: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
} {
  const { accountId, enabled } = params;
  const [state, setState] = useState<{
    canReview: boolean;
    canManage: boolean;
    canGrant: boolean;
    status: 'idle' | 'loading' | 'ready' | 'error';
  }>({ canReview: false, canManage: false, canGrant: false, status: 'idle' });

  useEffect(() => {
    if (!enabled || !accountId) {
      setState({ canReview: false, canManage: false, canGrant: false, status: 'idle' });
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading' }));
    void defaultApi.context().then((context) => {
      if (cancelled) return;
      setState({
        canReview: context?.canReview ?? false,
        canManage: context?.canManage ?? false,
        canGrant: context?.canGrant ?? false,
        status: context ? 'ready' : 'error',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, enabled]);

  return state;
}
