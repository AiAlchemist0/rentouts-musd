import { encodeAbiParameters, keccak256, zeroAddress, type Address } from 'viem'
import { elapsedPeriods } from './lease'

/** The lease facts the early-end and timeout maths need (a LeaseRow, or the same fields off one). */
export type SettlementLease = {
  id: bigint
  deposit: bigint
  rentPerPeriod: bigint
  periodSeconds: number
  periods: number
  periodsClaimed: number
  startTime: bigint
  claimablePeriods: number
  claimableAmount: bigint
  escrowBalance: bigint
}

export type Split = { toLandlord: bigint; toTenant: bigint }

/**
 * The hash the accepting side passes to acceptTermination:
 * keccak256(abi.encode(leaseId, proposer, penaltyToLandlord, expiry)). Built with viem's encoder from
 * the exact proposal stored on-chain, so a replaced or renewed offer (different terms) hashes
 * differently and the contract reverts WrongTermsHash instead of settling stale terms.
 */
export function terminationTermsHash(leaseId: bigint, proposer: Address, penaltyToLandlord: bigint, expiry: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'leaseId', type: 'uint256' },
        { name: 'proposer', type: 'address' },
        { name: 'penaltyToLandlord', type: 'uint128' },
        { name: 'expiry', type: 'uint64' },
      ],
      [leaseId, proposer, penaltyToLandlord, expiry],
    ),
  )
}

/** An open proposal, as termination(leaseId) returns it; proposer zero address = none. */
export type TerminationOffer = { proposer: Address; penaltyToLandlord: bigint; expiry: bigint }

export function isOpenOffer(offer: TerminationOffer | undefined): boolean {
  return !!offer && offer.proposer !== zeroAddress
}

/**
 * Unearned rent + deposit at `now`: the tenant's side of an early end, and the most a penalty may take
 * from it (proposeTermination's PenaltyTooHigh bound; acceptTermination re-checks it later, when time
 * has passed and the side has shrunk).
 */
export function tenantSide(lease: SettlementLease, now: number): bigint {
  const elapsed = elapsedPeriods(lease, now)
  return lease.deposit + BigInt(Math.max(0, lease.periods - elapsed)) * lease.rentPerPeriod
}

/**
 * What an accepted early end pays: the landlord takes the rent earned but not yet claimed (the lease's
 * live claimable) plus the penalty; the tenant everything else in the escrow.
 */
export function terminationSplit(lease: SettlementLease, penaltyToLandlord: bigint): Split {
  const toLandlord = lease.claimableAmount + penaltyToLandlord
  return { toLandlord, toTenant: lease.escrowBalance - toLandlord }
}

/**
 * The fixed timeout split (resolveByTimeout): rent earned by the time the dispute was opened goes to
 * the landlord, the rest (unearned rent + deposit) to the tenant. The escrow froze accrual at
 * disputeOpenedAt and periodsClaimed cannot move while DISPUTED, so the earned-at-dispute periods are
 * exactly the periods elapsed at disputeOpenedAt, and the unclaimed share of them is what pays out.
 */
export function timeoutSplit(lease: SettlementLease, disputeOpenedAt: bigint): Split {
  const earnedAtDispute = elapsedPeriods(lease, Number(disputeOpenedAt))
  const earned = BigInt(Math.max(0, earnedAtDispute - lease.periodsClaimed)) * lease.rentPerPeriod
  const toLandlord = earned > lease.escrowBalance ? lease.escrowBalance : earned
  return { toLandlord, toTenant: lease.escrowBalance - toLandlord }
}
