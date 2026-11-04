import type { MezoProtocol, Trove } from '../hooks'
import { ONE } from './trove'

/**
 * Dev-only sample data for `?mockTrove=1`: lets the "Your trove" panel render with no wallet and no RPC.
 * TrovePanel only references these constants inside a module-level `if (import.meta.env.DEV …)`, and every
 * initializer here is a plain literal, so production builds fold the branch away and drop this whole file
 * from the bundle — the panel there only ever shows on-chain state.
 */

/** Mezo testnet values as of Oct 2026: MCR 110%, CCR 150%, 0.1% borrowing fee, 200 MUSD gas reserve. */
export const MOCK_PROTOCOL: MezoProtocol = {
  price: 80_000n * ONE,
  mcr: 1_100_000_000_000_000_000n, // 110%
  ccr: 1_500_000_000_000_000_000n, // 150%
  minNetDebt: 1_800n * ONE,
  gasCompensation: 200n * ONE,
  borrowingRate: 1_000_000_000_000_000n, // 0.1%
}

/**
 * A 0.09 BTC trove owing 4,000 MUSD (180%) while the whole system is in Recovery Mode (TCR 142%): one
 * picture that exercises the risk colour, the banner, and the disabled withdraw/close states.
 */
export const MOCK_TROVE: Trove = {
  status: 1, // active
  coll: 90_000_000_000_000_000n, // 0.09 BTC
  debt: 4_000n * ONE,
  icr: 1_800_000_000_000_000_000n, // 180%: 0.09 BTC * $80,000 / 4,000 MUSD
  price: 80_000n * ONE,
  tcr: 1_420_000_000_000_000_000n, // 142%
  recoveryMode: true,
  // What Mezo records at open: coll * price / 110% ≈ 6,545.45 MUSD of total debt.
  maxBorrowingCapacity: 6_545_454_545_454_545_454_545n,
}

/** MUSD in the connected wallet for the mock: enough to close the sample trove (debt − 200 reserve). */
export const MOCK_MUSD_BALANCE = 4_000n * ONE

/** BTC in the wallet for the mock: what Mezo's faucet sends. */
export const MOCK_BTC_BALANCE = 50_000_000_000_000_000n
