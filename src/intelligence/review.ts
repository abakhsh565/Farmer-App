/**
 * Review workspace types.
 *
 * The reviewer UI never reads `agri_evidence_items` directly: both tables have
 * RLS enabled with no client policy, and every read goes through a
 * security-definer RPC that checks the signed-in party's named authority and
 * scope. These parsers exist to keep a malformed response from becoming a
 * misleading verification badge.
 */

export const REVIEW_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'correction_requested',
  'approved',
  'rejected',
  'published',
  'expired',
  'superseded',
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewTargetKind = 'knowledge_entry' | 'official_advisory' | 'forecast_rule';
export type ReviewAuthority = 'evidence_reviewer' | 'content_manager';

export type ReviewCounts = {
  submitted: number;
  underReview: number;
  correctionRequested: number;
  approved: number;
  published: number;
  rejected: number;
  closed: number;
};

export type ReviewContext = {
  partyId: string;
  canReview: boolean;
  canManage: boolean;
  canGrant: boolean;
  counts: ReviewCounts;
};

export type ReviewQueueRow = {
  id: string;
  targetKind: ReviewTargetKind;
  targetRef: string;
  targetLabel: string;
  documentTitle: string;
  sourceOrganization: string;
  sourceType: string;
  classification: string;
  status: ReviewStatus;
  cropCode: string | null;
  topic: string;
  districts: string[];
  stages: string[];
  version: number;
  validUntil: string | null;
  submittedAt: string | null;
  reviewerId: string | null;
  supersedesId: string | null;
  rejectionReason: string | null;
  canReview: boolean;
  canManage: boolean;
};

export type ReviewTarget = {
  targetKind: ReviewTargetKind;
  targetRef: string;
  label: string;
  cropCode: string | null;
  topic: string;
  currentState: string;
  currentEvidenceId: string | null;
  currentEvidenceStatus: string | null;
  version: number | null;
};

export type EvidenceReviewEntry = {
  id: string;
  action: string;
  actorId: string | null;
  actorRole: string;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceRecord = {
  id: string;
  targetKind: ReviewTargetKind;
  targetRef: string;
  version: number;
  classification: string;
  sourceType: string;
  sourceOrganization: string;
  sourceCode: string | null;
  sourceUrl: string | null;
  documentTitle: string;
  documentRef: string | null;
  publishedOn: string | null;
  accessedAt: string;
  language: string;
  cropCode: string | null;
  topic: string;
  districts: string[];
  stages: string[];
  confidence: number | null;
  status: ReviewStatus;
  sourceCheckStatus: string;
  applicabilityStatus: string;
  agronomicStatus: string;
  reviewerId: string | null;
  reviewNote: string | null;
  rejectionReason: string | null;
  correctionNote: string | null;
  validFrom: string;
  validUntil: string | null;
  publishedAt: string | null;
  submittedAt: string | null;
  supersedesId: string | null;
};

export type EvidenceAccess = {
  canReview: boolean;
  canManage: boolean;
  isSubmitter: boolean;
  isReviewer: boolean;
  canStartReview: boolean;
  canCheck: boolean;
  canApprove: boolean;
  canPublish: boolean;
  canExpire: boolean;
};

export type EvidenceDetail = {
  evidence: EvidenceRecord;
  target: Record<string, unknown>;
  reviewHistory: EvidenceReviewEntry[];
  usage: {
    liveDecisions: number;
    lastUsedAt: string | null;
    latest: Array<{
      id: string;
      alertLevel: string | null;
      alertSourceKind: string | null;
      createdAt: string;
      validUntil: string | null;
    }>;
  };
  access: EvidenceAccess;
};

export type CreateEvidenceInput = {
  targetKind: ReviewTargetKind;
  targetRef: string;
  sourceOrganization: string;
  sourceType: string;
  classification: string;
  documentTitle: string;
  topic: string;
  sourceUrl: string | null;
  sourceCode: string | null;
  documentRef: string | null;
  publishedOn: string | null;
  accessedAt: string;
  language: string;
  cropCode: string | null;
  districts: string[];
  stages: string[];
  confidence: number | null;
  validFrom: string;
  validUntil: string | null;
  submit: boolean;
};

const STATUS_SET = new Set<string>(REVIEW_STATUSES);
const KIND_SET = new Set<string>(['knowledge_entry', 'official_advisory', 'forecast_rule']);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((row): row is string => typeof row === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function orNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseReviewContext(data: unknown): ReviewContext | null {
  const row = asRecord(data);
  if (typeof row.party_id !== 'string') return null;
  const counts = asRecord(row.counts);
  return {
    partyId: row.party_id,
    canReview: asBoolean(row.can_review),
    canManage: asBoolean(row.can_manage),
    canGrant: asBoolean(row.can_grant),
    counts: {
      submitted: asNumber(counts.submitted),
      underReview: asNumber(counts.under_review),
      correctionRequested: asNumber(counts.correction_requested),
      approved: asNumber(counts.approved),
      published: asNumber(counts.published),
      rejected: asNumber(counts.rejected),
      closed: asNumber(counts.closed),
    },
  };
}

export function parseQueue(data: unknown): ReviewQueueRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    const row = asRecord(value);
    if (typeof row.id !== 'string' || typeof row.target_kind !== 'string') return [];
    if (!KIND_SET.has(row.target_kind) || typeof row.status !== 'string' || !STATUS_SET.has(row.status)) {
      return [];
    }
    return [{
      id: row.id,
      targetKind: row.target_kind as ReviewTargetKind,
      targetRef: asString(row.target_ref),
      targetLabel: asString(row.target_label),
      documentTitle: asString(row.document_title),
      sourceOrganization: asString(row.source_organization),
      sourceType: asString(row.source_type),
      classification: asString(row.classification),
      status: row.status as ReviewStatus,
      cropCode: orNull(row.crop_code),
      topic: asString(row.topic),
      districts: asStringArray(row.districts),
      stages: asStringArray(row.stages),
      version: asNumber(row.version),
      validUntil: orNull(row.valid_until),
      submittedAt: orNull(row.submitted_at),
      reviewerId: orNull(row.reviewer_id),
      supersedesId: orNull(row.supersedes_id),
      rejectionReason: orNull(row.rejection_reason),
      canReview: asBoolean(row.can_review),
      canManage: asBoolean(row.can_manage),
    }];
  });
}

export function parseTargets(data: unknown): ReviewTarget[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    const row = asRecord(value);
    if (typeof row.target_ref !== 'string' || typeof row.target_kind !== 'string') return [];
    if (!KIND_SET.has(row.target_kind)) return [];
    return [{
      targetKind: row.target_kind as ReviewTargetKind,
      targetRef: row.target_ref,
      label: asString(row.label),
      cropCode: orNull(row.crop_code),
      topic: asString(row.topic),
      currentState: asString(row.current_state),
      currentEvidenceId: orNull(row.current_evidence_id),
      currentEvidenceStatus: orNull(row.current_evidence_status),
      version: typeof row.version === 'number' ? row.version : null,
    }];
  });
}

export function parseEvidenceDetail(data: unknown): EvidenceDetail | null {
  const root = asRecord(data);
  const evidence = asRecord(root.evidence);
  if (typeof evidence.id !== 'string' || typeof evidence.target_kind !== 'string') return null;
  if (!KIND_SET.has(evidence.target_kind)) return null;
  const history = Array.isArray(root.review_history)
    ? root.review_history.flatMap((value) => {
        const row = asRecord(value);
        if (typeof row.id !== 'string' || typeof row.action !== 'string') return [];
        return [{
          id: row.id,
          action: row.action,
          actorId: orNull(row.actor_id),
          actorRole: asString(row.actor_role),
          actorName: orNull(row.actor_name),
          fromStatus: orNull(row.from_status),
          toStatus: orNull(row.to_status),
          note: orNull(row.note),
          detail: asRecord(row.detail),
          createdAt: asString(row.created_at),
        }];
      })
    : [];
  const usage = asRecord(root.usage);
  const latest = Array.isArray(usage.latest)
    ? usage.latest.flatMap((value) => {
        const row = asRecord(value);
        if (typeof row.id !== 'string') return [];
        return [{
          id: row.id,
          alertLevel: orNull(row.alert_level),
          alertSourceKind: orNull(row.alert_source_kind),
          createdAt: asString(row.created_at),
          validUntil: orNull(row.valid_until),
        }];
      })
    : [];
  const access = asRecord(root.access);

  return {
    evidence: {
      id: evidence.id,
      targetKind: evidence.target_kind as ReviewTargetKind,
      targetRef: asString(evidence.target_ref),
      version: asNumber(evidence.version),
      classification: asString(evidence.classification),
      sourceType: asString(evidence.source_type),
      sourceOrganization: asString(evidence.source_organization),
      sourceCode: orNull(evidence.source_code),
      sourceUrl: orNull(evidence.source_url),
      documentTitle: asString(evidence.document_title),
      documentRef: orNull(evidence.document_ref),
      publishedOn: orNull(evidence.published_on),
      accessedAt: asString(evidence.accessed_at),
      language: asString(evidence.language),
      cropCode: orNull(evidence.crop_code),
      topic: asString(evidence.topic),
      districts: asStringArray(evidence.districts),
      stages: asStringArray(evidence.stages),
      confidence:
        typeof evidence.confidence === 'number' && Number.isFinite(evidence.confidence)
          ? evidence.confidence
          : null,
      status: (typeof evidence.status === 'string' && STATUS_SET.has(evidence.status)
        ? evidence.status
        : 'draft') as ReviewStatus,
      sourceCheckStatus: asString(evidence.source_check_status),
      applicabilityStatus: asString(evidence.applicability_status),
      agronomicStatus: asString(evidence.agronomic_status),
      reviewerId: orNull(evidence.reviewer_id),
      reviewNote: orNull(evidence.review_note),
      rejectionReason: orNull(evidence.rejection_reason),
      correctionNote: orNull(evidence.correction_note),
      validFrom: asString(evidence.valid_from),
      validUntil: orNull(evidence.valid_until),
      publishedAt: orNull(evidence.published_at),
      submittedAt: orNull(evidence.submitted_at),
      supersedesId: orNull(evidence.supersedes_id),
    },
    target: asRecord(root.target),
    reviewHistory: history,
    usage: {
      liveDecisions: asNumber(usage.live_decisions),
      lastUsedAt: orNull(usage.last_used_at),
      latest,
    },
    access: {
      canReview: asBoolean(access.can_review),
      canManage: asBoolean(access.can_manage),
      isSubmitter: asBoolean(access.is_submitter),
      isReviewer: asBoolean(access.is_reviewer),
      canStartReview: asBoolean(access.can_start_review),
      canCheck: asBoolean(access.can_check),
      canApprove: asBoolean(access.can_approve),
      canPublish: asBoolean(access.can_publish),
      canExpire: asBoolean(access.can_expire),
    },
  };
}

export function isReviewStatus(value: string): value is ReviewStatus {
  return STATUS_SET.has(value);
}

export type ReviewAuthorityRow = {
  partyId: string;
  displayName: string;
  authority: ReviewAuthority;
  scopeCrops: string[];
  scopeDistricts: string[];
  grantedAt: string;
  grantedByName: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  note: string;
  isActive: boolean;
};

export type ReviewCandidate = {
  partyId: string;
  displayName: string;
  hasReviewer: boolean;
  hasManager: boolean;
};

export type GrantAuthorityInput = {
  partyId: string;
  authority: ReviewAuthority;
  scopeCrops: string[];
  scopeDistricts: string[];
  note: string;
};

/**
 * Authority roster. The server refuses the read without the admin capability,
 * so a malformed row here is only ever a defensive drop, never a grant.
 */
export function parseAuthorities(data: unknown): ReviewAuthorityRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    const row = asRecord(value);
    if (typeof row.party_id !== 'string') return [];
    if (row.authority !== 'evidence_reviewer' && row.authority !== 'content_manager') return [];
    const revokedAt = orNull(row.revoked_at);
    return [{
      partyId: row.party_id,
      displayName: asString(row.display_name),
      authority: row.authority,
      scopeCrops: asStringArray(row.scope_crops),
      scopeDistricts: asStringArray(row.scope_districts),
      grantedAt: asString(row.granted_at),
      grantedByName: orNull(row.granted_by_name),
      revokedAt,
      revokedByName: orNull(row.revoked_by_name),
      note: asString(row.note),
      isActive: revokedAt === null,
    }];
  });
}

export function parseCandidates(data: unknown): ReviewCandidate[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    const row = asRecord(value);
    if (typeof row.party_id !== 'string') return [];
    return [{
      partyId: row.party_id,
      displayName: asString(row.display_name),
      hasReviewer: asBoolean(row.has_reviewer),
      hasManager: asBoolean(row.has_manager),
    }];
  });
}
