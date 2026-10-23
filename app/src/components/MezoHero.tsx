import { useContracts, useEscrowStats, useMezoProtocol } from '../hooks'
import { formatToken } from '../lib/format'
import { formatUsd } from '../panels/BorrowPanel'
import { ExtLink } from './ui'

const LOOP = [
  { n: '1', title: 'Lock BTC on Mezo', body: 'Your bitcoin stays yours, as collateral in a Mezo trove.' },
  { n: '2', title: 'Borrow MUSD', body: 'Mezo’s Bitcoin-backed dollar. No selling, no bank.' },
  { n: '3', title: 'Prepay the lease', body: 'Deposit and rent go into the escrow, not to RentOuts and not to the landlord.' },
  { n: '4', title: 'Rent out, deposit back', body: 'Rent unlocks to the landlord each period. The deposit returns at move-out.' },
] as const

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="hero-stat">
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  )
}

/** Mezo landing: the MUSD loop in one line, plus live numbers read from the chain. */
export function MezoHero() {
  const { tokenDecimals } = useContracts()
  const stats = useEscrowStats()
  const protocol = useMezoProtocol()
  return (
    <section className="hero hero-mezo">
      <p className="eyebrow">
        <span className="eyebrow-dot" aria-hidden="true" /> RentOuts on Mezo · testnet
      </p>
      <h1>
        Keep your bitcoin.
        <br />
        <span className="hero-accent">Pay your rent.</span>
      </h1>
      <p>
        <ExtLink href="https://rentouts.co">RentOuts</ExtLink> is a long-term rental marketplace, not nightly stays. Here,
        deposits and rent are paid in MUSD through an escrow nobody controls: rent unlocks to the landlord one period at a time,
        and the deposit comes back to the tenant at move-out.
      </p>
      <div className="hero-cta">
        <a className="btn btn-primary btn-lg" href="#create">
          Try it with one wallet
        </a>
        <a className="btn btn-quiet btn-lg" href="#run">
          See a live lease
        </a>
      </div>

      <ol className="loop" aria-label="How rent in MUSD works">
        {LOOP.map((s) => (
          <li key={s.n} className="loop-step">
            <span className="loop-n">{s.n}</span>
            <span className="loop-title">{s.title}</span>
            <span className="loop-body">{s.body}</span>
          </li>
        ))}
      </ol>

      <dl className="hero-stats" aria-label="Live on Mezo testnet">
        <Stat label="MUSD held in lease escrow" value={stats.data ? formatToken(stats.data.locked, tokenDecimals) : undefined} />
        <Stat label="Leases on this escrow" value={stats.data ? String(stats.data.leases) : undefined} />
        <Stat label="BTC price on Mezo" value={protocol.data ? formatUsd(protocol.data.price) : undefined} />
      </dl>
    </section>
  )
}
