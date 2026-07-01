import type { FlankStore, MembershipRole, MembershipWithWorkspace } from '@flank/core';

/**
 * The fully-resolved request principal: an authenticated user, the one workspace this request acts
 * in, and the role the user holds there. Identity comes from the Auth.js / FerrisKey session, but
 * tenancy is re-derived from LIVE memberships every request — never trusted from the token — so a
 * revoked membership takes effect immediately (fail-closed, Product Invariant 8).
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
  /** Local AppUser id from the authenticated Auth.js session, or null when unauthenticated. */
  readonly userId: string | null;
  /** Preferred workspace id from a non-authoritative hint cookie, or null. */
  readonly workspaceHint: string | null;
  readonly store: FlankStore;
}

/**
 * Resolve an authenticated user id to an authorized workspace. Pure over an injected store, so it is
 * unit-testable without Next/Auth.js wiring. A null user id is `no_session`; an authenticated user
 * with zero live memberships is `no_workspace`. The hint only ever SELECTS among memberships the
 * user actually has — it can never widen access — and an unmatched hint falls back to the first
 * membership (memberships arrive ordered by createdAt, id).
 */
export const resolveWorkspace = async (
  input: ResolveWorkspaceInput,
): Promise<WorkspaceResolution> => {
  if (input.userId === null) return { ok: false, reason: 'no_session' };

  const memberships = await input.store.listMembershipsForUser(input.userId);
  if (memberships.length === 0) return { ok: false, reason: 'no_workspace' };

  const hinted =
    input.workspaceHint === null
      ? undefined
      : memberships.find((m) => m.workspace.id === input.workspaceHint);
  const active = hinted ?? memberships[0];

  return {
    ok: true,
    userId: input.userId,
    workspaceId: active.workspace.id,
    role: active.membership.role,
    memberships,
  };
};
