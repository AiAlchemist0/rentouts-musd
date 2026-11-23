import { getAddress, type Address } from 'viem'

export type DemoTerms = {
  deposit: bigint
  rent: bigint
  period: number
  periods: number
  total: bigint
  firstMonthly: bigint
}

/**
 * DemoLandlordV2's terms are immutable (no owner, no setters), so the values read from Mezo testnet on
 * 2026-11-23 (18-decimal MUSD) are baked in here and the demo card paints them on first render with no
 * network wait. The reads stay live: useDemoTerms still verifies against the chain and the chain values
 * win whenever they differ (a redeploy to a new address is simply an unknown one, with no seed).
 */
const KNOWN_DEMO_TERMS: readonly { demo: Address; terms: DemoTerms }[] = [
  {
    demo: '0x8Cf3F01E8ec43791758768d72993D192A87653Ed',
    terms: {
      deposit: 20_000_000_000_000_000_000n,
      rent: 10_000_000_000_000_000_000n,
      period: 120,
      periods: 3,
      total: 50_000_000_000_000_000_000n,
      firstMonthly: 30_000_000_000_000_000_000n,
    },
  },
]

/** The baked-in terms for `demo`, or undefined for any address this app doesn't know (no seed, chain read only). */
export function knownDemoTerms(demo: Address): DemoTerms | undefined {
  return KNOWN_DEMO_TERMS.find((entry) => entry.demo === getAddress(demo))?.terms
}

/**
 * The useQuery options the demo card reads terms through. The seed rides `placeholderData`, not
 * `initialData`: with staleTime: Infinity an initialData seed never refetches (the mount check treats it
 * as fresh however old `initialDataUpdatedAt` says it is), and the chain verify must still run. With
 * placeholderData the terms paint instantly while the query fetches, and the chain result replaces them.
 * `readTerms` is injected so tests can stand in for the RPC.
 */
export function demoTermsQuery(demo: Address, readTerms: () => Promise<DemoTerms>) {
  return {
    queryKey: ['demo-terms', demo] as const,
    staleTime: Infinity,
    placeholderData: knownDemoTerms(demo),
    queryFn: readTerms,
  }
}
