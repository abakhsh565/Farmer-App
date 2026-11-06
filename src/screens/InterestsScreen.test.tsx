import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterestSetting } from '@/intelligence/interests';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

const state = vi.hoisted(() => ({
  settings: [] as InterestSetting[],
  status: 'ready' as 'idle' | 'loading' | 'ready' | 'error' | 'offline',
  online: true,
  pendingTopic: null as string | null,
  saveFailed: false,
  setPinned: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/session/SessionProvider', () => ({
  useSession: () => ({
    account: { id: 'account-1', name: 'Farmer' },
    prompt: vi.fn(),
  }),
}));
vi.mock('@/services/persistence', () => ({ useOnline: () => state.online }));
vi.mock('@/i18n/LocaleProvider', () => ({ useLocale: () => ({ t: (key: string) => key }) }));
vi.mock('@/intelligence/useInterestSettings', () => ({
  useInterestSettings: () => ({
    settings: state.settings,
    status: state.status,
    pendingTopic: state.pendingTopic,
    saveFailed: state.saveFailed,
    refresh: state.refresh,
    setPinned: state.setPinned,
    remove: state.remove,
  }),
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { InterestsScreen } from './InterestsScreen';

const row = (overrides: Partial<InterestSetting> = {}): InterestSetting => ({
  topic: 'topic:pest',
  cropCode: null,
  weight: 0.42,
  confidence: 0.6,
  source: 'behaviour',
  pinned: false,
  updatedAt: null,
  ...overrides,
});

describe('InterestsScreen', () => {
  beforeEach(() => {
    state.settings = [
      row({ topic: 'topic:pest', pinned: true }),
      row({ topic: 'topic:market', source: 'explicit', pinned: false }),
      row({ topic: 'topic:weather', source: 'behaviour', pinned: false }),
    ];
    state.status = 'ready';
    state.online = true;
    state.pendingTopic = null;
    state.saveFailed = false;
    state.setPinned = vi.fn(async () => true);
    state.remove = vi.fn(async () => true);
    state.refresh = vi.fn();
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('separates kept, chosen and learned interests', () => {
    render(<InterestsScreen onBack={() => {}} />);

    expect(screen.getByText('interests.pinnedSection')).toBeInTheDocument();
    expect(screen.getByText('interests.chosenSection')).toBeInTheDocument();
    expect(screen.getByText('interests.learnedSection')).toBeInTheDocument();
    expect(screen.getByText('interests.topic.pest')).toBeInTheDocument();
    expect(screen.getByText('interests.topic.market')).toBeInTheDocument();
    expect(screen.getByText('interests.topic.weather')).toBeInTheDocument();
  });

  it('reports success only after the pin mutation resolves true', async () => {
    const user = userEvent.setup();
    render(<InterestsScreen onBack={() => {}} />);

    await user.click(
      screen.getByRole('button', { name: 'interests.keep: interests.topic.market' }),
    );

    await waitFor(() => expect(state.setPinned).toHaveBeenCalledWith('topic:market', true));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('interests.kept'));
  });

  it('shows a failure and does not claim the pin succeeded', async () => {
    state.setPinned = vi.fn(async () => false);
    const user = userEvent.setup();
    render(<InterestsScreen onBack={() => {}} />);

    await user.click(
      screen.getByRole('button', { name: 'interests.keep: interests.topic.market' }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('interests.saveFailed'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables every write while offline', () => {
    state.online = false;
    state.status = 'offline';
    render(<InterestsScreen onBack={() => {}} />);

    expect(
      screen.getByRole('button', { name: 'interests.keep: interests.topic.market' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'interests.remove: interests.topic.market' }),
    ).toBeDisabled();
  });
});
