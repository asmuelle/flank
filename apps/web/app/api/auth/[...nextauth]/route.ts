// FerrisKey OIDC handshake endpoints (authorize, callback, token, signout) handled by Auth.js.
// Runs on the Node runtime (default) — the jwt callback touches the Postgres-backed store.
import { handlers } from '../../../../auth';

export const { GET, POST } = handlers;
