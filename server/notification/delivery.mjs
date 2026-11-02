// Notification's client-edge delivery decision port. The trust matrix remains
// client-side and receiver-specific; this module is the Notification-facing
// adapter that applies it to raw server pages. It returns classified rows only
// to the caller and never writes held bodies to notification sinks.

import { applyTrustMatrix, loadAllowlist } from '../client/trust.mjs'

export function createDeliveryClassifier({ pluginDataDir, realmId, ownFingerprint, transport } = {}) {
  return Object.freeze({
    classify(messages) {
      return applyTrustMatrix({ messages }, {
        ownFingerprint,
        transport,
        allowlist: loadAllowlist(pluginDataDir, realmId),
      }).messages
    },
    classifyRow(row) {
      return this.classify([row])[0]
    },
  })
}
