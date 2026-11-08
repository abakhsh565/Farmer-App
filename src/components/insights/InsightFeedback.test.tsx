import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecommendationFeedbackValue } from '@/intelligence/useRecommendationFeedback';

const state = vi.hoisted(() => ({
  pending: null as RecommendationFeedbackValue['pending'],
  submitted: null as RecommendationFeedbackValue['submitted'],
  failed: false,
  submit: vi.fn(async () => true),
}));

vi.mock('@/i18n/LocaleProvider', () => ({ useLocale: () => ({ t: (key: string) => key }) }));
vi.mock('@/intelligence/useRecommendationFeedback', () => ({
  useRecommendationFeedback: () => ({
    pending: state.pending,
    submitted: state.submitted,
    failed: state.failed,
    submit: state.submit,
  }),
}));

import { InsightFeedback } from './InsightFeedback';

describe('InsightFeedback', () => {
  beforeEach(() => {
    state.pending = null;
    state.submitted = null;
    state.failed = false;
    state.submit = vi.fn(async () => true);
  });

  it('offers Helpful and Not relevant', async () => {
    const user = userEvent.setup();
    render(<InsightFeedback insightId="insight-1" insightKind="pest" recommendationId="rec-1" />);

    await user.click(screen.getByRole('button', { name: 'insight.feedback.helpful' }));

    expect(state.submit).toHaveBeenCalledWith('helpful');
    expect(screen.getByText('insight.feedback.prompt')).toBeInTheDocument();
  });

  it('shows confirmation only after a submitted verdict and disables both buttons', () => {
    state.submitted = 'not_relevant';
    render(<InsightFeedback insightId="insight-1" insightKind="pest" recommendationId="rec-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('insight.feedback.thanks');
    expect(screen.getByRole('button', { name: 'insight.feedback.helpful' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'insight.feedback.notRelevant' })).toBeDisabled();
  });

  it('shows a safe retry message after failure and leaves the buttons enabled', () => {
    state.failed = true;
    render(<InsightFeedback insightId="insight-1" insightKind="pest" recommendationId="rec-1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('insight.feedback.failed');
    expect(screen.getByRole('button', { name: 'insight.feedback.helpful' })).toBeEnabled();
  });
});
