import type { Address } from 'viem'

/**
 * Last good values for the Mezo landing's live numbers, in localStorage under "rentouts:": a repeat
 * visit paints the hero instantly from the previous visit's read (passed to react-query as
 * placeholderData) and then lets the fresh chain read replace it. Pure functions, so they are
 * unit-testable; every access is guarded, because localStorage can throw (private mode, quota) and
 * an entry from an older build can hold anything — every failure degrades to "no cache", never to a
 * wrong number.
 */

const PREFIX = 'rentouts:'

/** The slice of Storage the cache needs; tests inject an in-memory stand-in. */
type JsonStore = Pick<Storage, 'getItem' | 'setItem'>

function store(): JsonStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** JSON with bigints as strings, so { locked: 5n } round-trips as {"locked":"5"}. */
export function serializeBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
}

/** A string this module wrote for a bigint; anything else (number, loose digits, …) rejects. */
function asBigint(v: unknown): bigint | undefined {
  return typeof v === 'string' && /^-?\d+$/u.test(v) ? BigInt(v) : undefined
}

function readBigintFields(
  at: JsonStore | undefined,
  key: string,
  fields: readonly string[],
): Record<string, bigint> | null {
  if (!at) return null
  let text: string | null
  try {
    text = at.getItem(PREFIX + key)
  } catch {
    return null
  }
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const out: Record<string, bigint> = {}
  for (const field of fields) {
    const value = asBigint(entry[field])
    if (value === undefined) return null
    out[field] = value
  }
  return out
}

function writeBigintFields(at: JsonStore | undefined, key: string, value: object): void {
  if (!at) return
  try {
    at.setItem(PREFIX + key, serializeBigints(value))
  } catch {
    // Quota or private mode: the cache is best-effort, the chain read is the truth.
  }
}

// ------------------------------------------------------------------ escrow stats (the hero tile)

export type CachedEscrowStats = { locked: bigint; leases: bigint }

const ESCROW_STATS_FIELDS = ['locked', 'leases'] as const

/** Namespaced per escrow, so a different escrow never inherits another one's numbers. */
export function escrowStatsCacheKey(escrow: Address): string {
  return `escrow-stats:${escrow}`
}

export function loadCachedEscrowStats(escrow: Address, at?: JsonStore): CachedEscrowStats | null {
  const fields = readBigintFields(at ?? store(), escrowStatsCacheKey(escrow), ESCROW_STATS_FIELDS)
  return fields ? { locked: fields.locked, leases: fields.leases } : null
}

export function saveCachedEscrowStats(stats: CachedEscrowStats, escrow: Address, at?: JsonStore): void {
  writeBigintFields(at ?? store(), escrowStatsCacheKey(escrow), stats)
}

// ------------------------------------------------------------------ Mezo protocol (the BTC price tile)

/** Shape of hooks.ts's MezoProtocol, kept structural so lib stays free of hook imports. */
export type CachedMezoProtocol = {
  price: bigint
  mcr: bigint
  ccr: bigint
  minNetDebt: bigint
  gasCompensation: bigint
  borrowingRate: bigint
}

const MEZO_PROTOCOL_FIELDS = ['price', 'mcr', 'ccr', 'minNetDebt', 'gasCompensation', 'borrowingRate'] as const

export function loadCachedMezoProtocol(at?: JsonStore): CachedMezoProtocol | null {
  const fields = readBigintFields(at ?? store(), 'mezo-protocol', MEZO_PROTOCOL_FIELDS)
  if (!fields) return null
  return {
    price: fields.price,
    mcr: fields.mcr,
    ccr: fields.ccr,
    minNetDebt: fields.minNetDebt,
    gasCompensation: fields.gasCompensation,
    borrowingRate: fields.borrowingRate,
  }
}

export function saveCachedMezoProtocol(protocol: CachedMezoProtocol, at?: JsonStore): void {
  writeBigintFields(at ?? store(), 'mezo-protocol', protocol)
}
