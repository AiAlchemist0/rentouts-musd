import { isAddressEqual, type Address } from 'viem'
import { LeaseState } from '../abi/rentEscrow'

export type LeaseTerms = {
  startTime: bigint
  periodSeconds: number
  periods: number
  periodsClaimed: number
}

export const STATE_LABELS: Record<number, string> = {
  [LeaseState.NONE]: 'Unknown',
  [LeaseState.CREATED]: 'Awaiting funding',
  [LeaseState.ACTIVE]: 'Active',
  [LeaseState.DISPUTED]: 'In dispute',
  [LeaseState.CLOSED]: 'Closed',
  [LeaseState.CANCELLED]: 'Cancelled',
}

export type LeaseTiming = {
  /** Unix seconds when the term ends (startTime + periods * periodSeconds). */
  end: number
  /** Periods fully elapsed, capped at the term. */
  elapsed: number
  /** Unix seconds when the next rent period unlocks, or null once the term is over. */
  nextUnlock: number | null
  ended: boolean
  /** Anyone may close one period after the end; the landlord may close at the end. */
  publicCloseAt: number
}

/** Whole periods elapsed at `at`, capped at the term. Mirrors the escrow's _elapsedPeriods. */
export function elapsedPeriods(terms: Pick<LeaseTerms, 'startTime' | 'periodSeconds' | 'periods'>, at: number): number {
  const start = Number(terms.startTime)
  if (start === 0 || terms.periodSeconds <= 0) return 0
  return Math.min(terms.periods, Math.max(0, Math.floor((at - start) / terms.periodSeconds)))
}

/** Mirrors the escrow's period arithmetic for display. Returns null before the lease is funded. */
export function leaseTiming(terms: LeaseTerms, now: number): LeaseTiming | null {
  const start = Number(terms.startTime)
  if (start === 0 || terms.periodSeconds <= 0) return null
  const end = start + terms.periods * terms.periodSeconds
  const elapsed = elapsedPeriods(terms, now)
  const nextUnlock = elapsed >= terms.periods ? null : start + (elapsed + 1) * terms.periodSeconds
  return { end, elapsed, nextUnlock, ended: now >= end, publicCloseAt: end + terms.periodSeconds }
}

/** deposit + rentPerPeriod * periods: what the tenant prepays in fundLease. */
export function totalDue(deposit: bigint, rentPerPeriod: bigint, periods: number): bigint {
  return deposit + rentPerPeriod * BigInt(periods)
}

/** The lease facts the pay-monthly maths need (a LeaseRow, or the same fields off one). */
export type MonthlyLease = {
  deposit: bigint
  rentPerPeriod: bigint
  periodSeconds: number
  periods: number
  periodsClaimed: number
  startTime: bigint
  /** V2 pay-monthly leases only; undefined on V1 rows, which are prepaid. */
  monthly?: boolean
  /** V2: rent periods paid into the escrow so far. undefined on V1 rows, which fund every period at once. */
  periodsFunded?: number
}

/** The claimDefault payout: what each side walks away with. */
export type DefaultSplit = {
  /** Funded-but-unreleased rent, owed to the landlord once the lease defaults. */
  rentToLandlord: bigint
  /** One unpaid period's rent, taken out of the deposit (never more than the deposit itself). */
  depositForfeit: bigint
  toLandlord: bigint
  toTenant: bigint
}

/**
 * What funding costs the tenant: deposit + every period's rent for a prepaid lease, deposit + ONE
 * period's rent for a monthly one. Mirrors the escrow's _owed across all three funding paths.
 */
export function owedAtFunding(lease: Pick<MonthlyLease, 'deposit' | 'rentPerPeriod' | 'periods' | 'monthly'>): bigint {
  const funded = lease.monthly ? 1 : lease.periods
  return lease.deposit + lease.rentPerPeriod * BigInt(funded)
}

/**
 * When the next unpaid rent period falls due: startTime + periodsFunded * periodSeconds (period i,
 * 0-based, is due at startTime + i * periodSeconds). Null before the lease is funded; for a prepaid
 * (or fully funded monthly) lease this is the end of the term.
 */
export function nextDueAt(lease: Pick<MonthlyLease, 'startTime' | 'periodSeconds' | 'periods' | 'monthly' | 'periodsFunded'>): number | null {
  const start = Number(lease.startTime)
  if (start === 0 || lease.periodSeconds <= 0) return null
  const funded = lease.monthly ? (lease.periodsFunded ?? 0) : lease.periods
  return start + funded * lease.periodSeconds
}

/** When the default rule fires: the next unpaid period's due date plus one full period of grace. Mirrors claimDefault's dueAt. */
export function defaultAt(lease: Pick<MonthlyLease, 'startTime' | 'periodSeconds' | 'periods' | 'monthly' | 'periodsFunded'>): number | null {
  const due = nextDueAt(lease)
  return due === null ? null : due + lease.periodSeconds
}

/** Whether claimDefault would go through right now: monthly, active, not fully funded, past the grace. */
export function isDefaultable(
  lease: Pick<MonthlyLease, 'startTime' | 'periodSeconds' | 'periods' | 'monthly' | 'periodsFunded'> & { state: number },
  now: number,
): boolean {
  if (!lease.monthly || lease.state !== LeaseState.ACTIVE) return false
  if ((lease.periodsFunded ?? 0) >= lease.periods) return false
  const at = defaultAt(lease)
  return at !== null && now >= at
}

/**
 * The claimDefault payout, mirroring the escrow exactly: the landlord takes the funded unclaimed
 * rent plus at most ONE unpaid period's rent out of the deposit, the tenant the rest of the deposit.
 */
export function defaultSplit(
  lease: Pick<MonthlyLease, 'deposit' | 'rentPerPeriod' | 'periodsClaimed' | 'periods' | 'monthly' | 'periodsFunded'>,
): DefaultSplit {
  const funded = lease.monthly ? (lease.periodsFunded ?? 0) : lease.periods
  const fundedUnclaimed = Math.max(0, funded - lease.periodsClaimed)
  const rentToLandlord = BigInt(fundedUnclaimed) * lease.rentPerPeriod
  const depositForfeit = lease.rentPerPeriod < lease.deposit ? lease.rentPerPeriod : lease.deposit
  return {
    rentToLandlord,
    depositForfeit,
    toLandlord: rentToLandlord + depositForfeit,
    toTenant: lease.deposit - depositForfeit,
  }
}

/**
 * Why RentEscrow.createLease would refuse these parties, or null. The escrow reverts InvalidTerms when the
 * tenant is the landlord or when the arbiter is either party, so the app says so before anything is sent.
 */
export function leasePartyProblem(
  landlord: Address | undefined,
  tenant: Address | undefined,
  arbiter: Address | undefined,
): string | null {
  const same = (a: Address | undefined, b: Address | undefined) => !!a && !!b && isAddressEqual(a, b)
  if (same(tenant, landlord)) return 'The tenant can’t be your own wallet.'
  if (same(landlord, arbiter) || same(tenant, arbiter)) return 'The arbiter can’t be the landlord or the tenant of a lease.'
  return null
}
