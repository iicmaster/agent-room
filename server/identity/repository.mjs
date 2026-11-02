// Identity context repository composition. This facade receives the active
// DatabaseSync + transaction runner from the storage composition root; it
// never opens/closes the file or owns schema/migration lifecycle.
//
// Enrollment is intentionally composed with ban admission and invite
// consumption in one transaction (the ban check occurs after possession
// proof and before invite use is consumed).

import { createIdentityClaimOperations } from './claims.mjs'
import { createBanOperations } from '../store/bans.mjs'
import { createInviteOperations } from '../store/invites.mjs'

export function createIdentityRepository({ database, withImmediateTransaction, validate }) {
  const bans = createBanOperations({ database, withImmediateTransaction })
  const invites = createInviteOperations({
    database,
    withImmediateTransaction,
    isBanned: fingerprint => bans.isActorBanned(fingerprint),
  })
  const claims = createIdentityClaimOperations({ database, withImmediateTransaction, validate })

  return Object.freeze({
    ...claims,
    ...bans,
    ...invites,
  })
}
