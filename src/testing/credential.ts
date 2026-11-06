import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The current credential sheet is contact → six-digit OTP → create account
 * (or password, when the contact already exists). Tests drive that real flow
 * rather than the retired Mobile number / Code / Verify sheet.
 */
export function developmentCode(): string {
  const hint = screen.getByText(/code is/i).textContent ?? '';
  const match = hint.match(/(\d{3,8})/);
  if (!match?.[1]) throw new Error('the development sheet did not show a code');
  return match[1];
}

const READY = { timeout: 5000 } as const;

export async function startSignIn(contact: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Number or email', {}, READY), {
    target: { value: contact },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('group', { name: 'OTP verification' });
  /*
   * The sheet moves focus to the first digit shortly after the step opens. If a
   * slow runner starts typing before that lands, the focus move swallows the
   * digits already typed and the code submitted is not the one the test wrote.
   * Wait for the real focus before handing over to the test.
   */
  await waitFor(() => expect(codeInputs()[0]).toHaveFocus(), READY);
}

export function codeInputs(): HTMLElement[] {
  return screen.getAllByLabelText(/^Digit \d of 6$/);
}

export async function enterCode(code = developmentCode()): Promise<void> {
  const inputs = codeInputs();
  /* A retry happens on the same step, when the one-time autofocus has already
     run; start at the first digit so the retry replaces the whole code. */
  inputs[0]?.focus();
  for (let index = 0; index < inputs.length; index += 1) {
    await userEvent.type(inputs[index] as HTMLElement, code[index] ?? '');
  }
}

export async function clearCode(): Promise<void> {
  for (const input of codeInputs()) await userEvent.clear(input);
}

export async function continueOtp(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

export async function completeAccount(
  name = 'Bilal Ahmed',
  password = 'secret123',
): Promise<void> {
  // The account step appears only after the OTP round-trip. CI can take longer
  // than the default 1s to render it even when the action is correct.
  fireEvent.change(await screen.findByLabelText('Your name', {}, READY), {
    target: { value: name },
  });
  fireEvent.change(await screen.findByLabelText('Create a password', {}, READY), {
    target: { value: password },
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Create account' }, READY));
}

export async function completeSignIn(contact: string): Promise<void> {
  await startSignIn(contact);
  await enterCode();
  await continueOtp();
  await completeAccount();
}
