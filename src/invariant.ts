/**
 * Package-owned invariant companion for `@lemcae/dsh-balance`.
 * @module @lemcae/dsh-balance/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@lemcae/dsh-balance'

/** Cordis companion plugin name. */
export const name = 'dsh-balance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no independent lifecycle event stream — balance
 * and consumption relations live in the session event log owned by `sessionPersistence`,
 * and its settings, command, and tool registrations are owned by their registries.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
