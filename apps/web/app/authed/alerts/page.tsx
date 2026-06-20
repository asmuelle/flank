import { resolveActiveWorkspace } from '../../../lib/auth/session';
import { getStore } from '../../../lib/store';
import { summarizeAlerts, toAlertRows } from '../../../lib/views/alerts';

const formatStamp = (iso: string): string => new Date(iso).toUTCString().replace(' GMT', ' UTC');

export default async function AlertsPage() {
  const active = await resolveActiveWorkspace();
  const alerts = await getStore().listAlertsForWorkspace(active.workspaceId);
  const rows = toAlertRows(alerts);
  const summary = summarizeAlerts(alerts);

  return (
    <div className="surface">
      <header className="surface-head">
        <p className="masthead-kicker mono">{active.role} · alert delivery</p>
        <h1 className="surface-title">Delivery log</h1>
        <p className="surface-sub">
          {summary.delivered} delivered · {summary.failed} failed · {summary.queued} queued. A
          failed alert is retried on the next sweep; a delivered alert is never re-sent.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="empty">
          No alerts yet. Add a destination and, once a material change publishes, the delivery sweep
          fans it out here.
        </p>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Competitor</th>
              <th scope="col">Change</th>
              <th scope="col">Channel</th>
              <th scope="col">Target</th>
              <th scope="col">When</th>
              <th scope="col">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <span className="alert-status" data-status={row.status}>
                    {row.status}
                  </span>
                </td>
                <td>{row.competitorName}</td>
                <td>{row.whatChanged}</td>
                <td className="mono">{row.channel}</td>
                <td className="mono">{row.target}</td>
                <td className="mono">
                  {formatStamp(row.deliveredAt ?? row.enqueuedAt)}
                  {row.status === 'failed' && row.lastError !== null ? (
                    <span className="alert-error"> — {row.lastError}</span>
                  ) : null}
                </td>
                <td className="mono">{row.attemptCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
