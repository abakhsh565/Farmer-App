import { fireEvent, screen } from '@testing-library/react';
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

export async function startSignIn(contact: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Number or email'), { target: { value: contact } });
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('group', { name: 'OTP verification' });
}

export function codeInputs(): HTMLElement[] {
  return screen.getAllByLabelText(/^Digit \d of 6$/);
}

export async function enterCode(code = developmentCode()): Promise<void> {
  const inputs = codeInputs();
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
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Create a password'), { target: { value: password } });
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

export async function completeSignIn(contact: string): Promise<void> {
  await startSignIn(contact);
  await enterCode();
  await continueOtp();
  await completeAccount();
}
