// Compatibility adapter: session identity/token lifecycle is owned by Identity.
export { bearerTokenFromHeaders, createSessionRegistry, createSessionVerifier, sessionKeyFromToken } from '../identity/sessions.mjs'
