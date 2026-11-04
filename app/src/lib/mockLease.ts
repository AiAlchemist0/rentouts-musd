import type { TerminationRow } from '../abi/rentEscrowV2'
import { LeaseState } from '../abi/rentEscrow'
import type { LeaseRow, MezoProtocol, Trove } from '../hooks'
import type { Address } from 'viem'
import { MOCK_BTC_BALANCE, MOCK_MUSD_BALANCE, MOCK_PROTOCOL } from './mockTrove'

/**
 * Dev-only sample data for `?mockLease=<mode>` (usually together with `?mockTrove=1`): lets the fund and
 * lease screens render their Wave-2 states — borrow-and-pay quotes, pay-monthly leases, an open
 * early-end offer, a timed-out dispute — with no wallet and no RPC. `1` is the tenant screen;
 * `landlord-ontime`, `landlord-grace` and `landlord-due` stage the landlord's view of the monthly
 * payment clock, `notrove` drops the tenant's trove. Panels reference these constants only inside
 * module-level `if (import.meta.env.DEV …)` blocks, so production builds fold the branches away and
 * drop this file from the bundle.
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

/** A pay-monthly lease waiting to be funded: the tenant starts with the deposit + the first period (120 MUSD). */
export const MOCK_MONTHLY_WAITING_LEASE: LeaseRow = {
  ...MOCK_WAITING_LEASE,
  id: 6n,
  deposit: 90n * e18,
  rentPerPeriod: 30n * e18,
  monthly: true,
  periodsFunded: 0,
}

const nowSec = () => Math.floor(Date.now() / 1000)

/** An active prepaid lease two periods in: 20 deposit + 6 × 10 rent, one period a minute. */
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

/** A pay-monthly lease `startAgo` seconds old: 1 of 3 periods funded, none released yet. */
function monthlyLease(startAgo: number): LeaseRow {
  return {
    id: 5n,
    landlord: MOCK_LANDLORD,
    tenant: MOCK_VIEWER,
    deposit: 20n * e18,
    rentPerPeriod: 10n * e18,
    periodSeconds: 120,
    periods: 3,
    periodsClaimed: 0,
    periodsFunded: 1,
    monthly: true,
    startTime: BigInt(nowSec() - startAgo), // period 2 due at start+120, default at start+240
    state: LeaseState.ACTIVE,
    claimablePeriods: 1, // elapsed is capped at periodsFunded
    claimableAmount: 10n * e18,
    escrowBalance: 30n * e18, // deposit + the one funded period
  }
}

/** An active pay-monthly lease 1 of 3 periods funded, overdue past its grace: defaultable now. */
const MOCK_MONTHLY_LEASE = monthlyLease(400)

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
const MOCK_NO_TROVE: Trove = {
  status: 0,
  coll: 0n,
  debt: 0n,
  icr: 0n,
  price: MOCK_PROTOCOL.price,
  tcr: 1_800_000_000_000_000_000n,
  recoveryMode: false,
  maxBorrowingCapacity: 0n,
}

/** An active, healthy trove with room to mint the monthly lease's next payment from. */
const MOCK_PAY_TROVE: Trove = {
  status: 1,
  coll: 90_000_000_000_000_000n, // 0.09 BTC = $7,200 at the mock price
  debt: 2_000n * e18, // 160% would carry 4,500; owing 2,000 leaves ~2,500 of headroom
  icr: 3_600_000_000_000_000_000n, // 360%
  price: MOCK_PROTOCOL.price,
  tcr: 1_800_000_000_000_000_000n,
  recoveryMode: false,
  // What Mezo records at open: coll * price / 110% ≈ 6,545.45 MUSD of total debt.
  maxBorrowingCapacity: 6_545_454_545_454_545_454_545n,
}

/** Everything the mock fund screen substitutes for chain reads. */
export const MOCK_FUND_SCREEN: {
  waiting: LeaseRow[]
  protocol: MezoProtocol
  trove: Trove
  btc: bigint
  musd: bigint
} = {
  waiting: [MOCK_WAITING_LEASE, MOCK_MONTHLY_WAITING_LEASE],
  protocol: MOCK_PROTOCOL,
  trove: MOCK_NO_TROVE,
  btc: MOCK_BTC_BALANCE,
  musd: MOCK_MUSD_BALANCE,
}

/** One mock lease screen: the lease rows plus everything the wallet, trove and protocol reads would return. */
export type MockLeaseScreen = {
  /** The wallet the screen is seen through (the demo tenant, or the mock landlord for the landlord views). */
  viewer: Address
  protocol: MezoProtocol
  trove: Trove
  musd: bigint
  allowance: bigint
  leases: LeaseRow[]
  terminations: TerminationRow[]
  disputeOpenedAt: bigint[]
}

const ZERO_TERMINATION: TerminationRow = {
  proposer: '0x0000000000000000000000000000000000000000',
  penaltyToLandlord: 0n,
  expiry: 0n,
}

/** The tenant screen: the sample leases seen through the demo tenant's wallet. */
const TENANT_SCREEN: MockLeaseScreen = {
  viewer: MOCK_VIEWER,
  protocol: MOCK_PROTOCOL,
  trove: MOCK_PAY_TROVE,
  musd: MOCK_MUSD_BALANCE,
  allowance: 0n,
  leases: [MOCK_ACTIVE_LEASE, MOCK_MONTHLY_LEASE, MOCK_DISPUTED_LEASE],
  terminations: [MOCK_TERMINATION, ZERO_TERMINATION, ZERO_TERMINATION],
  disputeOpenedAt: [0n, 0n, MOCK_DISPUTE_OPENED_AT],
}

/** The landlord's view of the monthly lease, `startAgo` seconds into its clock (60 on time, 200 inside the grace). */
const landlordScreen = (startAgo: number): MockLeaseScreen => ({
  viewer: MOCK_LANDLORD,
  protocol: MOCK_PROTOCOL,
  trove: MOCK_PAY_TROVE,
  musd: MOCK_MUSD_BALANCE,
  allowance: 0n,
  leases: [monthlyLease(startAgo)],
  terminations: [ZERO_TERMINATION],
  disputeOpenedAt: [0n],
})

/** The screen for a `?mockLease=` value (dev only); anything unknown falls back to the tenant screen. */
export function mockLeaseScreenFor(param: string): MockLeaseScreen {
  switch (param) {
    case 'landlord-ontime':
      return landlordScreen(60)
    case 'landlord-grace':
      return landlordScreen(200)
    case 'landlord-due':
      return landlordScreen(400)
    case 'notrove':
      return { ...TENANT_SCREEN, trove: MOCK_NO_TROVE }
    default:
      return TENANT_SCREEN
  }
}

/** Everything the mock lease screen substitutes for chain reads (?mockLease=1, the tenant view). */
export const MOCK_LEASE_SCREEN: MockLeaseScreen = TENANT_SCREEN
