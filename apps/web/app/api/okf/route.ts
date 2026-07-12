import { bundleToTar, loadWorkspaceExport, projectWorkspaceBundle } from '@flank/okf-export';
import { NextResponse, type NextRequest } from 'next/server';
import { resolveActiveWorkspace } from '../../../lib/auth/session';
import { getStore } from '../../../lib/store';

/**
 * GET /api/okf — the workspace's competitive knowledge as an OKF bundle.
 * Default response is a deterministic ustar tarball; `?format=json` returns
 * `{ files, findings }` for programmatic consumers.
 *
 * Fail closed (projection-only rule): any `error` finding — an unverified or
 * unresolvable citation, a structural bundle defect — returns 409 with the
 * findings instead of a bundle. Unproven provenance never ships.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const active = await resolveActiveWorkspace();
  const workspaceName =
    active.memberships.find((m) => m.workspace.id === active.workspaceId)?.workspace.name ??
    active.workspaceId;

  const input = await loadWorkspaceExport(
    getStore(),
    { id: active.workspaceId, name: workspaceName },
    request.nextUrl.origin,
  );
  const { files, findings } = projectWorkspaceBundle(input);

  if (findings.some((finding) => finding.severity === 'error')) {
    return NextResponse.json({ error: 'bundle failed the publish gate', findings }, { status: 409 });
  }

  if (request.nextUrl.searchParams.get('format') === 'json') {
    return NextResponse.json({ files: Object.fromEntries(files), findings });
  }

  return new NextResponse(Buffer.from(bundleToTar(files)), {
    headers: {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="flank-okf-${active.workspaceId}.tar"`,
      // The bundle reflects live published state; never cache across sessions.
      'Cache-Control': 'private, no-store',
    },
  });
}
