import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  escrowStatsCacheKey,
  loadCachedEscrowStats,
  loadCachedMezoProtocol,
  saveCachedEscrowStats,
  saveCachedMezoProtocol,
  serializeBigints,
} from './chainCache'

const ESCROW = '0xE9c9230DE785504c7D383EfEC46cfCa328e257e4' as Address

/** An in-memory stand-in for localStorage, with its entries exposed for key-name assertions. */
function memoryStore(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function throwingStore() {
  return {
    getItem: () => {
      throw new Error('storage blocked')
    },
    setItem: () => {
      throw new Error('quota exceeded')
    },
  }
}

describe('serializeBigints', () => {
  it('writes bigints as strings, so JSON survives them', () => {
    expect(serializeBigints({ locked: 20n, leases: 7n })).toBe('{"locked":"20","leases":"7"}')
  })

  it('leaves non-bigint values alone', () => {
    expect(serializeBigints({ s: 'x', n: 1 })).toBe('{"s":"x","n":1}')
  })
})

describe('escrow stats cache', () => {
  it('round-trips bigints exactly, including values past Number precision', () => {
    const at = memoryStore()
    const stats = { locked: 123456789012345678901234n, leases: 4n }
    saveCachedEscrowStats(stats, ESCROW, at)
    expect(loadCachedEscrowStats(ESCROW, at)).toEqual(stats)
  })

  it('names keys rentouts: and keeps escrows apart', () => {
    const at = memoryStore()
    saveCachedEscrowStats({ locked: 5n, leases: 1n }, ESCROW, at)
    expect([...at.map.keys()]).toEqual([`rentouts:${escrowStatsCacheKey(ESCROW)}`])
    expect(escrowStatsCacheKey(ESCROW)).toMatch(/^escrow-stats:/)
    // Another escrow reads nothing, rather than another escrow's numbers.
    expect(loadCachedEscrowStats('0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503' as Address, at)).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    const at = memoryStore({ [`rentouts:${escrowStatsCacheKey(ESCROW)}`]: '{"locked":"5"' })
    expect(loadCachedEscrowStats(ESCROW, at)).toBeNull()
  })

  it('returns null when the entry is not the expected shape', () => {
    for (const junk of ['{"locked":5,"leases":"1"}', '{"locked":"5"}', '{"locked":"-1","leases":"-2"}', '"5"', 'null']) {
      const at = memoryStore({ [`rentouts:${escrowStatsCacheKey(ESCROW)}`]: junk })
      expect(loadCachedEscrowStats(ESCROW, at), junk).toBeNull()
    }
  })

  it('loads a well-formed entry written under the rentouts: key (fixtures above hit the real key)', () => {
    const at = memoryStore({ [`rentouts:${escrowStatsCacheKey(ESCROW)}`]: '{"locked":"5","leases":"1"}' })
    expect(loadCachedEscrowStats(ESCROW, at)).toEqual({ locked: 5n, leases: 1n })
  })

  it('returns null when nothing was saved', () => {
    expect(loadCachedEscrowStats(ESCROW, memoryStore())).toBeNull()
  })

  it('degrades to no cache when storage throws', () => {
    expect(loadCachedEscrowStats(ESCROW, throwingStore())).toBeNull()
    expect(() => saveCachedEscrowStats({ locked: 5n, leases: 1n }, ESCROW, throwingStore())).not.toThrow()
  })
})

describe('Mezo protocol cache', () => {
  it('round-trips every protocol field', () => {
    const at = memoryStore()
    const protocol = {
      price: 81_644n * 10n ** 18n,
      mcr: 110n * 10n ** 16n,
      ccr: 150n * 10n ** 16n,
      minNetDebt: 50n * 10n ** 18n,
      gasCompensation: 30n * 10n ** 18n,
      borrowingRate: 5n * 10n ** 15n,
    }
    saveCachedMezoProtocol(protocol, at)
    expect(loadCachedMezoProtocol(at)).toEqual(protocol)
  })

  it('names the key rentouts: and rejects a malformed entry', () => {
    expect(loadCachedMezoProtocol(memoryStore({ 'rentouts:mezo-protocol': '{' }))).toBeNull()
    const at = memoryStore()
    saveCachedMezoProtocol({ price: 1n, mcr: 2n, ccr: 3n, minNetDebt: 4n, gasCompensation: 5n, borrowingRate: 6n }, at)
    expect([...at.map.keys()]).toEqual(['rentouts:mezo-protocol'])
    expect(loadCachedMezoProtocol(at)).toEqual({ price: 1n, mcr: 2n, ccr: 3n, minNetDebt: 4n, gasCompensation: 5n, borrowingRate: 6n })
  })
})
