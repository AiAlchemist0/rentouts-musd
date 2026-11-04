import { describe, expect, it } from 'vitest'
import { concat, encodeAbiParameters, keccak256, pad, toHex, type Address } from 'viem'
import { isOpenOffer, terminationSplit, terminationTermsHash, tenantSide, timeoutSplit, type SettlementLease } from './termination'

const e18 = 10n ** 18n
const musd = (n: number) => BigInt(n) * e18

const START = 1_700_000_000

/** 20 deposit, 6 periods of 10 rent, one period per hour. */
function lease(over: Partial<SettlementLease> = {}): SettlementLease {
  return {
    id: 7n,
    deposit: musd(20),
    rentPerPeriod: musd(10),
    periodSeconds: 3600,
    periods: 6,
    periodsClaimed: 0,
    startTime: BigInt(START),
    claimablePeriods: 0,
    claimableAmount: 0n,
    escrowBalance: musd(80), // 20 deposit + 60 rent
    ...over,
  }
}

describe('terminationTermsHash', () => {
  it('is keccak256(abi.encode(leaseId, proposer, penalty, expiry)), built word-wise like Solidity', () => {
    const proposer = '0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1' as Address
    const penalty = musd(5)
    const expiry = 1_762_300_000n
    // abi.encode pads every word to 32 bytes, big-endian, left-aligned for integers and addresses.
    const manual = keccak256(
      concat([toHex(7n, { size: 32 }), pad(proposer, { size: 32 }), toHex(penalty, { size: 32 }), toHex(expiry, { size: 32 })]),
    )
    expect(terminationTermsHash(7n, proposer, penalty, expiry)).toBe(manual)
    // It commits to every term: any change moves the hash.
    expect(terminationTermsHash(8n, proposer, penalty, expiry)).not.toBe(manual)
    expect(terminationTermsHash(7n, proposer, musd(6), expiry)).not.toBe(manual)
    expect(terminationTermsHash(7n, proposer, penalty, expiry + 1n)).not.toBe(manual)
  })

  it('encodes with the uint128 / uint64 types the contract decodes', () => {
    const proposer = '0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1' as Address
    const viaTypes = keccak256(
      encodeAbiParameters(
        [
          { name: 'leaseId', type: 'uint256' },
          { name: 'proposer', type: 'address' },
          { name: 'penaltyToLandlord', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
        ],
        [7n, proposer, musd(5), 1_762_300_000n],
      ),
    )
    expect(terminationTermsHash(7n, proposer, musd(5), 1_762_300_000n)).toBe(viaTypes)
  })
})

describe('isOpenOffer', () => {
  it('treats a zero proposer as no offer', () => {
    expect(isOpenOffer(undefined)).toBe(false)
    expect(isOpenOffer({ proposer: '0x0000000000000000000000000000000000000000', penaltyToLandlord: 0n, expiry: 0n })).toBe(false)
    expect(isOpenOffer({ proposer: '0x61e6E29C48878142E25d8BeBdaDe3e584FCDdce1', penaltyToLandlord: 0n, expiry: 1n })).toBe(true)
  })
})

describe('tenantSide', () => {
  it('is the deposit plus the unearned rent at `now`', () => {
    const twoHoursIn = START + 2 * 3600
    // 2 of 6 periods earned: 20 deposit + 4 × 10 unearned rent
    expect(tenantSide(lease(), twoHoursIn)).toBe(musd(60))
  })

  it('caps at the term and never goes negative before it starts', () => {
    expect(tenantSide(lease(), START + 99 * 3600)).toBe(musd(20))
    expect(tenantSide(lease(), START - 3600)).toBe(musd(80))
  })
})

describe('terminationSplit', () => {
  it('gives the landlord the earned-but-unclaimed rent plus the penalty, the tenant the rest', () => {
    const l = lease({ periodsClaimed: 0, claimablePeriods: 2, claimableAmount: musd(20) })
    // earned 2 periods unclaimed (20) + 5 penalty -> landlord 25; escrow 80 -> tenant 55
    expect(terminationSplit(l, musd(5))).toEqual({ toLandlord: musd(25), toTenant: musd(55) })
  })

  it('with no claimable rent the penalty is all the landlord gains', () => {
    expect(terminationSplit(lease(), musd(10))).toEqual({ toLandlord: musd(10), toTenant: musd(70) })
  })
})

describe('timeoutSplit', () => {
  it('pays the landlord the rent earned by the time the dispute was opened, unclaimed', () => {
    const opened = BigInt(START + 2 * 3600 + 60) // just into the third hour: 2 periods earned
    const l = lease({ claimablePeriods: 2, claimableAmount: musd(20) })
    // 2 periods earned at open, none claimed: 20 to the landlord, 60 (deposit + unearned rent) to the tenant
    expect(timeoutSplit(l, opened)).toEqual({ toLandlord: musd(20), toTenant: musd(60) })
  })

  it('subtracts periods already claimed before the dispute', () => {
    const opened = BigInt(START + 3 * 3600)
    const l = lease({ periodsClaimed: 2, escrowBalance: musd(60) }) // 80 - 2 claimed periods
    // 3 earned at open, 2 claimed: 1 period (10) to the landlord, 50 to the tenant
    expect(timeoutSplit(l, opened)).toEqual({ toLandlord: musd(10), toTenant: musd(50) })
  })

  it('handles a dispute opened after the term (all rent earned)', () => {
    const opened = BigInt(START + 10 * 3600)
    expect(timeoutSplit(lease(), opened)).toEqual({ toLandlord: musd(60), toTenant: musd(20) })
  })
})
