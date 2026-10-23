/**
 * Mezo Borrow math for the "borrow MUSD against BTC" step. Every value is an 18-decimal fixed-point
 * bigint, the same units the protocol uses: BTC and MUSD amounts in wei, the price in USD per BTC
 * scaled by 1e18, and ratios scaled by 1e18 (1.5e18 = 150%).
 */

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
