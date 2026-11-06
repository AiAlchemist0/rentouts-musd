/**
 * Mezo Borrow math for the "borrow MUSD against BTC" step. Every value is an 18-decimal fixed-point
 * bigint, the same units the protocol uses: BTC and MUSD amounts in wei, the price in USD per BTC
 * scaled by 1e18, and ratios scaled by 1e18 (1.5e18 = 150%).
 */

import { isAddressEqual, type Address } from 'viem'
import type { MezoProtocol, Trove } from '../hooks'

export const ONE = 10n ** 18n

/** Debt a new trove records: what you borrow + the one-time borrowing fee + the refundable gas reserve. */
export function compositeDebt(borrow: bigint, fee: bigint, gasCompensation: bigint): bigint {
  return borrow + fee + gasCompensation
}

/** Collateral ratio of `coll` BTC against `debt` MUSD at `price`. Max uint for zero debt. */
export function collateralRatio(coll: bigint, debt: bigint, price: bigint): bigint {
  if (debt === 0n) return 2n ** 256n - 1n
  return (coll * price) / debt
}

/** BTC needed to hold `debt` at `ratio`, rounded up so the trove never lands just under it. */
export function collateralFor(debt: bigint, ratio: bigint, price: bigint): bigint {
  if (price === 0n) return 0n
  const numerator = debt * ratio
  return (numerator + price - 1n) / price
}

/** BTC price at which the trove reaches the minimum ratio (`mcr`) and can be liquidated. */
export function liquidationPrice(coll: bigint, debt: bigint, mcr: bigint): bigint {
  if (coll === 0n) return 0n
  return (debt * mcr) / coll
}

/** Extra MUSD a trove can borrow and still sit at `targetRatio`, before the fee. Never negative. */
export function headroom(coll: bigint, debt: bigint, price: bigint, targetRatio: bigint): bigint {
  if (targetRatio === 0n) return 0n
  const maxDebt = (coll * price) / targetRatio
  return maxDebt > debt ? maxDebt - debt : 0n
}

/** MUSD -> BTC at `price` (MUSD is pegged to 1 USD). */
export function btcFor(musd: bigint, price: bigint): bigint {
  if (price === 0n) return 0n
  return (musd * ONE) / price
}

/** Ratio as a whole percent, for display: 1.6e18 -> 160. */
export function ratioPercent(ratio: bigint): number {
  return Number((ratio * 100n) / ONE)
}

/** Whole percent -> ratio: 160 -> 1.6e18. */
export function percentRatio(percent: number): bigint {
  return (BigInt(Math.round(percent * 100)) * ONE) / 10_000n
}

/** Trove status codes from TroveManager.getTroveStatus. */
export const TroveStatus = {
  nonExistent: 0,
  active: 1,
  closedByOwner: 2,
  closedByLiquidation: 3,
  closedByRedemption: 4,
} as const

/**
 * Most MUSD a new trove can borrow with `coll` BTC at `ratio`, after the one-time fee and the gas reserve:
 * coll * price / ratio = borrow * (1 + rate) + gasCompensation. Zero when the BTC can't cover the reserve.
 */
export function maxNewBorrow(coll: bigint, price: bigint, ratio: bigint, borrowingRate: bigint, gasCompensation: bigint): bigint {
  if (ratio === 0n) return 0n
  const maxDebt = (coll * price) / ratio
  if (maxDebt <= gasCompensation) return 0n
  return ((maxDebt - gasCompensation) * ONE) / (ONE + borrowingRate)
}

/** The safest of `percents` (highest first) at which `coll` BTC can carry `borrow` MUSD, or undefined. */
export function bestRatioFor(
  borrow: bigint,
  coll: bigint,
  price: bigint,
  borrowingRate: bigint,
  gasCompensation: bigint,
  percents: readonly number[],
): number | undefined {
  const debt = compositeDebt(borrow, (borrow * borrowingRate) / ONE, gasCompensation)
  return [...percents].sort((a, b) => b - a).find((p) => collateralFor(debt, percentRatio(p), price) <= coll)
}

/**
 * MUSD an existing trove can still borrow (before the fee) and stay at `targetRatio` AND inside Mezo's
 * `maxBorrowingCapacity` — the contract refuses any debt increase past that cap. Never negative.
 */
export function borrowHeadroom(coll: bigint, debt: bigint, price: bigint, targetRatio: bigint, maxBorrowingCapacity: bigint): bigint {
  const byRatio = headroom(coll, debt, price, targetRatio)
  const byCapacity = maxBorrowingCapacity > debt ? maxBorrowingCapacity - debt : 0n
  return byRatio < byCapacity ? byRatio : byCapacity
}

/** BTC to add so `coll` carries `debt` at `targetRatio`: 0 when it already sits above, rounded up. */
export function collToReach(coll: bigint, debt: bigint, price: bigint, targetRatio: bigint): bigint {
  const need = collateralFor(debt, targetRatio, price)
  return need > coll ? need - coll : 0n
}

/** The collateral ratio a trove keeps when it mints more MUSD for a rent payment (FundPanel and the pay-monthly card agree on it). */
export const WITHDRAW_TARGET = 160

export type WithdrawQuote = {
  /** Most MUSD the trove can mint before the fee (0 in Recovery Mode). */
  maxMint: bigint
  /** The one-time borrowing fee on `amount`. */
  fee: bigint
  /** The trove's debt once `amount` and its fee are added. */
  newDebt: bigint
  /** The collateral ratio at that debt. */
  newRatio: bigint
  fits: boolean
  /** Recovery Mode or not enough headroom: no mint. */
  blocked: boolean
}

/**
 * What minting `amount` more MUSD against an existing trove does, and whether Mezo lets it: the trove
 * keeps `WITHDRAW_TARGET`% and stays inside its recorded borrowing cap; in Recovery Mode nothing mints.
 */
export function withdrawQuote(
  trove: Pick<Trove, 'coll' | 'debt' | 'price' | 'recoveryMode' | 'maxBorrowingCapacity'>,
  protocol: Pick<MezoProtocol, 'price' | 'borrowingRate'>,
  amount: bigint,
): WithdrawQuote {
  const room = trove.recoveryMode
    ? 0n
    : borrowHeadroom(trove.coll, trove.debt, protocol.price, percentRatio(WITHDRAW_TARGET), trove.maxBorrowingCapacity)
  const maxMint = (room * ONE) / (ONE + protocol.borrowingRate)
  const fee = (amount * protocol.borrowingRate) / ONE
  const newDebt = trove.debt + amount + fee
  const newRatio = collateralRatio(trove.coll, newDebt, protocol.price)
  const fits = amount <= maxMint
  return { maxMint, fee, newDebt, newRatio, fits, blocked: trove.recoveryMode || !fits }
}

/** Most BTC a trove can withdraw and still sit at `minRatio`. Never negative. */
export function withdrawableColl(coll: bigint, debt: bigint, price: bigint, minRatio: bigint): bigint {
  const keep = collateralFor(debt, minRatio, price)
  return coll > keep ? coll - keep : 0n
}

export type RiskLevel = 'safe' | 'watch' | 'danger'

/**
 * How close the trove is to its liquidation line, for the ratio's colour and wording. Thresholds, all
 * computed from ICR = coll × price / debt:
 * - safe:   200% or more. The BTC price must halve (roughly) before the trove is at risk.
 * - watch:  150% up to 200%. Fine today; a BTC price drop eats the margin.
 * - danger: under 150% — and, in Recovery Mode, under the critical ratio CCR (150% today), where troves
 *   can be liquidated while the system heals. Under 120% is always danger: it is 10% above the 110%
 *   liquidation line, one bad price feed away.
 */
export function riskLevel(icr: bigint, ccr: bigint, recoveryMode: boolean): RiskLevel {
  if (icr >= percentRatio(200)) return 'safe'
  const line = recoveryMode && ccr > percentRatio(150) ? ccr : percentRatio(150)
  return icr >= line ? 'watch' : 'danger'
}

/** One trove as the redemption queue sees it: the sorted-list order (`nicr`) plus what a redemption checks. */
export type QueueTrove = {
  owner: Address
  /** Nominal ratio (coll / principal), the order Mezo's sorted list keeps. */
  nicr: bigint
  /** Current ratio at the redemption's price; under `mcr` a redemption skips the trove. */
  icr: bigint
  /** MUSD owed, principal + interest including pending. */
  debt: bigint
}

export type RedemptionQueue = {
  /** 1-based position from the front of the queue: 1 is redeemed first. */
  rank: number
  /** Troves a redemption can reach at all (current ratio at or above MCR). */
  total: number
  /** MUSD owed by the troves ahead of this one: about what must be redeemed before it is touched. */
  debtAhead: bigint
}

/**
 * Where `account`'s trove sits in Mezo's redemption queue. Redemptions start from the trove with the
 * lowest nominal ratio and walk upward, skipping any trove whose current ratio is under MCR (its risk is
 * liquidation, not redemption). Troves tied on nominal ratio count as behind the account, so a redemption
 * reaching that ratio has reached the account too. Undefined when the account isn't in the queue at all:
 * no such trove, or its own ratio is under MCR.
 */
export function redemptionQueue(account: Address, troves: readonly QueueTrove[], mcr: bigint): RedemptionQueue | undefined {
  const own = troves.find((t) => isAddressEqual(t.owner, account))
  if (!own || own.icr < mcr) return undefined
  const reachable = troves.filter((t) => t.icr >= mcr)
  const ahead = reachable.filter((t) => t.nicr < own.nicr)
  return {
    rank: ahead.length + 1,
    total: reachable.length,
    debtAhead: ahead.reduce((sum, t) => sum + t.debt, 0n),
  }
}
