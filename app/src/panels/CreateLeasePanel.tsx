import { useState, type FormEvent } from 'react'
import { parseEventLogs } from 'viem'
import { useReadContract } from 'wagmi'
import { connectToCreate, demoChain, isMezo } from '../network'
import { DemoLeaseCard } from './DemoLeaseCard'
import { leaseShareAbi } from '../abi/leaseShare'
import { CredentialCard } from '../components/CredentialCard'
import { AddressLink, Field, Notice, NotConfigured, TxStatus } from '../components/ui'
import { DEMO_LANDLORD, LEASE_DEFAULTS } from '../config'
import { activeEscrowAbi, useAddressInput, useContracts, useParentName, useRentoutsNames, useTx, useWallet, type ResolvedInput } from '../hooks'
import { formatDuration, formatToken, parseToken, parseWhole } from '../lib/format'
import { leasePartyProblem, totalDue } from '../lib/lease'

const UINT16_MAX = 65_535
const UINT32_MAX = 4_294_967_295

function TenantResolution({ resolved }: { resolved: ResolvedInput }) {
  const nameOf = useRentoutsNames(resolved.kind === 'address' ? [resolved.address] : [])
  switch (resolved.kind) {
    case 'empty':
    case 'pending':
      return null
    case 'loading':
      return <p className="status status-hint">Resolving {resolved.name} through the ENS Universal Resolver…</p>
    case 'error':
      return <p className="status status-bad">{resolved.message}</p>
    case 'address': {
      const name = nameOf(resolved.address)
      return (
        <div className="stack-s">
          <p className="status status-hint">
            {name ? <>This address holds {name}.</> : 'This address has no RentOuts name.'}
          </p>
          {name ? <CredentialCard name={name} compact /> : null}
        </div>
      )
    }
    case 'name':
      return (
        <div className="stack-s">
          <p className="status status-ok">
            {resolved.name} resolves to <AddressLink address={resolved.address} />.
          </p>
          <CredentialCard name={resolved.name} compact />
        </div>
      )
  }
}

export function CreateLeasePanel() {
  const { escrow, leaseShare, arbiter, minPeriod, tokenDecimals, tokenSymbol, tokenMetaReady, tokenError, escrowError } = useContracts()
  const { address, ready } = useWallet()
  const parent = useParentName()
  const [tenantInput, setTenantInput] = useState('')
  const [deposit, setDeposit] = useState<string>(LEASE_DEFAULTS.deposit)
  const [rent, setRent] = useState<string>(LEASE_DEFAULTS.rentPerPeriod)
  const [period, setPeriod] = useState<string>(LEASE_DEFAULTS.periodSeconds)
  const [periods, setPeriods] = useState<string>(LEASE_DEFAULTS.periods)
  /** Pay-monthly (createLeaseMonthly) instead of prepaying everything; only on the Wave-2 escrow. */
  const [monthly, setMonthly] = useState(false)
  const [createdId, setCreatedId] = useState<bigint | null>(null)
  const tx = useTx()

  const resolved = useAddressInput(tenantInput)
  const tenant = resolved.kind === 'name' || resolved.kind === 'address' ? resolved.address : undefined

  const { data: landlordAllowlisted } = useReadContract({
    address: leaseShare,
    abi: leaseShareAbi,
    functionName: 'allowlisted',
    args: address ? [address] : undefined,
    chainId: demoChain.id,
    query: { enabled: !!leaseShare && !!address },
  })

  const depositUnits = parseToken(deposit, tokenDecimals)
  const rentUnits = parseToken(rent, tokenDecimals)
  const periodSeconds = parseWhole(period, UINT32_MAX)
  const periodCount = parseWhole(periods, UINT16_MAX)
  const tooShort = periodSeconds !== null && minPeriod !== undefined && periodSeconds < minPeriod
  const partyError = leasePartyProblem(address, tenant, arbiter)

  const termsValid =
    depositUnits !== null && rentUnits !== null && rentUnits > 0n && periodSeconds !== null && periodCount !== null && !tooShort
  // Amounts are parsed with tokenDecimals, so never before the escrow's token has been read.
  const canSubmit = !!escrow && ready && tokenMetaReady && !!tenant && termsValid && !partyError && !tx.busy

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit || !escrow || !tenant || depositUnits === null || rentUnits === null) return
    setCreatedId(null)
    const who = resolved.kind === 'name' ? resolved.name : tenant
    const receipt = monthly
      ? await tx.run(
          {
            address: escrow,
            abi: activeEscrowAbi,
            functionName: 'createLeaseMonthly',
            args: [tenant, depositUnits, rentUnits, periodSeconds!, periodCount!],
          },
          `Create a pay-monthly lease for ${who}`,
        )
      : await tx.run(
          {
            address: escrow,
            abi: activeEscrowAbi,
            functionName: 'createLease',
            args: [tenant, depositUnits, rentUnits, periodSeconds!, periodCount!],
          },
          `Create lease for ${who}`,
        )
    if (receipt) {
      const [created] = parseEventLogs({
        abi: activeEscrowAbi,
        eventName: monthly ? 'LeaseCreatedMonthly' : 'LeaseCreated',
        logs: receipt.logs,
      })
      setCreatedId(created?.args.leaseId ?? null)
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div>
        <h2>{isMezo ? 'Get a lease' : 'Create a lease'}</h2>
        <p className="lede">
          {isMezo
            ? 'A landlord proposes terms to a tenant’s wallet. The tenant then funds the escrow in MUSD — everything up front, or the deposit plus the first period on a pay-monthly lease — and it pays the landlord one period at a time.'
            : 'The landlord proposes terms to a tenant, named by their ENS name. The tenant then prepays the deposit and every period’s rent into the escrow.'}
        </p>
      </div>

      {/* The Wave-2 deploy records its own demo landlord, so the one-wallet card shows above the plain form. */}
      {isMezo ? <DemoLeaseCard /> : null}
      {isMezo && DEMO_LANDLORD ? <h3 className="section-title">Or list your own lease as a landlord</h3> : null}

      {escrowError ? <Notice tone="error">{escrowError}</Notice> : null}
      {tokenError ? <Notice tone="error">{tokenError}</Notice> : null}

      <Field
        label="Tenant"
        htmlFor="tenant"
        hint={isMezo ? 'The tenant’s 0x address on Mezo testnet.' : 'An ENS name or a 0x address. Names resolve through the ENSv2 Universal Resolver.'}
      >
        <input
          id="tenant"
          value={tenantInput}
          onChange={(e) => setTenantInput(e.target.value)}
          placeholder={isMezo ? '0x…' : parent ? `name.${parent}` : 'name.eth'}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <TenantResolution resolved={resolved} />
      {partyError ? <p className="status status-bad">{partyError}</p> : null}

      {/* Pay-monthly exists on the Wave-2 escrow only; the Sepolia build keeps the single prepaid flow. */}
      {isMezo ? (
        <div className="field">
          <span className="field-label" id="pay-mode-label">
            How the tenant pays
          </span>
          <div className="filter" role="group" aria-labelledby="pay-mode-label">
            <button type="button" className={`chip${!monthly ? ' chip-on' : ''}`} aria-pressed={!monthly} onClick={() => setMonthly(false)}>
              Prepay everything
            </button>
            <button type="button" className={`chip${monthly ? ' chip-on' : ''}`} aria-pressed={monthly} onClick={() => setMonthly(true)}>
              Pay monthly
            </button>
          </div>
          <div className="hint">
            {monthly
              ? 'The tenant starts with the deposit plus the first period, then pays the rest period by period. If a period stays unpaid past its due date and the one-period grace, the landlord can claim default and keep at most one period’s rent from the deposit.'
              : 'The tenant funds the whole lease in one payment before it starts; rent still unlocks to you period by period.'}
          </div>
        </div>
      ) : null}

      <div className="grid-2">
        <Field label={`Deposit (${tokenSymbol})`} htmlFor="deposit">
          <input id="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </Field>
        <Field label={`Rent per period (${tokenSymbol})`} htmlFor="rent">
          <input id="rent" inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} />
        </Field>
        <Field
          label="Period length (seconds)"
          htmlFor="period"
          hint={minPeriod !== undefined ? `Minimum ${minPeriod} s. Short periods keep the demo live.` : 'Short periods keep the demo live.'}
        >
          <input id="period" inputMode="numeric" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="Number of periods" htmlFor="periods">
          <input id="periods" inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value)} />
        </Field>
      </div>

      {termsValid ? (
        monthly ? (
          <p className="summary">
            The tenant starts with <strong>{formatToken(depositUnits! + rentUnits!, tokenDecimals)} {tokenSymbol}</strong>:{' '}
            the {formatToken(depositUnits!, tokenDecimals)} deposit plus the first period’s rent. The other{' '}
            {periodCount - 1} × {formatToken(rentUnits!, tokenDecimals)} are paid period by period from the tenant’s
            trove or MUSD balance. Rent unlocks to you every {formatDuration(periodSeconds!)}, and the deposit goes back
            to the tenant after {formatDuration(periodSeconds! * periodCount!)}.
          </p>
        ) : (
          <p className="summary">
            The tenant prepays <strong>{formatToken(totalDue(depositUnits!, rentUnits!, periodCount!), tokenDecimals)} {tokenSymbol}</strong>:
            a {formatToken(depositUnits!, tokenDecimals)} deposit plus {periodCount} × {formatToken(rentUnits!, tokenDecimals)} rent.
            Rent unlocks to you every {formatDuration(periodSeconds!)}, and the deposit goes back to the tenant after{' '}
            {formatDuration(periodSeconds! * periodCount!)}.
          </p>
        )
      ) : (
        <p className="status status-bad">
          {tooShort
            ? `Periods must be at least ${minPeriod} seconds.`
            : `Enter amounts in ${tokenSymbol} (up to ${tokenDecimals} decimals, rent above zero) and whole numbers for the period and count.`}
        </p>
      )}

      {escrow && leaseShare && address && landlordAllowlisted === false ? (
        <Notice tone="warn">
          Your wallet isn’t on the lease-share compliance allowlist. Creating a lease mints its shares to the landlord,
          so the transaction will fail until the LeaseShare1155 owner allowlists you.
          {isMezo ? ' To try the tenant side right now, use the demo landlord above.' : null}
        </Notice>
      ) : null}

      {!escrow ? (
        <NotConfigured what="The escrow" envVar="VITE_ESCROW_ADDRESS">
          ENS resolution above already works.
        </NotConfigured>
      ) : (
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {monthly ? 'Create monthly lease' : 'Create lease'}
          </button>
          {!ready ? (
            <span className="hint">{connectToCreate}</span>
          ) : !tokenMetaReady && !tokenError ? (
            <span className="hint">Reading the escrow’s token…</span>
          ) : null}
        </div>
      )}
      <TxStatus state={tx.state} done={createdId !== null ? `Lease #${createdId} created.` : 'Lease created.'} />
      {createdId !== null ? (
        <p className="hint">
          Next: the tenant funds it in <a href="#fund">Fund the lease</a>.
        </p>
      ) : null}
    </form>
  )
}
