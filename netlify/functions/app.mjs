import { createAppServer } from '../../server.js';
import { handleWithNodeServer } from '../../netlify-adapter.mjs';

// One instance per warm function container keeps the shared Postgres pool reused across requests.
const server = createAppServer();

export default request => handleWithNodeServer(server, request);

// Claim every path so static pages also get the security headers and canonical-host redirect.
export const config = { path: ['/', '/*'] };
