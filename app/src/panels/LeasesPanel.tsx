import { useState, type FormEvent } from 'react'
import { isAddressEqual, type Address } from 'viem'
import { useReadContract } from 'wagmi'
import { ENV_CONTRACTS } from '../config'
import { demoChain, isMezo } from '../network'
import { leaseShareAbi } from '../abi/leaseShare'
import { LeaseState, rentEscrowAbi } from '../abi/rentEscrow'
import type { TerminationRow } from '../abi/rentEscrowV2'
import { SyncButton } from '../components/CredentialCard'
import { AddressLink, Empty, NotConfigured, Notice, TxStatus } from '../components/ui'
import {
  activeEscrowAbi,
  useAiArbiter,
  useContracts,
  useLeases,
  useNow,
  useRentoutsNames,
  useTx,
  useV2Extras,
  useWallet,
  type AiArbiterInfo,
  type LeaseRow,
} from '../hooks'
import { formatCountdown, formatDuration, formatToken, parseToken, parseWhole } from '../lib/format'
import { STATE_LABELS, leaseTiming } from '../lib/lease'
import { MOCK_LEASE_SCREEN, MOCK_VIEWER } from '../lib/mockLease'
import { isOpenOffer, terminationSplit, terminationTermsHash, tenantSide, timeoutSplit } from '../lib/termination'
import { AiJudgePanel } from './AiJudgePanel'

// ?mockLease=1 (dev builds only): fixed sample data, so the Wave-2 lease states can be reviewed with
// no wallet and no RPC. Production builds fold this away and drop the mock module from the bundle.
const mockLeaseScreen = import.meta.env.DEV && new URLSearchParams(window.location.search).has('mockLease') ? MOCK_LEASE_SCREEN : undefined

const same = (a: Address | undefined, b: Address | undefined) => !!a && !!b && isAddressEqual(a, b)

/** The default window an early-end offer stays open for the other side to accept. */
const TERM_DAYS_DEFAULT = 3

/** One segment per period: released, unlocked (claimable) or still ahead. */
function PeriodBar({ lease, elapsed }: { lease: LeaseRow; elapsed: number }) {
  return (
    <ol className="periods" aria-label={`${lease.periodsClaimed} of ${lease.periods} rent periods released`}>
      {Array.from({ length: Math.min(lease.periods, 48) }, (_, i) => {
        const kind = i < lease.periodsClaimed ? 'paid' : i < elapsed ? 'open' : 'ahead'
        return <li key={i} className={`period period-${kind}`} />
      })}
    </ol>
  )
}

/** Absolute landlord/tenant amounts as a proportional bar (tenant emerald, landlord amber). */
function SplitAmounts({ lease, toLandlord, toTenant, fmt }: { lease: LeaseRow; toLandlord: bigint; toTenant: bigint; fmt: (v: bigint) => string }) {
  const total = toLandlord + toTenant
  const tenantPct = total > 0n ? Number((toTenant * 10_000n) / total) / 100 : 0
  return (
    <div
      className="split"
      role="img"
      aria-label={`Of the ${fmt(lease.escrowBalance)} in escrow, ${fmt(toTenant)} to the tenant and ${fmt(toLandlord)} to the landlord`}
    >
      <span className="split-tenant" style={{ width: `${tenantPct}%` }} />
      <span className="split-landlord" style={{ width: `${100 - tenantPct}%` }} />
    </div>
  )
}

/** Propose an early end (or a counter-offer): a penalty to the landlord and an expiry for the answer. */
function TermProposeForm({ lease, now, fmt }: { lease: LeaseRow; now: number; fmt: (v: bigint) => string }) {
  const { escrow, tokenDecimals, tokenSymbol } = useContracts()
  const tx = useTx()
  const [penalty, setPenalty] = useState('0')
  const [days, setDays] = useState(String(TERM_DAYS_DEFAULT))
  const side = tenantSide(lease, now)
  const penaltyUnits = parseToken(penalty, tokenDecimals)
  const dayCount = parseWhole(days, 3650)
  const within = penaltyUnits !== null && penaltyUnits <= side
  const valid = penaltyUnits !== null && dayCount !== null && within
  const split = penaltyUnits !== null ? terminationSplit(lease, penaltyUnits) : null

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || penaltyUnits === null || dayCount === null) return
    await tx.run(
      {
        address: escrow!,
        abi: activeEscrowAbi,
        functionName: 'proposeTermination',
        args: [lease.id, penaltyUnits, BigInt(now + dayCount * 86_400)],
      },
      `Propose ending lease #${lease.id} early (penalty ${formatToken(penaltyUnits, tokenDecimals)} ${tokenSymbol})`,
    )
  }

  return (
    <details className="term">
      <summary>Propose an early end</summary>
      <form className="stack-s" onSubmit={onSubmit}>
        <p className="hint">
          An early end pays the landlord the rent already earned plus a penalty, and the tenant everything else. Both
          sides have to agree: propose, the other side accepts before the offer expires.
        </p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={`term-penalty-${lease.id}`}>Penalty to the landlord ({tokenSymbol})</label>
            <input id={`term-penalty-${lease.id}`} inputMode="decimal" value={penalty} onChange={(e) => setPenalty(e.target.value)} />
            <div className="hint">
              Up to{' '}
              <button type="button" className="linkish" onClick={() => setPenalty(formatToken(side, tokenDecimals))}>
                {fmt(side)}
              </button>{' '}
              — the tenant’s side now (deposit + rent not yet earned).
            </div>
          </div>
          <div className="field">
            <label htmlFor={`term-days-${lease.id}`}>Offer expires in (days)</label>
            <input id={`term-days-${lease.id}`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            <div className="hint">The other side must accept strictly before the expiry.</div>
          </div>
        </div>
        {penaltyUnits !== null && !within ? (
          <p className="status status-bad">
            The penalty is more than the tenant’s side ({fmt(side)}). Lower it.
          </p>
        ) : split ? (
          <p className="summary">
            If accepted: landlord <strong>{fmt(split.toLandlord)}</strong> (earned rent {fmt(lease.claimableAmount)} + penalty), tenant{' '}
            <strong>{fmt(split.toTenant)}</strong>.
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" className="btn" disabled={!valid || tx.busy || !escrow}>
            Propose early end
          </button>
        </div>
        <TxStatus state={tx.state} done="Offer is on-chain. The other side sees it here and can accept it." />
      </form>
    </details>
  )
}

/** The open early-end offer: the split it would pay, and Accept (other side) / Withdraw (proposer). */
function TermOffer({
  lease,
  account,
  offer,
  now,
  fmt,
}: {
  lease: LeaseRow
  account: Address | undefined
  offer: TerminationRow
  now: number
  fmt: (v: bigint) => string
}) {
  const { escrow } = useContracts()
  const tx = useTx()
  const byTenant = same(offer.proposer, lease.tenant)
  const expired = now >= Number(offer.expiry)
  const isProposer = same(account, offer.proposer)
  // The proposer can't accept their own offer; anyone who isn't a party can't accept at all.
  const canAccept = !!account && (same(account, lease.tenant) || same(account, lease.landlord)) && !isProposer
  const split = terminationSplit(lease, offer.penaltyToLandlord)

  return (
    <div className="proposal">
      <p className="proposal-kicker">Early-end offer on the table</p>
      <p className="proposal-split">
        Proposed by the {byTenant ? 'tenant' : 'landlord'}: landlord <strong>{fmt(split.toLandlord)}</strong> · tenant{' '}
        <strong>{fmt(split.toTenant)}</strong>
      </p>
      <SplitAmounts lease={lease} toLandlord={split.toLandlord} toTenant={split.toTenant} fmt={fmt} />
      <dl className="proposal-meta">
        <div>
          <dt>Penalty to the landlord</dt>
          <dd>{fmt(offer.penaltyToLandlord)}</dd>
        </div>
        <div>
          <dt>Offer expires</dt>
          <dd>{expired ? 'expired' : `in ${formatCountdown(Number(offer.expiry) - now)}`}</dd>
        </div>
      </dl>
      <p className="hint">
        Accepting settles the whole escrow at these exact terms and closes the lease. Rent earned but not yet released
        ({fmt(lease.claimableAmount)}) plus the penalty goes to the landlord, everything else to the tenant.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAccept || expired || tx.busy || !escrow}
          onClick={() =>
            tx.run(
              {
                address: escrow!,
                abi: activeEscrowAbi,
                functionName: 'acceptTermination',
                args: [lease.id, terminationTermsHash(lease.id, offer.proposer, offer.penaltyToLandlord, offer.expiry)],
              },
              `Accept the early end of lease #${lease.id}`,
            )
          }
        >
          Accept and end the lease
        </button>
        {isProposer ? (
          <button
            type="button"
            className="btn"
            disabled={tx.busy || !escrow}
            onClick={() =>
              tx.run(
                { address: escrow!, abi: activeEscrowAbi, functionName: 'withdrawTermination', args: [lease.id] },
                `Withdraw the early-end offer on lease #${lease.id}`,
              )
            }
          >
            Withdraw offer
          </button>
        ) : null}
      </div>
      {expired ? <p className="status status-bad">This offer expired. A fresh one can be proposed below.</p> : null}
      {account && !isProposer && !canAccept ? <p className="hint">Only the {byTenant ? 'landlord' : 'tenant'} can accept it.</p> : null}
      <TxStatus state={tx.state} done="Lease ended by agreement. The escrow paid out at the agreed terms." />
    </div>
  )
}

/** The fixed split a dispute timeout pays, with the button anyone can press once it has timed out. */
function TimeoutSettle({ lease, disputeOpenedAt, fmt }: { lease: LeaseRow; disputeOpenedAt: bigint; fmt: (v: bigint) => string }) {
  const { escrow } = useContracts()
  const tx = useTx()
  const split = timeoutSplit(lease, disputeOpenedAt)
  return (
    <div className="proposal">
      <p className="proposal-kicker">Dispute timeout</p>
      <p className="proposal-split">
        Landlord <strong>{fmt(split.toLandlord)}</strong> · tenant <strong>{fmt(split.toTenant)}</strong>
      </p>
      <SplitAmounts lease={lease} toLandlord={split.toLandlord} toTenant={split.toTenant} fmt={fmt} />
      <p className="hint">
        The fixed payout: rent earned by the time the dispute was opened goes to the landlord, everything else
        (unearned rent + deposit) to the tenant. Nobody chooses this split — that is the point of a timeout.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={tx.busy || !escrow}
          onClick={() =>
            tx.run(
              { address: escrow!, abi: activeEscrowAbi, functionName: 'resolveByTimeout', args: [lease.id] },
              `Settle lease #${lease.id} by the dispute timeout`,
            )
          }
        >
          Settle by timeout
        </button>
      </div>
      <TxStatus state={tx.state} done="Dispute settled by timeout. The escrow paid out." />
    </div>
  )
}

/** Direct resolveDispute, for an escrow whose arbiter is a plain account (not the AI judge contract). */
function ResolveDispute({ lease }: { lease: LeaseRow }) {
  const { escrow } = useContracts()
  const [percent, setPercent] = useState(50)
  const tx = useTx()
  return (
    <div className="resolve">
      <label htmlFor={`bps-${lease.id}`}>
        Tenant gets <strong>{percent}%</strong> of the remaining escrow, the landlord {100 - percent}%
      </label>
      <input
        id={`bps-${lease.id}`}
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(e) => setPercent(Number(e.target.value))}
      />
      <button
        type="button"
        className="btn btn-primary"
        disabled={tx.busy}
        onClick={() =>
          tx.run(
            { address: escrow!, abi: activeEscrowAbi, functionName: 'resolveDispute', args: [lease.id, percent * 100] },
            `Resolve dispute on lease #${lease.id} (${percent}% to tenant)`,
          )
        }
      >
        Resolve dispute
      </button>
      <TxStatus state={tx.state} done="Dispute resolved and escrow paid out." />
    </div>
  )
}

function ShareLine({ lease }: { lease: LeaseRow }) {
  const { leaseShare } = useContracts()
  const { data: held } = useReadContract({
    address: leaseShare,
    abi: leaseShareAbi,
    functionName: 'balanceOf',
    args: [lease.landlord, lease.id],
    chainId: demoChain.id,
    query: { enabled: !!leaseShare },
  })
  const { data: supply } = useReadContract({
    address: leaseShare,
    abi: leaseShareAbi,
    functionName: 'totalSupply',
    args: [lease.id],
    chainId: demoChain.id,
    query: { enabled: !!leaseShare },
  })
  if (!leaseShare || held === undefined || supply === undefined || supply === 0n) return null
  return (
    <p className="hint">
      Lease shares: the landlord holds {String(held)} of {String(supply)}. Transfer them under{' '}
      <a href="#shares">Lease shares</a>.
    </p>
  )
}

/** `judge`: the AIArbiter of this escrow (useAiArbiter().judge), or undefined when there is none or it has a problem. */
function LeaseCard({
  lease,
  account,
  judge,
  termination,
  disputeOpenedAt,
}: {
  lease: LeaseRow
  account: Address | undefined
  judge: AiArbiterInfo | undefined
  /** Wave-2: the lease's open early-end offer, if any. */
  termination?: TerminationRow
  /** Wave-2: when the lease's dispute was opened (0n if never). */
  disputeOpenedAt?: bigint
}) {
  const { escrow, arbiter, tokenDecimals, tokenSymbol, disputeTimeout } = useContracts()
  const nameOf = useRentoutsNames([lease.landlord, lease.tenant, ...(judge ? [judge.human] : [])])
  const now = useNow()
  const tx = useTx()
  const timing = leaseTiming(lease, now)
  const fmt = (v: bigint) => `${formatToken(v, tokenDecimals)} ${tokenSymbol}`

  const isLandlord = same(account, lease.landlord)
  const isTenant = same(account, lease.tenant)
  const isArbiter = same(account, arbiter)
  const isHuman = same(account, judge?.human)
  const active = lease.state === LeaseState.ACTIVE
  const isParty = isLandlord || isTenant
  const verbs = { claimRent: 'Release rent on', closeLease: 'Close', openDispute: 'Open dispute on', cancelLease: 'Cancel' }
  const call = (functionName: keyof typeof verbs) =>
    tx.run({ address: escrow!, abi: activeEscrowAbi, functionName, args: [lease.id] }, `${verbs[functionName]} lease #${lease.id}`)

  const canClose = active && !!timing?.ended && (isLandlord || now >= timing.publicCloseAt)
  const role = isLandlord
    ? 'You’re the landlord'
    : isTenant
      ? 'You’re the tenant'
      : isHuman
        ? 'You’re the human arbiter'
        : isArbiter
          ? 'You’re the arbiter'
          : null

  // The Wave-2 dispute clock: disputeOpenedAt + disputeTimeout, if both are known.
  const settleAt =
    isMezo && disputeTimeout !== undefined && disputeOpenedAt !== undefined && disputeOpenedAt > 0n
      ? Number(disputeOpenedAt) + disputeTimeout
      : undefined
  const timedOut = settleAt !== undefined && now >= settleAt

  let clock: string | null = null
  if (lease.state === LeaseState.CREATED) clock = 'Waiting for the tenant to fund it.'
  else if (active && timing?.nextUnlock) clock = `Next rent unlocks in ${formatCountdown(timing.nextUnlock - now)}.`
  else if (active && timing?.ended) {
    clock =
      now >= timing.publicCloseAt || isLandlord
        ? 'Term over. The lease can be closed.'
        : `Term over. The landlord can close it now; anyone can in ${formatCountdown(timing.publicCloseAt - now)}.`
  } else if (lease.state === LeaseState.DISPUTED) {
    clock =
      settleAt === undefined
        ? judge
          ? 'Frozen while the dispute is settled: the AI judge proposes, the human arbiter has the last word.'
          : 'Frozen until the escrow’s arbiter resolves the dispute.'
        : timedOut
          ? 'The dispute timeout has passed, so anyone can settle it at the fixed split below.'
          : `Frozen while the dispute is settled. If the arbiter doesn’t rule first, anyone can settle it in ${formatCountdown(settleAt - now)}.`
  }

  const offer = isMezo && isOpenOffer(termination) ? termination : undefined

  return (
    <li className={`lease lease-${STATE_LABELS[lease.state]?.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="lease-head">
        <h3>Lease #{String(lease.id)}</h3>
        <span className={`state state-${lease.state}`}>{STATE_LABELS[lease.state] ?? 'Unknown'}</span>
        {role ? <span className="role">{role}</span> : null}
      </div>

      <dl className="lease-grid">
        <div>
          <dt>Landlord</dt>
          <dd>
            <AddressLink address={lease.landlord} name={nameOf(lease.landlord)} />
          </dd>
        </div>
        <div>
          <dt>Tenant</dt>
          <dd>
            <AddressLink address={lease.tenant} name={nameOf(lease.tenant)} />
          </dd>
        </div>
        <div>
          <dt>Rent</dt>
          <dd>
            {fmt(lease.rentPerPeriod)} every {formatDuration(lease.periodSeconds)}
          </dd>
        </div>
        <div>
          <dt>Deposit</dt>
          <dd>{fmt(lease.deposit)}</dd>
        </div>
        <div>
          <dt>In escrow</dt>
          <dd>{fmt(lease.escrowBalance)}</dd>
        </div>
        <div>
          <dt>Claimable now</dt>
          <dd>
            {lease.claimablePeriods > 0 ? `${fmt(lease.claimableAmount)} (${lease.claimablePeriods} period${lease.claimablePeriods > 1 ? 's' : ''})` : '—'}
          </dd>
        </div>
      </dl>

      {timing ? (
        <div className="lease-progress">
          <PeriodBar lease={lease} elapsed={timing.elapsed} />
          <p className="hint">
            {lease.periodsClaimed} of {lease.periods} period{lease.periods === 1 ? '' : 's'} released to the landlord.
          </p>
        </div>
      ) : null}
      {clock ? <p className="clock">{clock}</p> : null}

      <div className="actions">
        {active ? (
          <button type="button" className="btn" disabled={tx.busy || lease.claimablePeriods === 0} onClick={() => call('claimRent')}>
            {lease.claimablePeriods > 0 ? `Release ${fmt(lease.claimableAmount)} rent` : 'Release rent'}
          </button>
        ) : null}
        {active ? (
          <button type="button" className="btn" disabled={tx.busy || !canClose} onClick={() => call('closeLease')}>
            Close lease
          </button>
        ) : null}
        {active && isParty ? (
          <button type="button" className="btn btn-danger" disabled={tx.busy} onClick={() => call('openDispute')}>
            Open dispute
          </button>
        ) : null}
        {lease.state === LeaseState.CREATED && isLandlord ? (
          <button type="button" className="btn" disabled={tx.busy} onClick={() => call('cancelLease')}>
            Cancel lease
          </button>
        ) : null}
        {lease.state === LeaseState.CREATED && isTenant ? (
          <a className="btn btn-primary" href="#fund">
            Fund this lease
          </a>
        ) : null}
      </div>
      <TxStatus state={tx.state} />

      {isMezo && active ? (
        <>
          {offer ? <TermOffer lease={lease} account={account} offer={offer} now={now} fmt={fmt} /> : null}
          {isParty ? <TermProposeForm lease={lease} now={now} fmt={fmt} /> : null}
        </>
      ) : null}

      {isMezo && lease.state === LeaseState.DISPUTED && timedOut && settleAt !== undefined && disputeOpenedAt !== undefined ? (
        <TimeoutSettle lease={lease} disputeOpenedAt={disputeOpenedAt} fmt={fmt} />
      ) : null}

      {judge && (lease.state === LeaseState.DISPUTED || lease.state === LeaseState.CLOSED) ? (
        <AiJudgePanel lease={lease} account={account} info={judge} now={now} nameOf={nameOf} />
      ) : null}
      {/* A contract arbiter never connects a wallet, so this is only for a plain-account arbiter. */}
      {lease.state === LeaseState.DISPUTED && isArbiter ? <ResolveDispute lease={lease} /> : null}
      {lease.state === LeaseState.DISPUTED && !judge && !isArbiter && arbiter ? (
        <p className="hint">
          Arbiter: <AddressLink address={arbiter} />. It settles the dispute with a split of the remaining escrow.
        </p>
      ) : null}

      {lease.state === LeaseState.CLOSED && !isMezo ? (
        <div className="lease-sync">
          <p className="hint">Closed leases count toward the tenant’s ENS credential once it’s synced.</p>
          <SyncButton tenant={lease.tenant} label="Sync tenant’s credential to ENS" />
        </div>
      ) : null}

      <ShareLine lease={lease} />
    </li>
  )
}

/** One read-only-ish row of the V1 escrow: the lease still pays out there, so claim and close stay live. */
function V1LeaseRow({ lease, account }: { lease: LeaseRow; account: Address | undefined }) {
  const { tokenDecimals, tokenSymbol } = useContracts()
  const now = useNow()
  const tx = useTx()
  const timing = leaseTiming(lease, now)
  const fmt = (v: bigint) => `${formatToken(v, tokenDecimals)} ${tokenSymbol}`
  const isLandlord = same(account, lease.landlord)
  const canClose =
    lease.state === LeaseState.ACTIVE && !!timing?.ended && (isLandlord || now >= timing.publicCloseAt)

  return (
    <li className="fund-row">
      <div className="fund-terms">
        <p className="fund-title">
          Lease #{String(lease.id)} · {STATE_LABELS[lease.state] ?? 'Unknown'}
        </p>
        <p className="hint">
          Landlord <AddressLink address={lease.landlord} /> · tenant <AddressLink address={lease.tenant} />.{' '}
          {fmt(lease.deposit)} deposit, {lease.periods} × {fmt(lease.rentPerPeriod)} rent, {fmt(lease.escrowBalance)} in
          escrow
          {lease.claimablePeriods > 0 ? `, ${fmt(lease.claimableAmount)} claimable now` : ''}.
        </p>
      </div>
      <div className="fund-actions">
        {lease.state === LeaseState.ACTIVE ? (
          <button type="button" className="btn" disabled={tx.busy || lease.claimablePeriods === 0} onClick={() => tx.run({ address: ENV_CONTRACTS.escrowV1!, abi: rentEscrowAbi, functionName: 'claimRent', args: [lease.id] }, `Release rent on lease #${lease.id} (V1 escrow)`)}>
            {lease.claimablePeriods > 0 ? `Release ${fmt(lease.claimableAmount)} rent` : 'Release rent'}
          </button>
        ) : null}
        {lease.state === LeaseState.ACTIVE ? (
          <button type="button" className="btn" disabled={tx.busy || !canClose} onClick={() => tx.run({ address: ENV_CONTRACTS.escrowV1!, abi: rentEscrowAbi, functionName: 'closeLease', args: [lease.id] }, `Close lease #${lease.id} (V1 escrow)`)}>
            Close lease
          </button>
        ) : null}
      </div>
      <TxStatus state={tx.state} done="Done on the V1 escrow." />
    </li>
  )
}

/** The "Earlier leases" section: everything the first Mezo deploy holds, still payable out of it. */
function V1Leases({ account }: { account: Address | undefined }) {
  const escrowV1 = ENV_CONTRACTS.escrowV1
  const leases = useLeases(escrowV1, rentEscrowAbi)
  if (!escrowV1 || leases.isPending) return null
  if (leases.isError) {
    return (
      <section className="stack-s" aria-label="Earlier leases on the V1 escrow">
        <h3 className="section-title">Earlier leases (V1 escrow)</h3>
        <p className="hint">Couldn’t read the V1 escrow. {leases.error.message}</p>
      </section>
    )
  }
  const all = leases.data ?? []
  if (all.length === 0) return null
  return (
    <section className="stack-s" aria-label="Earlier leases on the V1 escrow">
      <h3 className="section-title">Earlier leases (V1 escrow)</h3>
      <p className="hint">
        Made before this app moved to the Wave-2 escrow. They still live in the first RentEscrow, so rent releases and
        closing happen there.
      </p>
      <ul className="list">
        {all.map((lease) => (
          <V1LeaseRow key={String(lease.id)} lease={lease} account={account} />
        ))}
      </ul>
    </section>
  )
}

export function LeasesPanel() {
  const { escrow, escrowError } = useContracts()
  const ai = useAiArbiter()
  const wallet = useWallet()
  const leases = useLeases(escrow)
  const [showAll, setShowAll] = useState(false)

  // ?mockLease=1 (dev only): fixed sample data stands in for the wallet and the leases.
  const mock = mockLeaseScreen
  const address = mock ? MOCK_VIEWER : wallet.address

  const all = mock ? mock.leases : (leases.data ?? [])
  const extras = useV2Extras(escrow, all.map((l) => l.id))
  // Parallel arrays from the mock or the Wave-2 multicall, aligned with `all`.
  const terminationRows = mock ? mock.terminations : extras.data?.terminations
  const disputeTimes = mock ? mock.disputeOpenedAt : extras.data?.disputeOpenedAt
  const indexOf = (lease: LeaseRow) => all.findIndex((l) => l.id === lease.id)

  const { arbiter } = useContracts()
  const isArbiter = same(address, ai.judge?.human) || same(address, arbiter)
  const mine = all.filter((l) => same(address, l.landlord) || same(address, l.tenant))
  // A dispute the arbiter has seen stays listed after it closes, so its ruling doesn't vanish on success.
  const [seenDisputes, setSeenDisputes] = useState<ReadonlySet<bigint>>(new Set())
  const disputed = all.filter((l) => l.state === LeaseState.DISPUTED)
  if (isArbiter && disputed.some((l) => !seenDisputes.has(l.id))) {
    setSeenDisputes(new Set([...seenDisputes, ...disputed.map((l) => l.id)]))
  }
  const arbiterView = all.filter((l) => l.state === LeaseState.DISPUTED || seenDisputes.has(l.id))
  const visible = showAll || !address ? all : isArbiter ? arbiterView.concat(mine.filter((l) => !arbiterView.includes(l))) : mine

  return (
    <div className="stack">
      <div>
        <h2>Run the lease</h2>
        <p className="lede">
          Rent unlocks period by period and anyone can release it; it can only go to the landlord. After the term the
          lease closes: remaining rent to the landlord, deposit back to the tenant. Either side can freeze it instead
          {isMezo
            ? ' and take it to the escrow’s arbiter — or end it early by agreement, or let a stalled dispute time out.'
            : ' and take it to the AI judge contract, where a human arbiter has the last word.'}
        </p>
      </div>
      {escrowError ? <Notice tone="error">{escrowError}</Notice> : null}
      {ai.error ? <Notice tone="error">{ai.error}</Notice> : null}
      {ai.problem ? (
        <Notice tone="warn">
          {ai.problem} The AI judge panel is off on this page until that’s fixed, so nothing is read from or sent to
          that contract.
        </Notice>
      ) : null}
      {!escrow ? (
        <NotConfigured what="The escrow" envVar="VITE_ESCROW_ADDRESS" />
      ) : leases.isPending && !mock ? (
        <p className="hint">Reading leases from the escrow…</p>
      ) : leases.isError && !mock ? (
        <Notice tone="error">Couldn’t read leases. {leases.error.message}</Notice>
      ) : (
        <>
          {address ? (
            <div className="filter" role="group" aria-label="Which leases">
              <button type="button" className={`chip${!showAll ? ' chip-on' : ''}`} aria-pressed={!showAll} onClick={() => setShowAll(false)}>
                {isArbiter ? 'Disputes and mine' : 'Mine'}
              </button>
              <button type="button" className={`chip${showAll ? ' chip-on' : ''}`} aria-pressed={showAll} onClick={() => setShowAll(true)}>
                All leases ({all.length})
              </button>
            </div>
          ) : null}
          {visible.length === 0 ? (
            <Empty title={all.length === 0 ? 'No leases yet' : 'None of these leases involve your wallet'}>
              <p>
                {all.length === 0 ? (
                  <>
                    Start one under <a href="#create">Create a lease</a>.
                  </>
                ) : (
                  <>Switch to “All leases” to see everyone’s, or create one under <a href="#create">Create a lease</a>.</>
                )}
              </p>
            </Empty>
          ) : (
            <ul className="list">
              {visible.map((lease) => {
                const i = indexOf(lease)
                return (
                  <LeaseCard
                    key={String(lease.id)}
                    lease={lease}
                    account={address}
                    judge={ai.judge}
                    termination={i >= 0 ? terminationRows?.[i] : undefined}
                    disputeOpenedAt={i >= 0 ? disputeTimes?.[i] : undefined}
                  />
                )
              })}
            </ul>
          )}
          {isMezo ? <V1Leases account={address} /> : null}
        </>
      )}
    </div>
  )
}
