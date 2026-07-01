/**
 * Provision the local FerrisKey instance for Flank's OIDC login. Idempotent-ish: every step
 * tolerates an already-exists (409/422) response so re-runs are safe. Targets the FerrisKey v0.6.x
 * admin REST API (paths verified against ferriskey/ferriskey @ v0.6.1).
 *
 * Steps, all against FERRISKEY_API_URL (default http://localhost:3333):
 *   1. Mint an admin token   — password grant on the `master` realm via `security-admin-console`.
 *   2. Create realm `flank`.
 *   3. Create a confidential client `flank-web` and read its generated secret.
 *   4. Register the redirect + post-logout URIs for the Next.js app.
 *   5. Create the demo user (matching the seed email) and set its password.
 *
 * It then prints the exact env values to paste into `.env`. The FerrisKey console
 * (http://localhost:5555, admin/admin) remains the source of truth if anything drifts.
 *
 *   just ferriskey-bootstrap
 */

const API = (process.env.FERRISKEY_API_URL ?? 'http://localhost:3333').replace(/\/$/, '');
const ADMIN_USER = process.env.FERRISKEY_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.FERRISKEY_ADMIN_PASSWORD ?? 'admin';
const REALM = process.env.FERRISKEY_REALM ?? 'flank';
const CLIENT_ID = process.env.FERRISKEY_CLIENT_ID ?? 'flank-web';
const APP_ORIGIN = (process.env.FLANK_WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const REDIRECT_URI = `${APP_ORIGIN}/api/auth/callback/ferriskey`;
const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'founder@northwind.test';
const DEMO_PASSWORD = process.env.FERRISKEY_DEMO_PASSWORD ?? 'flank-demo-password';

/** A response that means "already created" — treated as success so the script is re-runnable. */
const ALREADY_EXISTS = new Set([409, 422]);

const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly token?: string;
  readonly json?: unknown;
  readonly form?: Record<string, string>;
  /** Status codes (besides 2xx) to accept as success (e.g. already-exists). */
  readonly tolerate?: ReadonlySet<number>;
}

const call = async ({ method, path, token, json, form, tolerate }: ApiCall): Promise<unknown> => {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method, headers, body });
  } catch (error: unknown) {
    return fail(
      `cannot reach FerrisKey at ${API} — is it running? (\`just ferriskey-up\`). ${String(error)}`,
    );
  }

  const text = await res.text();
  const parsed = text === '' ? undefined : safeJson(text);
  if (!res.ok && !(tolerate?.has(res.status) ?? false)) {
    return fail(`${method} ${path} → ${res.status} ${res.statusText}\n${text}`);
  }
  return parsed;
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const main = async (): Promise<void> => {
  console.log(`→ FerrisKey bootstrap against ${API} (realm: ${REALM}, client: ${CLIENT_ID})`);

  // 1. Admin token (master realm, default console client, direct password grant).
  const tokenRes = asRecord(
    await call({
      method: 'POST',
      path: '/realms/master/protocol/openid-connect/token',
      form: {
        grant_type: 'password',
        client_id: 'security-admin-console',
        username: ADMIN_USER,
        password: ADMIN_PASS,
      },
    }),
  );
  const token = tokenRes.access_token;
  if (typeof token !== 'string') return fail('no access_token in admin token response');
  console.log('✓ admin token acquired');

  // 2. Realm.
  await call({
    method: 'POST',
    path: '/realms',
    token,
    json: { name: REALM },
    tolerate: ALREADY_EXISTS,
  });
  console.log(`✓ realm "${REALM}" ready`);

  // 3. Confidential client — read back its generated secret (or fetch it if the client pre-existed).
  const created = asRecord(
    await call({
      method: 'POST',
      path: `/realms/${REALM}/clients`,
      token,
      json: {
        name: 'Flank Web',
        client_id: CLIENT_ID,
        client_type: 'confidential',
        public_client: false,
        protocol: 'openid-connect',
        enabled: true,
        service_account_enabled: false,
        direct_access_grants_enabled: true,
        oauth_device_code_grant_enabled: false,
      },
      tolerate: ALREADY_EXISTS,
    }),
  );

  let client = asRecord(created.data ?? created);
  if (typeof client.id !== 'string') {
    // Pre-existing client: look it up to recover the UUID + secret.
    const list = asRecord(await call({ method: 'GET', path: `/realms/${REALM}/clients`, token }));
    const items = (
      Array.isArray(list.data) ? list.data : Array.isArray(list) ? list : []
    ) as unknown[];
    const match = items.map(asRecord).find((c) => c.client_id === CLIENT_ID);
    if (match === undefined) return fail(`client "${CLIENT_ID}" not found after create`);
    client = match;
  }
  const clientUuid = client.id;
  const clientSecret = client.secret;
  if (typeof clientUuid !== 'string') return fail('client has no id');
  console.log(`✓ client "${CLIENT_ID}" ready (${clientUuid})`);

  // 4. Redirect + post-logout URIs.
  await call({
    method: 'POST',
    path: `/realms/${REALM}/clients/${clientUuid}/redirects`,
    token,
    json: { value: REDIRECT_URI, enabled: true },
    tolerate: ALREADY_EXISTS,
  });
  await call({
    method: 'POST',
    path: `/realms/${REALM}/clients/${clientUuid}/post-logout-redirects`,
    token,
    json: { value: APP_ORIGIN, enabled: true },
    tolerate: ALREADY_EXISTS,
  });
  console.log(`✓ redirect URIs registered (${REDIRECT_URI})`);

  // 5. Demo user + password (matches `just seed`'s owner email so memberships line up).
  const userRes = asRecord(
    await call({
      method: 'POST',
      path: `/realms/${REALM}/users`,
      token,
      json: {
        username: DEMO_EMAIL,
        email: DEMO_EMAIL,
        firstname: 'Dana',
        lastname: 'Founder',
        email_verified: true,
      },
      tolerate: ALREADY_EXISTS,
    }),
  );
  const user = asRecord(userRes.data ?? userRes);
  const userUuid = user.id;
  if (typeof userUuid === 'string') {
    await call({
      method: 'PUT',
      path: `/realms/${REALM}/users/${userUuid}/reset-password`,
      token,
      json: { temporary: false, credential_type: 'password', value: DEMO_PASSWORD },
    });
    console.log(`✓ demo user ${DEMO_EMAIL} ready (password: ${DEMO_PASSWORD})`);
  } else {
    console.log(`• demo user ${DEMO_EMAIL} already existed — left untouched`);
  }

  console.log('\nDone. Put these in your .env (then run `just dev`):\n');
  console.log(`FERRISKEY_ISSUER=${API}`);
  console.log(`FERRISKEY_REALM=${REALM}`);
  console.log(`FERRISKEY_CLIENT_ID=${CLIENT_ID}`);
  console.log(
    typeof clientSecret === 'string'
      ? `FERRISKEY_CLIENT_SECRET=${clientSecret}`
      : 'FERRISKEY_CLIENT_SECRET=<copy from the FerrisKey console → realm flank → client flank-web → Credentials>',
  );
};

main().catch((error: unknown) => fail(String(error)));
