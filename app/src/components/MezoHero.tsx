import { useContracts, useEscrowStats, useMezoProtocol } from '../hooks'
import { formatToken } from '../lib/format'
import { formatUsd } from '../panels/BorrowPanel'
import { ExtLink } from './ui'

const LOOP = [
  { n: '1', title: 'Lock BTC on Mezo', body: 'Your bitcoin stays yours, as collateral in a Mezo trove.' },
  { n: '2', title: 'Borrow MUSD', body: 'Mezo’s Bitcoin-backed dollar. No selling, no bank.' },
  { n: '3', title: 'Pay monthly', body: 'Deposit and first month up front, then each month from your trove, into the escrow.' },
  { n: '4', title: 'Rent out, deposit back', body: 'Rent unlocks to the landlord each period. The deposit returns at move-out.' },
] as const

type StatProps = {
  label: string
  /** The formatted figure; only set once there is a number worth painting (fresh or last good). */
  value?: string
  /** Muted sub-line under the figure, e.g. "all leases settled". */
  sub?: string
  /** No number at all yet and the chain read is still running: a shimmer block stands in. */
  loading?: boolean
  /** The chain read failed, so there is no number to show. */
  error?: boolean
  onRetry?: () => void
}

function Stat({ label, value, sub, loading, error, onRetry }: StatProps) {
  return (
    <div className="hero-stat">
      <dt>{label}</dt>
      {loading ? (
        <dd aria-hidden="true">
          <span className="stat-skeleton" />
        </dd>
      ) : error ? (
        <dd className="stat-unavailable">
          Unavailable
          <button type="button" className="stat-retry" onClick={onRetry}>
            Retry
          </button>
        </dd>
      ) : (
        <>
          <dd>{value}</dd>
          {sub ? <span className="stat-sub">{sub}</span> : null}
        </>
      )}
    </div>
  )
}

/** Mezo landing: the MUSD loop in one line, plus live numbers read from the chain. */
export function MezoHero() {
  const { tokenDecimals } = useContracts()
  const stats = useEscrowStats()
  const protocol = useMezoProtocol({ seedFromCache: true })
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
          Get a lease
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

      <dl
        className="hero-stats"
        aria-label="Live on Mezo testnet"
        aria-busy={(stats.isPending || protocol.isPending) || undefined}
      >
        {/* isError outranks data: "Unavailable" beats last visit's numbers quietly passing as live. */}
        <Stat
          label="MUSD held in lease escrow"
          loading={stats.isPending}
          error={stats.isError}
          onRetry={() => stats.refetch()}
          value={stats.data ? formatToken(stats.data.locked, tokenDecimals) : undefined}
          sub={stats.data?.locked === 0n ? 'all leases settled' : undefined}
        />
        <Stat
          label="Leases on this escrow"
          loading={stats.isPending}
          error={stats.isError}
          onRetry={() => stats.refetch()}
          value={stats.data ? String(stats.data.leases) : undefined}
        />
        <Stat
          label="BTC price on Mezo"
          loading={protocol.isPending}
          error={protocol.isError}
          onRetry={() => protocol.refetch()}
          value={protocol.data ? formatUsd(protocol.data.price) : undefined}
        />
      </dl>
    </section>
  )
}
