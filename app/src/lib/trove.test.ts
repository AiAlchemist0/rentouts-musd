import { describe, expect, it } from 'vitest'
import {
  bestRatioFor,
  borrowHeadroom,
  btcFor,
  collateralFor,
  collateralRatio,
  collToReach,
  compositeDebt,
  headroom,
  liquidationPrice,
  maxNewBorrow,
  ONE,
  percentRatio,
  ratioPercent,
  riskLevel,
  withdrawableColl,
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

describe('managing an open trove', () => {
  // 0.1 BTC at $80,000 carries 8,000 USD; 2,500 MUSD owed -> 320%.
  const coll = ONE / 10n
  const debt = musd(2500)
  const capacity = musd(7272) // coll * price / 110%, what Mezo records at open

  it('borrows up to the tighter of the ratio room and the capacity cap', () => {
    // Ratio binds: 8,000/2 - 2,500 = 1,500 at 200%; capacity allows 4,772 more.
    expect(borrowHeadroom(coll, debt, price, percentRatio(200), capacity)).toBe(musd(1500))
    // Capacity binds: asking for 150% leaves ratio room of 2,833, but the cap allows only 472.
    expect(borrowHeadroom(coll, debt, price, percentRatio(150), musd(2972))).toBe(musd(472))
  })

  it('never reports negative borrowing headroom', () => {
    expect(borrowHeadroom(coll, musd(9000), price, percentRatio(200), capacity)).toBe(0n)
    expect(borrowHeadroom(coll, debt, price, percentRatio(200), musd(1000))).toBe(0n)
    expect(borrowHeadroom(coll, debt, price, percentRatio(200), 0n)).toBe(0n)
  })

  it('computes the BTC to add to reach a ratio, rounded up', () => {
    // 2,500 MUSD at 200% needs 0.0625 BTC; 0.05 locked -> 0.0125 to add.
    expect(collToReach(ONE / 20n, debt, price, percentRatio(200))).toBe(12_500_000_000_000_000n)
    expect(collateralRatio(ONE / 20n + 12_500_000_000_000_000n, debt, price) >= percentRatio(200)).toBe(true)
  })

  it('asks for no collateral when the trove already sits above the ratio', () => {
    expect(collToReach(coll, debt, price, percentRatio(200))).toBe(0n)
    expect(collToReach(coll, debt, price, percentRatio(300))).toBe(0n)
  })

  it('caps withdrawals at the ratio the trove must keep', () => {
    // 0.1 BTC at 200% keeps 0.0625 BTC locked; 0.0375 can come out. At 150% only 0.046875 must stay.
    expect(withdrawableColl(coll, debt, price, percentRatio(200))).toBe(37_500_000_000_000_000n)
    expect(withdrawableColl(coll, debt, price, percentRatio(150))).toBe(53_125_000_000_000_000n)
    expect(collateralRatio(coll - 53_125_000_000_000_000n, debt, price) >= percentRatio(150)).toBe(true)
  })

  it('allows no withdrawal when the trove is already under the floor', () => {
    expect(withdrawableColl(coll, musd(6000), price, percentRatio(150))).toBe(0n)
    expect(withdrawableColl(0n, debt, price, percentRatio(150))).toBe(0n)
  })

  it('sorts risk: safe from 200%, watch from 150%, danger below', () => {
    expect(riskLevel(percentRatio(200), percentRatio(150), false)).toBe('safe')
    expect(riskLevel(percentRatio(250), percentRatio(150), true)).toBe('safe')
    expect(riskLevel(percentRatio(199), percentRatio(150), false)).toBe('watch')
    expect(riskLevel(percentRatio(150), percentRatio(150), false)).toBe('watch')
    expect(riskLevel(percentRatio(149), percentRatio(150), false)).toBe('danger')
    expect(riskLevel(percentRatio(120), percentRatio(150), false)).toBe('danger')
  })

  it('calls a trove under the critical ratio danger while the system is in Recovery Mode', () => {
    // Normal mode: 155% is only watch. Recovery Mode with CCR at 160%: liquidations reach 160%, so danger.
    expect(riskLevel(percentRatio(155), percentRatio(150), false)).toBe('watch')
    expect(riskLevel(percentRatio(155), percentRatio(160), true)).toBe('danger')
    expect(riskLevel(percentRatio(165), percentRatio(160), true)).toBe('watch')
  })
})
