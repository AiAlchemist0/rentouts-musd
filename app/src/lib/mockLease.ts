import type { TerminationRow } from '../abi/rentEscrowV2'
import { LeaseState } from '../abi/rentEscrow'
import type { LeaseRow, MezoProtocol, Trove } from '../hooks'
import type { Address } from 'viem'
import { MOCK_BTC_BALANCE, MOCK_MUSD_BALANCE, MOCK_PROTOCOL } from './mockTrove'

/**
 * Dev-only sample data for `?mockLease=1` (usually together with `?mockTrove=1`): lets the fund and
 * lease screens render their Wave-2 states — borrow-and-pay quotes, an open early-end offer, a timed-out
 * dispute — with no wallet and no RPC. Panels reference these constants only inside module-level
 * `if (import.meta.env.DEV …)` blocks, so production builds fold the branches away and drop this file
 * from the bundle.
 */

/** The wallet the mock screens are seen through (the demo tenant). */
export const MOCK_VIEWER = '0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1' as Address

/** The lease's landlord in the mock screens (the Mezo deployer). */
export const MOCK_LANDLORD = '0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6' as Address

const e18 = 10n ** 18n

/** A lease waiting for the tenant (the viewer) to pay: 100 deposit + 3 × 50 rent = 250 MUSD. */
export const MOCK_WAITING_LEASE: LeaseRow = {
  id: 3n,
  landlord: MOCK_LANDLORD,
  tenant: MOCK_VIEWER,
  deposit: 100n * e18,
  rentPerPeriod: 50n * e18,
  periodSeconds: 120,
  periods: 3,
  periodsClaimed: 0,
  startTime: 0n,
  state: LeaseState.CREATED,
  claimablePeriods: 0,
  claimableAmount: 0n,
  escrowBalance: 0n,
}

const nowSec = () => Math.floor(Date.now() / 1000)

/** An active lease two periods in: 20 deposit + 6 × 10 rent, one period a minute. */
export const MOCK_ACTIVE_LEASE: LeaseRow = {
  id: 2n,
  landlord: MOCK_LANDLORD,
  tenant: MOCK_VIEWER,
  deposit: 20n * e18,
  rentPerPeriod: 10n * e18,
  periodSeconds: 60,
  periods: 6,
  periodsClaimed: 0,
  startTime: BigInt(nowSec() - 130),
  state: LeaseState.ACTIVE,
  claimablePeriods: 2,
  claimableAmount: 20n * e18,
  escrowBalance: 80n * e18,
}

/** An early-end offer from the landlord on MOCK_ACTIVE_LEASE: 5 MUSD penalty, open for three days. */
export const MOCK_TERMINATION: TerminationRow = {
  proposer: MOCK_LANDLORD,
  penaltyToLandlord: 5n * e18,
  expiry: BigInt(nowSec() + 3 * 24 * 3600),
}

/** A dispute opened past the (600 s) timeout on a third lease: settle-by-timeout is live. */
export const MOCK_DISPUTED_LEASE: LeaseRow = {
  id: 4n,
  landlord: MOCK_LANDLORD,
  tenant: MOCK_VIEWER,
  deposit: 20n * e18,
  rentPerPeriod: 10n * e18,
  periodSeconds: 60,
  periods: 6,
  periodsClaimed: 0,
  startTime: BigInt(nowSec() - 700 - 60),
  state: LeaseState.DISPUTED,
  claimablePeriods: 0,
  claimableAmount: 0n,
  escrowBalance: 80n * e18,
}

/** When the mock dispute was opened: past the timeout, so resolveByTimeout is available. */
export const MOCK_DISPUTE_OPENED_AT = BigInt(nowSec() - 700)

/** A trove that doesn't exist yet, so the fund screen shows the open-a-trove quote. */
export const MOCK_NO_TROVE: Trove = {
  status: 0,
  coll: 0n,
  debt: 0n,
  icr: 0n,
  price: MOCK_PROTOCOL.price,
  tcr: 1_800_000_000_000_000_000n,
  recoveryMode: false,
  maxBorrowingCapacity: 0n,
}

/** Everything the mock fund screen substitutes for chain reads. */
export const MOCK_FUND_SCREEN: {
  waiting: LeaseRow[]
  protocol: MezoProtocol
  trove: Trove
  btc: bigint
  musd: bigint
} = {
  waiting: [MOCK_WAITING_LEASE],
  protocol: MOCK_PROTOCOL,
  trove: MOCK_NO_TROVE,
  btc: MOCK_BTC_BALANCE,
  musd: MOCK_MUSD_BALANCE,
}

/** Everything the mock lease screen substitutes for chain reads. */
export const MOCK_LEASE_SCREEN: {
  leases: LeaseRow[]
  terminations: TerminationRow[]
  disputeOpenedAt: bigint[]
} = {
  leases: [MOCK_ACTIVE_LEASE, MOCK_DISPUTED_LEASE],
  terminations: [MOCK_TERMINATION, { proposer: '0x0000000000000000000000000000000000000000', penaltyToLandlord: 0n, expiry: 0n }],
  disputeOpenedAt: [0n, MOCK_DISPUTE_OPENED_AT],
}
