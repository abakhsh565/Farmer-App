import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertPreferences, AlertPreferencesInput } from '@/intelligence/alertPreferences';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

const state = vi.hoisted(() => {
  const defaults: AlertPreferences = {
    inApp: true,
    push: false,
    categories: ['weather', 'pest', 'disease', 'crop_stage'],
    consentVersion: 0,
    consentAt: null,
    pushAvailable: false,
  };
  return {
    account: { id: 'account-1', name: 'Farmer' } as { id: string; name: string } | null,
    online: true,
    preferences: defaults,
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error' | 'offline',
    saving: false,
    saveFailed: false,
    save: vi.fn(async (input: AlertPreferencesInput) => ({
      ...defaults,
      ...input,
      pushAvailable: false,
    })),
    refresh: vi.fn(),
    prompt: vi.fn(),
  };
});

vi.mock('sonner', () => ({ toast }));
vi.mock('@/session/SessionProvider', () => ({
  useSession: () => ({ account: state.account, prompt: state.prompt }),
}));
vi.mock('@/services/persistence', () => ({ useOnline: () => state.online }));
vi.mock('@/i18n/LocaleProvider', () => ({ useLocale: () => ({ t: (key: string) => key }) }));
vi.mock('@/intelligence/useAlertPreferences', () => ({
  useAlertPreferences: () => ({
    preferences: state.preferences,
    status: state.status,
    saving: state.saving,
    saveFailed: state.saveFailed,
    save: state.save,
    refresh: state.refresh,
  }),
}));

import { AlertSettingsScreen } from './AlertSettingsScreen';

describe('AlertSettingsScreen', () => {
  beforeEach(() => {
    state.account = { id: 'account-1', name: 'Farmer' };
    state.online = true;
    state.status = 'ready';
    state.saving = false;
    state.saveFailed = false;
    state.preferences = {
      inApp: true,
      push: false,
      categories: ['weather', 'pest', 'disease', 'crop_stage'],
      consentVersion: 0,
      consentAt: null,
      pushAvailable: false,
    };
    state.save = vi.fn(async (input: AlertPreferencesInput) => ({
      ...state.preferences,
      ...input,
      pushAvailable: false,
    }));
    state.refresh = vi.fn();
    state.prompt = vi.fn();
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('shows in-app control, category choices and an honestly disabled push row', () => {
    render(<AlertSettingsScreen onBack={() => {}} />);

    expect(screen.getByRole('switch', { name: 'alerts.settings.inApp' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'alerts.settings.push' })).toBeDisabled();
    expect(screen.getByText('alerts.settings.pushUnavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'alerts.settings.weather' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('saves the selected categories with push off', async () => {
    const user = userEvent.setup();
    render(<AlertSettingsScreen onBack={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'alerts.settings.pest' }));
    await user.click(screen.getByRole('button', { name: 'alerts.settings.save' }));

    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        inApp: true,
        push: false,
        categories: ['weather', 'disease', 'crop_stage'],
        consentVersion: 0,
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('alerts.settings.saved'));
  });

  it('refuses to save an empty category set while in-app alerts are on', async () => {
    const user = userEvent.setup();
    render(<AlertSettingsScreen onBack={() => {}} />);

    for (const category of ['weather', 'pest', 'disease', 'cropStage']) {
      await user.click(screen.getByRole('button', { name: `alerts.settings.${category}` }));
    }
    await user.click(screen.getByRole('button', { name: 'alerts.settings.save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('alerts.settings.emptyCategory');
    expect(state.save).not.toHaveBeenCalled();
  });

  it('shows the offline state and does not offer controls', () => {
    state.online = false;
    state.status = 'offline';
    render(<AlertSettingsScreen onBack={() => {}} />);

    expect(screen.getByText('alerts.offline')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('asks for an account before showing controls', async () => {
    const user = userEvent.setup();
    state.account = null;
    state.status = 'idle';
    render(<AlertSettingsScreen onBack={() => {}} />);

    expect(screen.getByText('alerts.settings.signIn')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'profile.account.signIn' }));
    expect(state.prompt).toHaveBeenCalledWith('session.why.alerts');
  });
});
