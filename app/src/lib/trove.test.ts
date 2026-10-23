import { describe, expect, it } from 'vitest'
import {
  bestRatioFor,
  btcFor,
  collateralFor,
  collateralRatio,
  compositeDebt,
  headroom,
  liquidationPrice,
  maxNewBorrow,
  ONE,
  percentRatio,
  ratioPercent,
} from './trove'

const price = 80_000n * ONE // $80,000 per BTC
const musd = (n: number) => BigInt(n) * ONE

describe('trove math', () => {
  it('adds the fee and the gas reserve to the debt', () => {
    // 2,000 MUSD at 0.1% fee + 200 MUSD gas compensation (Mezo testnet values, Oct 2026)
    expect(compositeDebt(musd(2000), musd(2), musd(200))).toBe(musd(2202))
  })

  it('computes collateral for a target ratio and rounds up', () => {
    const coll = collateralFor(musd(2202), percentRatio(200), price)
    // 2202 * 2 / 80000 = 0.05505 BTC
    expect(coll).toBe(55_050_000_000_000_000n)
    expect(collateralRatio(coll, musd(2202), price) >= percentRatio(200)).toBe(true)
  })

  it('never lands under the target ratio because of rounding', () => {
    const odd = 81_644_123_456_789_000_001n
    const coll = collateralFor(musd(1999), percentRatio(160), odd)
    expect(collateralRatio(coll, musd(1999), odd) >= percentRatio(160)).toBe(true)
  })

  it('finds the liquidation price at the minimum ratio', () => {
    // 0.05505 BTC against 2202 MUSD hits 110% at 2202 * 1.1 / 0.05505 = $44,000
    expect(liquidationPrice(55_050_000_000_000_000n, musd(2202), percentRatio(110))).toBe(musd(44_000))
  })

  it('reports headroom to a target ratio and never goes negative', () => {
    // 0.1 BTC * 80k = 8,000 USD; at 200% that carries 4,000 MUSD; 2,500 already owed -> 1,500 more
    expect(headroom(ONE / 10n, musd(2500), price, percentRatio(200))).toBe(musd(1500))
    expect(headroom(ONE / 10n, musd(5000), price, percentRatio(200))).toBe(0n)
  })

  it('converts MUSD to BTC at the price', () => {
    expect(btcFor(musd(800), price)).toBe(10_000_000_000_000_000n) // 0.01 BTC
  })

  it('treats zero debt and zero price safely', () => {
    expect(collateralRatio(ONE, 0n, price) > percentRatio(1_000_000)).toBe(true)
    expect(collateralFor(musd(1), percentRatio(150), 0n)).toBe(0n)
    expect(btcFor(musd(1), 0n)).toBe(0n)
    expect(liquidationPrice(0n, musd(1), percentRatio(110))).toBe(0n)
  })

  it('round-trips percentages', () => {
    expect(ratioPercent(percentRatio(160))).toBe(160)
    expect(percentRatio(110)).toBe(1_100_000_000_000_000_000n)
  })
})

describe('fitting a new trove to the wallet', () => {
  const rate = ONE / 1000n // 0.1%
  const gas = musd(200)
  const faucet = 50_000_000_000_000_000n // 0.05 BTC, what Mezo's faucet sends

  it('finds the most a wallet can borrow at a ratio', () => {
    // 0.05 BTC * 80k = 4,000 USD; at 200% that carries 2,000 debt; minus 200 reserve = 1,800 / 1.001
    const max = maxNewBorrow(faucet, price, percentRatio(200), rate, gas)
    expect(max).toBe((musd(1800) * ONE) / (ONE + rate))
    const debt = compositeDebt(max, (max * rate) / ONE, gas)
    expect(collateralFor(debt, percentRatio(200), price) <= faucet).toBe(true)
  })

  it('returns zero when the BTC cannot cover the gas reserve', () => {
    expect(maxNewBorrow(1_000_000_000_000_000n, price, percentRatio(200), rate, gas)).toBe(0n)
  })

  it('picks the safest ratio the faucet amount allows for the 1,800 MUSD minimum', () => {
    expect(bestRatioFor(musd(1800), faucet, price, rate, gas, [160, 200, 250])).toBe(160)
    expect(bestRatioFor(musd(1800), ONE, price, rate, gas, [160, 200, 250])).toBe(250)
    expect(bestRatioFor(musd(1800), ONE / 100n, price, rate, gas, [160, 200, 250])).toBeUndefined()
  })
})
