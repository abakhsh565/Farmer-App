import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialSheet } from './CredentialSheet';

/**
 * The way out of the password screen.
 *
 * Every phone account on this project was created by verifying the number, so it
 * carries no password — which makes "enter the password for 03001234567" a question
 * with no correct answer. What is pinned here is the repair: a farmer who lands on
 * that screen can ask for a code, prove the number, and set a password, and the
 * password is saved through `updateUser` on the session that proof produced.
 */

const signIn = vi.fn(() => ({ ok: true as const }));
const dismiss = vi.fn();

vi.mock('@/i18n/LocaleProvider', () => ({
  useLocale: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./SessionProvider', () => ({
  useSession: () => ({ pendingReason: 'session.why.message', signIn, dismiss }),
}));

const auth = {
  signInWithOtp: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ data: { session: { access_token: 'token' } }, error: null })),
  updateUser: vi.fn(async () => ({ error: null })),
  signInWithPassword: vi.fn(async () => ({ data: { session: { access_token: 'token' } }, error: null })),
};

const client = {
  auth,
  rpc: vi.fn(async () => ({ data: true, error: null })),
};

vi.mock('@/services/supabaseClient', () => ({
  getSupabaseClient: async () => client,
  toE164: (value: string) => `+92${value.replace(/^0/, '')}`,
}));

/** Types a number on the first step and lands on the code step. */
async function reachCodeStep() {
  await userEvent.type(screen.getByLabelText('credential.contactLabel'), '03001234567');
  await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));
  await waitFor(() => expect(screen.getAllByLabelText('credential.otpDigit')).toHaveLength(6));
}

/** The six boxes accept a whole code at once, as a paste or a one-time-code fill does. */
function enterCode(code: string) {
  const boxes = screen.getAllByLabelText('credential.otpDigit');
  fireEvent.change(boxes[0]!, { target: { value: code } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CredentialSheet password reset', () => {
  it('offers a code on the password screen, because that screen can be a dead end', async () => {
    render(<CredentialSheet />);

    await reachCodeStep();
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));

    await waitFor(() => expect(screen.getByText('credential.passwordPrompt')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'credential.forgotPassword' })).toBeInTheDocument();
  });

  it('asks for the number again by code, then for a new password', async () => {
    render(<CredentialSheet />);

    await reachCodeStep();
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));
    await waitFor(() => expect(screen.getByText('credential.passwordPrompt')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'credential.forgotPassword' }));
    await waitFor(() => expect(screen.getAllByLabelText('credential.otpDigit')).toHaveLength(6));
    /* The request is for an account that must already exist: a mistyped digit must
       not invent one. */
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      phone: '+923001234567',
      options: { shouldCreateUser: false },
    });

    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));

    await waitFor(() => expect(screen.getByText('credential.newPasswordPrompt')).toBeInTheDocument());
    expect(auth.verifyOtp).toHaveBeenCalledWith({ phone: '+923001234567', type: 'sms', token: '123456' });
  });

  it('refuses a short password and saves a good one through the verified session', async () => {
    render(<CredentialSheet />);

    await reachCodeStep();
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));
    await waitFor(() => expect(screen.getByText('credential.passwordPrompt')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'credential.forgotPassword' }));
    await waitFor(() => expect(screen.getAllByLabelText('credential.otpDigit')).toHaveLength(6));
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));
    await waitFor(() => expect(screen.getByText('credential.newPasswordPrompt')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('credential.createPasswordLabel'), '123');
    await userEvent.click(screen.getByRole('button', { name: 'credential.savePassword' }));
    expect(screen.getByRole('alert')).toHaveTextContent('credential.weakPassword');
    expect(auth.updateUser).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('credential.createPasswordLabel'), '456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.savePassword' }));

    await waitFor(() => expect(auth.updateUser).toHaveBeenCalledWith({ password: '123456' }));
    await waitFor(() => expect(signIn).toHaveBeenCalled());
  });

  it('reports a code the server refuses instead of pretending the number is proved', async () => {
    auth.verifyOtp.mockResolvedValueOnce({
      data: { session: null },
      error: { message: 'Token has expired or is invalid' },
    } as never);

    render(<CredentialSheet />);

    await reachCodeStep();
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));
    await waitFor(() => expect(screen.getByText('credential.passwordPrompt')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'credential.forgotPassword' }));
    await waitFor(() => expect(screen.getAllByLabelText('credential.otpDigit')).toHaveLength(6));
    enterCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'credential.continue' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('credential.otpWrong'));
    expect(screen.queryByText('credential.newPasswordPrompt')).not.toBeInTheDocument();
  });
});
