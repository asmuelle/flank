'use server';

import { EmailSchema } from '@flank/core';
import { redirect } from 'next/navigation';
import { startSession } from '../../../lib/auth/session';
import { getStore } from '../../../lib/store';

/**
 * Dev sign-in: look up a user by email and mint a session. No password / OAuth / magic-link yet
 * (deferred) — but the failure path is already constant: an unparseable or unknown email yields the
 * SAME generic error, so this endpoint can never be used to enumerate which emails have accounts.
 */
export const signIn = async (formData: FormData): Promise<void> => {
  const parsed = EmailSchema.safeParse(formData.get('email'));
  if (!parsed.success) redirect('/auth/sign-in?e=invalid');

  const user = await getStore().findUserByEmail(parsed.data);
  if (user === null) redirect('/auth/sign-in?e=invalid');

  await startSession(user.id);
  redirect('/authed');
};
