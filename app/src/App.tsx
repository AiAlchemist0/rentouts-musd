import { useEffect, useState, type ReactNode } from 'react'
import { getAddress, isAddressEqual, type Address } from 'viem'
import { Header, NetworkGuard } from './components/Header'
import { AddressLink, ExtLink } from './components/ui'
import { DEMO_LANDLORD, ENS } from './config'
import { MEZO_BORROW } from './abi/mezo'
import { explorerLabel, isMezo } from './network'
import { useAiArbiter, useContracts, useHumanGate } from './hooks'
import { txUrl } from './lib/format'
import { useTxLog } from './txLog'
import { CreateLeasePanel } from './panels/CreateLeasePanel'
import { FundPanel } from './panels/FundPanel'
import { IdentityPanel } from './panels/IdentityPanel'
import { LeasesPanel } from './panels/LeasesPanel'
import { SharesPanel } from './panels/SharesPanel'
import { BorrowPanel } from './panels/BorrowPanel'
import { MezoHero } from './components/MezoHero'

type Step = { id: string; title: string; who: string; panel: () => ReactNode }

const SEPOLIA_STEPS: readonly Step[] = [
  { id: 'identity', title: 'Claim your name', who: 'Tenant', panel: IdentityPanel },
  { id: 'create', title: 'Create a lease', who: 'Landlord', panel: CreateLeasePanel },
  { id: 'fund', title: 'Fund the lease', who: 'Tenant', panel: FundPanel },
  { id: 'run', title: 'Run the lease', who: 'Both, plus the AI judge', panel: LeasesPanel },
  { id: 'shares', title: 'Lease shares', who: 'Landlord', panel: SharesPanel },
]

/** Mezo: no ENS step (names live on Sepolia); borrowing MUSD against BTC sits between the lease and paying it. */
const MEZO_STEPS: readonly Step[] = [
  { id: 'create', title: 'Get a lease', who: 'Tenant or landlord', panel: CreateLeasePanel },
  { id: 'borrow', title: 'Borrow MUSD', who: 'Tenant, against BTC', panel: BorrowPanel },
  { id: 'fund', title: 'Pay in MUSD', who: 'Tenant', panel: FundPanel },
  { id: 'run', title: 'Run the lease', who: 'Landlord and tenant', panel: LeasesPanel },
  { id: 'shares', title: 'Lease shares', who: 'Landlord', panel: SharesPanel },
]

const STEPS = isMezo ? MEZO_STEPS : SEPOLIA_STEPS
type StepId = string

function stepFromHash(): StepId {
  const hash = window.location.hash.slice(1)
  return STEPS.find((s) => s.id === hash)?.id ?? STEPS[0].id
}

/** Tabs driven by the URL hash, so every step has a link judges can open directly. */
function useStep(): StepId {
  const [step, setStep] = useState<StepId>(stepFromHash)
  useEffect(() => {
    const onHash = () => {
      setStep(stepFromHash())
      // Hero links and "Next:" hints change the step from far down the page: bring the steps into view.
      const nav = document.querySelector('.steps')
      const top = nav?.getBoundingClientRect().top
      if (nav && top !== undefined && (top < 0 || top > window.innerHeight * 0.6)) {
        nav.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return step
}

function ContractRow({ name, address, note }: { name: string; address?: Address; note?: ReactNode }) {
  return (
    <div className="contract">
      <dt>{name}</dt>
      <dd>{address ? <AddressLink address={address} /> : <span className="muted">not configured</span>}{note ? <span className="muted"> {note}</span> : null}</dd>
    </div>
  )
}

/** The Mezo build points at the public submission repo. */
const SOURCE_URL = isMezo ? 'https://github.com/AiAlchemist0/rentouts-musd' : 'https://github.com/AiAlchemist0/rentouts-escrow'

const TX_STATUS = { pending: 'Pending', success: 'Confirmed', reverted: 'Reverted' } as const

/** Every transaction sent this session, with its Etherscan link, above whichever step is open. */
function RecentTxs() {
  const log = useTxLog()
  if (log.length === 0) return null
  return (
    <section className="recent" aria-label="Your transactions this session" aria-live="polite">
      <ul>
        {log.slice(0, 3).map((tx) => (
          <li key={tx.hash} className={`recent-${tx.status}`}>
            <span className="recent-status">{TX_STATUS[tx.status]}</span>
            <span className="recent-label">{tx.label}</span>
            <ExtLink href={txUrl(tx.hash)}>{explorerLabel}</ExtLink>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Footer() {
  const { escrow, token, leaseShare, credentialSync, arbiter, humanGate, tokenSymbol } = useContracts()
  const { info: ai } = useAiArbiter()
  const gate = useHumanGate(undefined)
  const gateNote =
    gate.open === undefined
      ? '(who may fund a lease)'
      : gate.open
        ? '(who may fund a lease; open, no verifier set)'
        : '(who may fund a lease; World ID 4.0 verifier plugged in)'
  const arbiterIsAi = !!ai && !!arbiter && isAddressEqual(arbiter, ai.address)
  return (
    <footer className="footer">
      <div className="wrap">
        <h2>{isMezo ? 'Contracts on Mezo testnet' : 'Contracts on Ethereum Sepolia'}</h2>
        <dl className="contracts">
          <ContractRow name="RentEscrow" address={escrow} />
          <ContractRow name={`Token (${tokenSymbol})`} address={token} />
          <ContractRow
            name={arbiterIsAi ? 'Arbiter (AIArbiter)' : 'Arbiter'}
            address={arbiter}
            note={arbiterIsAi ? '(AI judge contract with a human arbiter)' : undefined}
          />
          {ai && !arbiterIsAi ? <ContractRow name="AIArbiter" address={ai.address} note="(AI judge contract with a human arbiter)" /> : null}
          {ai ? <ContractRow name="Human arbiter" address={ai.human} note="(can override the AI until a ruling executes)" /> : null}
          {ai ? <ContractRow name="AI judge key" address={ai.agent} note={ai.agent ? '(can only propose)' : '(AI proposals off)'} /> : null}
          {humanGate ? <ContractRow name="HumanGate" address={humanGate} note={gateNote} /> : null}
          {gate.verifier ? (
            <ContractRow name="World ID gate" address={gate.verifier} note="(HumanGate.verifier(): only wallets registered with a World ID 4.0 proof can fund)" />
          ) : null}
          <ContractRow name="LeaseShare1155" address={leaseShare} />
          {isMezo && DEMO_LANDLORD ? <ContractRow name="DemoLandlord" address={DEMO_LANDLORD} note="(rent from it with one wallet)" /> : null}
          {isMezo ? <ContractRow name="Mezo BorrowerOperations" address={MEZO_BORROW.borrowerOperations} note="(openTrove / withdrawMUSD)" /> : null}
          {isMezo ? <ContractRow name="Mezo PriceFeed" address={getAddress(MEZO_BORROW.priceFeed)} /> : null}
          {isMezo ? null : (
            <>
              <ContractRow name="CredentialSync" address={credentialSync} />
              <ContractRow name="RentoutsSubnames" address={ENS.subnames} />
              <ContractRow name="PermissionedResolver" address={ENS.resolver} />
              <ContractRow name="UserRegistry" address={ENS.registry} />
              <ContractRow name="ENS Universal Resolver" address={ENS.universalResolver} />
            </>
          )}
        </dl>
        <p className="footer-note">
          {isMezo
            ? 'RentOuts Escrow on Mezo testnet. Deposits and rent are paid in MUSD, a Bitcoin-backed stablecoin. Testnet only, no real funds. Source:'
            : 'RentOuts Escrow is a testnet demo. Test USDC only, no real funds. Source:'}{' '}
          <ExtLink href={SOURCE_URL}>{SOURCE_URL.replace('https://', '')}</ExtLink>{' '}
          (MIT).
        </p>
      </div>
    </footer>
  )
}

export function App() {
  const step = useStep()
  const current = STEPS.find((s) => s.id === step)!
  const Panel = current.panel

  return (
    <div className="app">
      <Header />
      <NetworkGuard />
      <main className="wrap main">
        {isMezo ? (
          <MezoHero />
        ) : (
          <section className="hero">
            <h1>Rent held by a contract, not a company.</h1>
            <p>
              With RentOuts, tenants prepay deposit and rent into an escrow on Ethereum Sepolia. Rent unlocks to the landlord period by
              period, the deposit comes back at the end, and each finished lease adds to the tenant’s portable ENS credential.
            </p>
            <p className="hero-note">
              Testnet demo with Circle test USDC. Disputes go to an AI judge contract with a human arbiter: the AI only proposes a
              split, and the human arbiter can override it until it executes.
            </p>
          </section>
        )}

        <nav className="steps" aria-label="Demo steps">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className={`step${s.id === step ? ' step-on' : ''}`} aria-current={s.id === step ? 'step' : undefined}>
                  <span className="step-n">{i + 1}</span>
                  <span className="step-text">
                    <span className="step-title">{s.title}</span>
                    <span className="step-who">{s.who}</span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <RecentTxs />
        <section className="panel" aria-label={current.title}>
          <Panel />
        </section>
      </main>
      <Footer />
    </div>
  )
}
