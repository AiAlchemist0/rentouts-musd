import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { demoTermsQuery, knownDemoTerms, type DemoTerms } from './demoTerms'

const DEMO = '0x8Cf3F01E8ec43791758768d72993D192A87653Ed' as Address

/** What the chain returns when it disagrees with the baked-in constants. */
const CHAIN_TERMS: DemoTerms = {
  deposit: 21_000_000_000_000_000_000n,
  rent: 11_000_000_000_000_000_000n,
  period: 60,
  periods: 2,
  total: 51_000_000_000_000_000_000n,
  firstMonthly: 31_000_000_000_000_000_000n,
}

describe('knownDemoTerms', () => {
  it('bakes in the terms read on-chain on 2026-11-23', () => {
    expect(knownDemoTerms(DEMO)).toEqual({
      deposit: 20_000_000_000_000_000_000n,
      rent: 10_000_000_000_000_000_000n,
      period: 120,
      periods: 3,
      total: 50_000_000_000_000_000_000n,
      firstMonthly: 30_000_000_000_000_000_000n,
    })
  })

  it('matches the address case-insensitively, like viem normalises it', () => {
    expect(knownDemoTerms(getAddress(DEMO.toLowerCase()))).toEqual(knownDemoTerms(DEMO))
  })

  it('returns undefined for an unknown landlord, leaving the chain-read-only behaviour', () => {
    expect(knownDemoTerms('0x0000000000000000000000000000000000000001' as Address)).toBeUndefined()
  })
})

describe('demoTermsQuery', () => {
  it('seeds the known constants and stays chain-read-shaped', () => {
    const options = demoTermsQuery(DEMO, () => Promise.resolve(CHAIN_TERMS))
    expect(options.queryKey).toEqual(['demo-terms', DEMO])
    expect(options.placeholderData).toEqual(knownDemoTerms(DEMO))
    expect(options.staleTime).toBe(Infinity)
    // Unknown landlord: no seed, the query is the plain chain read it always was.
    const unseeded = demoTermsQuery('0x0000000000000000000000000000000000000001' as Address, () => Promise.resolve(CHAIN_TERMS))
    expect(unseeded.placeholderData).toBeUndefined()
  })

  it('paints the seed instantly, before any network answer', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(client, demoTermsQuery(DEMO, () => new Promise<DemoTerms>(() => {})))
    const unsubscribe = observer.subscribe(() => {})
    const result = observer.getCurrentResult()
    unsubscribe()
    expect(result.data).toEqual(knownDemoTerms(DEMO))
    expect(result.isPlaceholderData).toBe(true)
    expect(result.isFetching).toBe(true) // the verify keeps running behind the seed
  })

  it('the chain read wins when it differs from the constants', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(client, demoTermsQuery(DEMO, async () => CHAIN_TERMS))
    const settled = await new Promise<QueryObserverResult<DemoTerms, Error>>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.isFetching === false) {
          unsubscribe()
          resolve(result)
        }
      })
    })
    expect(settled.data).toEqual(CHAIN_TERMS)
    expect(settled.isPlaceholderData).toBe(false)
    // Once the chain read has landed, it stays: no placeholder ever comes back.
    expect(observer.getCurrentResult().data).toEqual(CHAIN_TERMS)
  })
})
