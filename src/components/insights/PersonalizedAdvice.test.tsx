import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedRecommendation } from '@/intelligence/feed';
import { LocaleProvider } from '@/i18n/LocaleProvider';

vi.mock('./InsightFeedback', () => ({
  InsightFeedback: () => <div data-testid="feedback" />,
}));

import { PersonalizedAdvice } from './PersonalizedAdvice';

const row = (overrides: Partial<RankedRecommendation> = {}): RankedRecommendation => ({
  recommendationId: 'rec-1',
  cropId: 'crop-db-1',
  cropCode: 'cotton',
  kind: 'pest',
  title: 'Scout for pink bollworm',
  titleUr: 'گلابی سنڈی کی جانچ کریں',
  body: 'Check five plants across the field.',
  bodyUr: 'کھیت میں پانچ پودے دیکھیں۔',
  source: 'knowledge_base',
  sourceLabel: 'Punjab Agriculture Department',
  sourceUrl: 'https://agripunjab.gov.pk/pw_economic',
  evidenceTier: 'verified',
  confidence: 0.95,
  priority: 10,
  score: 0.82,
  components: { evidence: 0.12 },
  reasonCode: 'crop_stage',
  reasonContext: { crop_code: 'cotton', stage: 'fruiting', topic: 'pest' },
  ruleVersion: 1,
  actionKind: 'open_scan',
  actionLabel: 'Scan the crop',
  actionLabelUr: 'فصل اسکین کریں',
  validUntil: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('PersonalizedAdvice', () => {
  beforeEach(() => {
    localStorage.setItem('agri-shop.locale', 'en');
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  });

  it('shows the category, localized reason, source trust and safe source link in English', () => {
    render(
      <LocaleProvider>
        <PersonalizedAdvice rows={[row()]} onScan={() => {}} />
      </LocaleProvider>,
    );

    expect(screen.getByText('For you')).toBeInTheDocument();
    expect(screen.getByText('Pest alert')).toBeInTheDocument();
    expect(screen.getByText('Scout for pink bollworm')).toBeInTheDocument();
    expect(screen.getByText('For your Cotton at Fruiting')).toBeInTheDocument();
    expect(screen.getByText('Verified source')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View source/ })).toHaveAttribute(
      'href',
      'https://agripunjab.gov.pk/pw_economic',
    );
    expect(screen.getByTestId('feedback')).toBeInTheDocument();
  });

  it('shows Urdu copy and inherits RTL direction', async () => {
    localStorage.setItem('agri-shop.locale', 'ur');
    const user = userEvent.setup();
    const onScan = vi.fn();
    render(
      <LocaleProvider>
        <PersonalizedAdvice rows={[row()]} onScan={onScan} />
      </LocaleProvider>,
    );

    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(screen.getByText('آپ کے لیے')).toBeInTheDocument();
    expect(screen.getByText('گلابی سنڈی کی جانچ کریں')).toBeInTheDocument();
    expect(screen.getByText('کھیت میں پانچ پودے دیکھیں۔')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'فصل اسکین کریں' }));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('does not render a source link for a missing or non-HTTPS URL', () => {
    render(
      <LocaleProvider>
        <PersonalizedAdvice
          rows={[row({ sourceUrl: 'http://untrusted.example', sourceLabel: 'Editorial' })]}
        />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Editorial')).toBeInTheDocument();
  });
});
