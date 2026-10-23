import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { parseEventLogs, type Address } from 'viem'
import { demoLandlordAbi } from '../abi/demoLandlord'
import { AddressLink, TxStatus } from '../components/ui'
import { DEMO_LANDLORD } from '../config'
import { useContracts, useDemoClient, useTx, useWallet } from '../hooks'
import { formatDuration, formatToken } from '../lib/format'

function useDemoTerms(demo: Address) {
  const client = useDemoClient()
  return useQuery({
    queryKey: ['demo-terms', demo],
    staleTime: Infinity,
    queryFn: async () => {
      const at = { address: demo, abi: demoLandlordAbi } as const
      const [deposit, rent, period, periods] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...at, functionName: 'deposit' },
          { ...at, functionName: 'rentPerPeriod' },
          { ...at, functionName: 'periodSeconds' },
          { ...at, functionName: 'periods' },
        ],
      })
      return { deposit, rent, period, periods }
    },
  })
}

/**
 * One-wallet path: the DemoLandlord contract is an allowlisted landlord that creates a small lease with the
 * caller as tenant, so a reviewer can run the whole tenant side without a second wallet.
 */
export function DemoLeaseCard() {
  if (!DEMO_LANDLORD) return null
  return <DemoLease demo={DEMO_LANDLORD} />
}

function DemoLease({ demo }: { demo: Address }) {
  const { tokenDecimals, tokenSymbol } = useContracts()
  const { address, ready } = useWallet()
  const client = useDemoClient()
  const terms = useDemoTerms(demo)
  const tx = useTx()
  const [leaseId, setLeaseId] = useState<bigint | null>(null)
  const t = terms.data

  async function request() {
    setLeaseId(null)
    const receipt = await tx.run({ address: demo, abi: demoLandlordAbi, functionName: 'requestLease', args: [] }, 'Request a demo lease')
    if (receipt) {
      const [created] = parseEventLogs({ abi: demoLandlordAbi, eventName: 'DemoLeaseCreated', logs: receipt.logs })
      // No event: the tenant already had an unfunded demo lease, which requestLease returned instead.
      let id = created?.args.leaseId
      // Mezo's RPC backends can lag a block behind, so ask a few times.
      for (let i = 0; id === undefined && address && i < 4; i++) {
        const last = await client
          .readContract({ address: demo, abi: demoLandlordAbi, functionName: 'lastLeaseOf', args: [address] })
          .catch(() => 0n)
        if (last > 0n) id = last
        else await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      setLeaseId(id ?? -1n)
    }
  }

  const fmt = (v: bigint) => `${formatToken(v, tokenDecimals)} ${tokenSymbol}`
  return (
    <section className="demo-card" aria-labelledby="demo-title">
      <div className="demo-copy">
        <p className="demo-kicker">Try it with one wallet</p>
        <h3 id="demo-title">Rent from the RentOuts demo landlord</h3>
        <p className="hint">
          {t ? (
            <>
              A {fmt(t.deposit)} deposit and {t.periods} × {fmt(t.rent)} rent, one period every {formatDuration(t.period)}. You’re
              the tenant; the landlord is a contract (<AddressLink address={demo} />
              ), so rent releases on its own schedule and the deposit comes back to you at the end.
            </>
          ) : (
            'Reading the demo terms…'
          )}
        </p>
      </div>
      <div className="demo-actions">
        <button type="button" className="btn btn-primary" disabled={!ready || tx.busy} onClick={request}>
          Get a demo lease
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet.</span> : null}
      </div>
      <TxStatus
        state={tx.state}
        done={leaseId !== null && leaseId > 0n ? `Lease #${leaseId} is waiting for you.` : 'Your demo lease is waiting for you.'}
      />
      {tx.state.status === 'success' ? (
        <p className="hint">
          Next: <a href="#borrow">borrow MUSD against BTC</a> if you need it, then <a href="#fund">pay the lease</a>.
        </p>
      ) : null}
    </section>
  )
}
