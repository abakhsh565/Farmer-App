/**
 * Submits one explicit verdict about one recommendation.
 *
 * The key is deterministic per recommendation + verdict, so a retry after a
 * failed response cannot create a second row and move the interest twice. The
 * hook never reports success until `sendFeedback` does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { serviceConfig } from '@/services/config';
import {
  getIntelligenceGateway,
  type FeedbackInput,
  type FeedbackVerdict,
} from './client';
import type { EventContext } from './events';

export function feedbackKey(recommendationId: string, verdict: FeedbackVerdict): string {
  return `feedback:${recommendationId}:${verdict}`.slice(0, 100);
}

const defaultSend = async (input: FeedbackInput): Promise<boolean> => {
  const gateway = await getIntelligenceGateway(serviceConfig.supabase);
  if (!gateway) return false;
  return gateway.sendFeedback(input);
};

export type RecommendationFeedbackValue = {
  pending: FeedbackVerdict | null;
  submitted: FeedbackVerdict | null;
  failed: boolean;
  submit: (verdict: FeedbackVerdict) => Promise<boolean>;
};

export function useRecommendationFeedback(params: {
  recommendationId: string | null;
  insightRef: string;
  context?: EventContext;
  send?: (input: FeedbackInput) => Promise<boolean>;
}): RecommendationFeedbackValue {
  const { recommendationId, insightRef, context } = params;
  const sendRef = useRef(params.send ?? defaultSend);
  sendRef.current = params.send ?? defaultSend;
  const contextRef = useRef(context);
  contextRef.current = context;

  const [pending, setPending] = useState<FeedbackVerdict | null>(null);
  const [submitted, setSubmitted] = useState<FeedbackVerdict | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPending(null);
    setSubmitted(null);
    setFailed(false);
  }, [recommendationId, insightRef]);

  const submit = useCallback(
    async (verdict: FeedbackVerdict) => {
      if (!recommendationId || pending !== null || submitted !== null) return false;

      setPending(verdict);
      setFailed(false);
      try {
        const accepted = await sendRef.current({
          key: feedbackKey(recommendationId, verdict),
          verdict,
          recommendationId,
          insightRef,
          context: contextRef.current,
        });
        if (accepted) {
          setSubmitted(verdict);
          return true;
        }
        setFailed(true);
        return false;
      } catch {
        setFailed(true);
        return false;
      } finally {
        setPending(null);
      }
    },
    [recommendationId, insightRef, pending, submitted],
  );

  return { pending, submitted, failed, submit };
}
