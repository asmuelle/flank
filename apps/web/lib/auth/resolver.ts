import type { FlankStore, MembershipRole, MembershipWithWorkspace } from '@flank/core';
import { verifySession } from './session-crypto';

/**
 * The fully-resolved request principal: a verified user, the one workspace this request acts in, and
 * the role the user holds there. Tenancy is re-derived from LIVE memberships every request — never
 * trusted from the cookie — so a revoked membership takes effect immediately (fail-closed).
 */
export type WorkspaceResolution =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly workspaceId: string;
      readonly role: MembershipRole;
      readonly memberships: readonly MembershipWithWorkspace[];
    }
  | { readonly ok: false; readonly reason: 'no_session' | 'no_workspace' };

export interface ResolveWorkspaceInput {
  /** Raw signed cookie value, or null when the cookie is absent. */
  readonly token: string | null;
  /** Preferred workspace id from a non-authoritative hint cookie, or null. */
  readonly workspaceHint: string | null;
  readonly secret: string;
  readonly store: FlankStore;
  readonly nowMs: number;
}

/**
 * Resolve a request to an authorized workspace. Pure over an injected store, so it is unit-testable
 * without Next wiring. A bad/absent/expired cookie is `no_session`; a valid user with zero live
 * memberships is `no_workspace`. The hint only ever SELECTS among memberships the user actually has —
 * it can never widen access — and an unmatched hint falls back to the first membership.
 */
export const resolveWorkspace = async (
  input: ResolveWorkspaceInput,
): Promise<WorkspaceResolution> => {
  if (input.token === null) return { ok: false, reason: 'no_session' };

  const verified = verifySession(input.token, input.secret, input.nowMs);
  if (!verified.ok) return { ok: false, reason: 'no_session' };

  const memberships = await input.store.listMembershipsForUser(verified.principal.uid);
  if (memberships.length === 0) return { ok: false, reason: 'no_workspace' };

  const hinted =
    input.workspaceHint === null
      ? undefined
      : memberships.find((m) => m.workspace.id === input.workspaceHint);
  const active = hinted ?? memberships[0];

  return {
    ok: true,
    userId: verified.principal.uid,
    workspaceId: active.workspace.id,
    role: active.membership.role,
    memberships,
  };
};
