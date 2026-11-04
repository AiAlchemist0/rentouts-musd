import { describe, expect, it } from 'vitest'
import { LeaseState } from '../abi/rentEscrow'
import { defaultAt, defaultSplit, isDefaultable, nextDueAt, owedAtFunding, type MonthlyLease } from './lease'

const e18 = 10n ** 18n
const musd = (n: number) => BigInt(n) * e18

const START = 1_700_000_000

/** 20 deposit, 10 rent, 120 s periods. Monthly: 1 of 3 periods funded, active, none claimed yet. */
function lease(over: Partial<MonthlyLease & { state: number }> = {}): MonthlyLease & { state: number } {
  return {
    deposit: musd(20),
    rentPerPeriod: musd(10),
    periodSeconds: 120,
    periods: 3,
    periodsClaimed: 0,
    startTime: BigInt(START),
    monthly: true,
    periodsFunded: 1,
    state: LeaseState.ACTIVE,
    ...over,
  }
}

describe('owedAtFunding', () => {
  it('is deposit + all rent for a prepaid lease', () => {
    expect(owedAtFunding({ deposit: musd(20), rentPerPeriod: musd(10), periods: 3, monthly: undefined })).toBe(musd(50))
    expect(owedAtFunding({ deposit: musd(20), rentPerPeriod: musd(10), periods: 3, monthly: false })).toBe(musd(50))
  })

  it('is deposit + one period’s rent for a monthly lease', () => {
    expect(owedAtFunding({ deposit: musd(20), rentPerPeriod: musd(10), periods: 3, monthly: true })).toBe(musd(30))
  })
})

describe('nextDueAt', () => {
  it('is startTime + periodsFunded * periodSeconds for a monthly lease', () => {
    expect(nextDueAt(lease())).toBe(START + 120)
    expect(nextDueAt(lease({ periodsFunded: 3 }))).toBe(START + 360)
    expect(nextDueAt(lease({ periodsFunded: 0, startTime: 0n }))).toBeNull()
  })

  it('falls back to the term length without periodsFunded (a V1 prepaid row)', () => {
    expect(nextDueAt(lease({ monthly: undefined, periodsFunded: undefined }))).toBe(START + 360)
  })
})

describe('defaultAt', () => {
  it('adds one full period of grace to the next due date', () => {
    expect(defaultAt(lease())).toBe(START + 240)
    expect(defaultAt(lease({ periodsFunded: 0, startTime: 0n }))).toBeNull()
  })
})

describe('isDefaultable', () => {
  it('is true once the unfunded period has run one full period past its due date', () => {
    expect(isDefaultable(lease({ state: LeaseState.ACTIVE }), START + 240)).toBe(true)
    expect(isDefaultable(lease({ state: LeaseState.ACTIVE }), START + 239)).toBe(false)
  })

  it('is false for a fully funded, prepaid, or inactive lease', () => {
    expect(isDefaultable(lease({ state: LeaseState.ACTIVE, periodsFunded: 3 }), START + 999)).toBe(false)
    expect(isDefaultable(lease({ state: LeaseState.ACTIVE, monthly: undefined, periodsFunded: undefined }), START + 999)).toBe(false)
    expect(isDefaultable(lease({ state: LeaseState.DISPUTED }), START + 999)).toBe(false)
    expect(isDefaultable(lease({ state: LeaseState.CREATED, startTime: 0n, periodsFunded: 0 }), START + 999)).toBe(false)
  })
})

describe('defaultSplit', () => {
  it('gives the landlord the funded unclaimed rent plus one period out of the deposit', () => {
    // 1 of 3 funded, none claimed: 10 rent + 10 forfeit to the landlord, 10 of the deposit back
    expect(defaultSplit(lease())).toEqual({
      rentToLandlord: musd(10),
      depositForfeit: musd(10),
      toLandlord: musd(20),
      toTenant: musd(10),
    })
  })

  it('subtracts periods already released before the default', () => {
    expect(defaultSplit(lease({ periodsClaimed: 1 }))).toEqual({
      rentToLandlord: musd(0),
      depositForfeit: musd(10),
      toLandlord: musd(10),
      toTenant: musd(10),
    })
  })

  it('caps the forfeit at the deposit', () => {
    expect(defaultSplit(lease({ deposit: musd(8), rentPerPeriod: musd(30) }))).toEqual({
      rentToLandlord: musd(30),
      depositForfeit: musd(8),
      toLandlord: musd(38),
      toTenant: musd(0),
    })
  })

  it('for a prepaid lease the split is zero (it can never default)', () => {
    expect(defaultSplit(lease({ monthly: undefined, periodsFunded: undefined }))).toEqual({
      rentToLandlord: musd(30),
      depositForfeit: musd(10),
      toLandlord: musd(40),
      toTenant: musd(10),
    })
  })
})
