import { useState } from 'react'
import { formatUnits } from 'viem'
import type { Address, Hash } from 'viem'
import { useBalance, useReadContract, useSignTypedData } from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { borrowerOperationsSignaturesAbi } from '../abi/mezo'
import { LeaseState } from '../abi/rentEscrow'
import { rentEscrowV2Abi } from '../abi/rentEscrowV2'
import { demoChain, explorerLabel, gasLabel, isMezo } from '../network'
import { AddressLink, Empty, ExtLink, NotConfigured, Notice, TxStatus } from '../components/ui'
import {
  activeEscrowAbi,
  troveHints,
  useContracts,
  useDemoClient,
  useHumanGate,
  useLeases,
  useMezoProtocol,
  useRentoutsName,
  useRentoutsNames,
  useTrove,
  useTx,
  useWallet,
  type LeaseRow,
  type MezoProtocol,
  type Trove,
} from '../hooks'
import { errorMessage } from '../lib/errors'
import { formatDuration, formatToken, txUrl } from '../lib/format'
import { humanGateNotice } from '../lib/humanGate'
import { MOCK_FUND_SCREEN, MOCK_VIEWER } from '../lib/mockLease'
import { mezoSignaturesDomain, openTroveTypes, signatureDeadline, withdrawMusdTypes } from '../lib/mezoSignatures'
import { walletReadQuery } from '../lib/polling'
import { totalDue } from '../lib/lease'
import {
  ONE,
  bestRatioFor,
  borrowHeadroom,
  btcFor,
  collateralFor,
  collateralRatio,
  compositeDebt,
  liquidationPrice,
  percentRatio,
  TroveStatus,
} from '../lib/trove'
import { GAS_KEEP, RATIO_CHOICES, RatioValue, formatBtc, formatUsd } from './BorrowPanel'

/** The ratio a fresh borrow-and-pay trove suggests; minting against an open one keeps 160% like BorrowPanel. */
const SAFE_RATIO = 200
const WITHDRAW_TARGET = 160

// ?mockLease=1 (dev builds only): fixed sample data stands in for the wallet, the trove and the
// leases, so the borrow-and-pay states can be reviewed with no wallet and no RPC. Module-level, like
// TrovePanel's mockTrove: production builds (DEV statically false) fold the branch away and
// tree-shake the mock module out of the bundle.
const mockFundScreen = import.meta.env.DEV && new URLSearchParams(window.location.search).has('mockLease') ? MOCK_FUND_SCREEN : undefined

/** "You sign a Mezo permission first (no gas), then send one transaction." */
const PERMISSION_HINT =
  'Two steps, one transaction: you sign a Mezo permission first — a message, no gas — then confirm the one transaction that pays the lease.'

type PayProps = {
  lease: LeaseRow
  account: Address
  owed: bigint
  onFunded: (leaseId: bigint, hash: Hash) => void
}

/** Reads the borrower's nonce fresh from Mezo's relay right before signing (any spent signature bumps it). */
async function readNonce(client: ReturnType<typeof useDemoClient>, signatures: Address, account: Address): Promise<bigint> {
  return client.readContract({
    address: signatures,
    abi: borrowerOperationsSignaturesAbi,
    functionName: 'getNonce',
    args: [account],
  })
}

/** The fee rate as a percent string, e.g. "0.1". */
const feePercent = (rate: bigint) => formatUnits(rate * 100n, 18)

/**
 * Borrow-and-pay without a trove: one transaction opens one (BTC in, MUSD out) sized to the lease.
 * Mezo's minimum net debt applies, so a small lease borrows the minimum and the surplus comes back.
 */
function OpenTroveAndPay({ lease, account, owed, onFunded, protocol, btc }: PayProps & { protocol: MezoProtocol; btc: bigint | undefined }) {
  const { escrow, tokenDecimals, tokenSymbol, borrowerOpsSignatures } = useContracts()
  const client = useDemoClient()
  const { signTypedDataAsync } = useSignTypedData()
  const { ready } = useWallet()
  const tx = useTx()
  const [picked, setPicked] = useState<number | null>(null)
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)

  const fmt = (v: bigint) => `${formatToken(v, tokenDecimals)} ${tokenSymbol}`
  const debt = owed < protocol.minNetDebt ? protocol.minNetDebt : owed
  const surplus = debt - owed
  const spendable = btc !== undefined && btc > GAS_KEEP ? btc - GAS_KEEP : 0n
  // Until the user picks a ratio, take the safest one the wallet's BTC can carry.
  const fitting = bestRatioFor(debt, spendable, protocol.price, protocol.borrowingRate, protocol.gasCompensation, RATIO_CHOICES)
  const percent = picked ?? fitting ?? SAFE_RATIO
  const fee = (debt * protocol.borrowingRate) / ONE
  const troveDebt = compositeDebt(debt, fee, protocol.gasCompensation)
  const coll = collateralFor(troveDebt, percentRatio(percent), protocol.price)
  const short = btc !== undefined && coll > spendable
  const minBorrow = Number(protocol.minNetDebt / ONE)

  async function pay() {
    if (!escrow || !borrowerOpsSignatures) return
    setSignError(null)
    try {
      const nonce = await readNonce(client, borrowerOpsSignatures, account)
      const deadline = signatureDeadline(Math.floor(Date.now() / 1000))
      setSigning(true)
      const signature = await signTypedDataAsync({
        domain: mezoSignaturesDomain(borrowerOpsSignatures),
        types: openTroveTypes,
        primaryType: 'OpenTrove',
        message: { assetAmount: coll, debtAmount: debt, borrower: account, recipient: escrow, nonce, deadline },
      })
      setSigning(false)
      const [upper, lower] = await troveHints(client, coll, troveDebt)
      const receipt = await tx.run(
        {
          address: escrow,
          abi: rentEscrowV2Abi,
          functionName: 'borrowAndFund',
          args: [lease.id, debt, upper, lower, signature, deadline],
          value: coll,
        },
        `Borrow ${formatToken(debt, 18)} MUSD and pay lease #${lease.id}`,
      )
      if (receipt) onFunded(lease.id, receipt.transactionHash)
    } catch (error) {
      setSigning(false)
      setSignError(errorMessage(error))
    }
  }

  return (
    <div className="stack-s">
      <div className="quote">
        <p className="quote-main">
          <span className="quote-label">Borrow and pay in one transaction — lock</span>
          <strong>{formatBtc(coll)} BTC</strong>
          <span className="quote-arrow" aria-hidden="true">→</span>
          <span className="quote-label">lease #{String(lease.id)} paid{surplus > 0n ? ' and' : ''}</span>
          {surplus > 0n ? (
            <>
              <strong>{fmt(surplus)}</strong>
              <span className="quote-label">back to you</span>
            </>
          ) : null}
        </p>
        <div className="field">
          <span className="field-label" id={`ratio-${lease.id}-label`}>
            Collateral ratio
          </span>
          <div className="filter" role="group" aria-labelledby={`ratio-${lease.id}-label`}>
            {RATIO_CHOICES.map((p) => (
              <button key={p} type="button" className={`chip${percent === p ? ' chip-on' : ''}`} aria-pressed={percent === p} onClick={() => setPicked(p)}>
                {p}%
              </button>
            ))}
          </div>
          <div className="hint">
            {picked === null && fitting !== undefined ? 'The safest ratio your BTC can carry. ' : ''}
            Higher is safer: the BTC price can fall further before the trove is at risk.
          </div>
        </div>
        <dl className="quote-grid">
          <div>
            <dt>MUSD borrowed</dt>
            <dd>{fmt(debt)}</dd>
          </div>
          <div>
            <dt>Borrowing fee ({feePercent(protocol.borrowingRate)}%)</dt>
            <dd>{fmt(fee)}</dd>
          </div>
          <div>
            <dt>Gas reserve (returned when you close)</dt>
            <dd>{fmt(protocol.gasCompensation)}</dd>
          </div>
          <div>
            <dt>Trove debt</dt>
            <dd>{fmt(troveDebt)}</dd>
          </div>
          <div>
            <dt>Liquidation price</dt>
            <dd>{formatUsd(liquidationPrice(coll, troveDebt, protocol.mcr))} per BTC</dd>
          </div>
          <div>
            <dt>Comes back to you</dt>
            <dd>{surplus > 0n ? fmt(surplus) : 'nothing — the lease needs it all'}</dd>
          </div>
        </dl>
        {owed < protocol.minNetDebt ? (
          <p className="hint">
            Mezo’s minimum is {minBorrow.toLocaleString('en-US')} MUSD of debt, more than the {fmt(owed)} this lease
            needs. The difference is minted to you, not to the landlord.
          </p>
        ) : null}
      </div>

      {short ? (
        <Notice tone="warn">
          This needs {formatBtc(coll)} BTC and the wallet holds {formatBtc(btc!)} (a little stays back for gas). Get
          testnet BTC from <ExtLink href="https://faucet.test.mezo.org">Mezo’s faucet</ExtLink>, or pick a lower ratio.
        </Notice>
      ) : null}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!ready || short || tx.busy || signing || !escrow || !borrowerOpsSignatures} onClick={pay}>
          Borrow {fmt(debt)} and pay
        </button>
      </div>
      <p className="hint">{PERMISSION_HINT}</p>
      {signing ? <p className="tx tx-busy">Confirm the Mezo permission in MetaMask…</p> : null}
      {signError ? (
        <p className="tx tx-error" role="alert">
          {signError}
        </p>
      ) : null}
      <TxStatus state={tx.state} done={`Lease #${String(lease.id)} paid from a fresh trove. Rent starts unlocking now.`} />
    </div>
  )
}

/** Borrow-and-pay with a trove already open: mint exactly what the lease needs against it. */
function WithdrawAndPay({ lease, account, owed, onFunded, protocol, trove }: PayProps & { protocol: MezoProtocol; trove: Trove }) {
  const { escrow, tokenDecimals, tokenSymbol, borrowerOpsSignatures } = useContracts()
  const client = useDemoClient()
  const { signTypedDataAsync } = useSignTypedData()
  const { ready } = useWallet()
  const tx = useTx()
  const [signing, setSigning] = useState(false)
  const [signError, setSignError] = useState<string | null>(null)

  const fmt = (v: bigint) => `${formatToken(v, tokenDecimals)} ${tokenSymbol}`
  const room = trove.recoveryMode
    ? 0n
    : borrowHeadroom(trove.coll, trove.debt, protocol.price, percentRatio(WITHDRAW_TARGET), trove.maxBorrowingCapacity)
  const maxMint = (room * ONE) / (ONE + protocol.borrowingRate)
  const fee = (owed * protocol.borrowingRate) / ONE
  const newDebt = trove.debt + owed + fee
  const newRatio = collateralRatio(trove.coll, newDebt, protocol.price)
  const fits = owed <= maxMint
  const blocked = trove.recoveryMode || !fits

  async function pay() {
    if (!escrow || !borrowerOpsSignatures || blocked) return
    setSignError(null)
    try {
      const nonce = await readNonce(client, borrowerOpsSignatures, account)
      const deadline = signatureDeadline(Math.floor(Date.now() / 1000))
      setSigning(true)
      const signature = await signTypedDataAsync({
        domain: mezoSignaturesDomain(borrowerOpsSignatures),
        types: withdrawMusdTypes,
        primaryType: 'WithdrawMUSD',
        message: { amount: owed, borrower: account, recipient: escrow, nonce, deadline },
      })
      setSigning(false)
      const [upper, lower] = await troveHints(client, trove.coll, newDebt)
      const receipt = await tx.run(
        {
          address: escrow,
          abi: rentEscrowV2Abi,
          functionName: 'withdrawAndFund',
          args: [lease.id, owed, upper, lower, signature, deadline],
        },
        `Mint ${formatToken(owed, 18)} MUSD from the trove and pay lease #${lease.id}`,
      )
      if (receipt) onFunded(lease.id, receipt.transactionHash)
    } catch (error) {
      setSigning(false)
      setSignError(errorMessage(error))
    }
  }

  return (
    <div className="stack-s">
      <div className="quote">
        <p className="quote-main">
          <span className="quote-label">Pay from your trove in one transaction — mint</span>
          <strong>{fmt(owed)}</strong>
          <span className="quote-arrow" aria-hidden="true">→</span>
          <span className="quote-label">lease #{String(lease.id)} paid</span>
        </p>
        <dl className="quote-grid">
          <div>
            <dt>Borrowing fee ({feePercent(protocol.borrowingRate)}%)</dt>
            <dd>{fmt(fee)}</dd>
          </div>
          <div>
            <dt>Trove debt after</dt>
            <dd>{fmt(newDebt)}</dd>
          </div>
          <div>
            <dt>Collateral ratio after</dt>
            <dd>
              <RatioValue ratio={newRatio} protocol={protocol} />
            </dd>
          </div>
          <div>
            <dt>Liquidation price after</dt>
            <dd>{formatUsd(liquidationPrice(trove.coll, newDebt, protocol.mcr))} per BTC</dd>
          </div>
        </dl>
        <p className="hint">
          Your BTC stays locked as it is; only the debt grows. Manage it any time in <a href="#trove">Your trove</a>.
        </p>
      </div>

      {trove.recoveryMode ? (
        <Notice tone="warn">
          Mezo is in Recovery Mode, so no new debt: the trove can’t mint MUSD for this lease right now. Pay with MUSD
          you already have below, or wait for the system to recover.
        </Notice>
      ) : !fits ? (
        <Notice tone="warn">
          This trove can only carry {fmt(maxMint)} more MUSD safely (it keeps {WITHDRAW_TARGET}% collateral and stays
          inside Mezo’s borrowing cap). Add BTC in <a href="#trove">Your trove</a> first, or pay with MUSD you already
          have below.
        </Notice>
      ) : null}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!ready || blocked || tx.busy || signing || !escrow || !borrowerOpsSignatures} onClick={pay}>
          Mint {fmt(owed)} and pay
        </button>
      </div>
      <p className="hint">{PERMISSION_HINT}</p>
      {signing ? <p className="tx tx-busy">Confirm the Mezo permission in MetaMask…</p> : null}
      {signError ? (
        <p className="tx tx-error" role="alert">
          {signError}
        </p>
      ) : null}
      <TxStatus state={tx.state} done={`Lease #${String(lease.id)} paid from your trove. Rent starts unlocking now.`} />
    </div>
  )
}

/** The Mezo-only wrapper that picks the borrow-and-pay variant from the wallet's trove. */
function BorrowAndPay(props: PayProps) {
  const protocolQuery = useMezoProtocol()
  const troveQuery = useTrove(props.account)
  const { data: btc } = useBalance({ address: props.account, chainId: demoChain.id, query: walletReadQuery(true) })
  const mock = mockFundScreen
  const protocol = mock ? mock.protocol : protocolQuery.data
  const trove = mock ? mock.trove : troveQuery.data
  if (protocolQuery.isError && !mock) {
    return <Notice tone="error">Couldn’t read Mezo Borrow. The testnet RPC may be busy; this retries.</Notice>
  }
  if (!protocol) return <p className="hint">Reading Mezo Borrow…</p>
  if (!trove) return <p className="hint">Reading your trove…</p>
  return trove.status === TroveStatus.active ? (
    <WithdrawAndPay {...props} protocol={protocol} trove={trove} />
  ) : (
    <OpenTroveAndPay {...props} protocol={protocol} btc={mock ? mock.btc : btc?.value} />
  )
}

function FundRow({
  lease,
  account,
  balance,
  gated,
  onFunded,
}: {
  lease: LeaseRow
  account: Address
  balance: bigint | undefined
  /** The escrow's human gate rejects this wallet, so every funding path would revert. */
  gated: boolean
  /** Called once funding confirms; the row leaves the waiting list on the next refresh. */
  onFunded: (leaseId: bigint, hash: Hash) => void
}) {
  const { escrow, token, tokenDecimals, tokenSymbol } = useContracts()
  const nameOf = useRentoutsNames([lease.landlord])
  const approveTx = useTx()
  const fundTx = useTx()
  const due = totalDue(lease.deposit, lease.rentPerPeriod, lease.periods)

  const { data: allowance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, escrow!],
    chainId: demoChain.id,
    query: walletReadQuery(!!escrow),
  })
  const approved = allowance !== undefined && allowance >= due
  const enough = balance !== undefined && balance >= due
  const amount = `${formatToken(due, tokenDecimals)} ${tokenSymbol}`
  const { data: protocol } = useMezoProtocol()

  return (
    <li className="fund-row">
      <div className="fund-terms">
        <p className="fund-title">
          Lease #{String(lease.id)} from <AddressLink address={lease.landlord} name={nameOf(lease.landlord)} />
        </p>
        <p className="hint">
          {formatToken(lease.deposit, tokenDecimals)} deposit + {lease.periods} × {formatToken(lease.rentPerPeriod, tokenDecimals)} rent,
          one period every {formatDuration(lease.periodSeconds)}. You prepay {amount}
          {isMezo && protocol ? <> (≈ {formatBtc(btcFor(due, protocol.price))} BTC at today’s price)</> : null}.
        </p>
      </div>

      {isMezo && !gated ? <BorrowAndPay lease={lease} account={account} owed={due} onFunded={onFunded} /> : null}

      {isMezo ? <p className="pay-alt">Or pay with MUSD you already have</p> : null}
      <div className="fund-actions">
        <button
          type="button"
          className="btn"
          disabled={approved || approveTx.busy || !escrow || gated}
          onClick={() =>
            approveTx.run({ address: token, abi: erc20Abi, functionName: 'approve', args: [escrow!, due] }, `Approve ${amount} for lease #${lease.id}`)
          }
        >
          {approved ? 'Approved' : `Approve ${amount}`}
        </button>
        <button
          type="button"
          className={isMezo ? 'btn' : 'btn btn-primary'}
          disabled={!approved || !enough || fundTx.busy || gated}
          onClick={async () => {
            const receipt = await fundTx.run(
              { address: escrow!, abi: activeEscrowAbi, functionName: 'fundLease', args: [lease.id] },
              `Fund lease #${lease.id}`,
            )
            if (receipt) onFunded(lease.id, receipt.transactionHash)
          }}
        >
          {isMezo ? 'Pay with my MUSD' : 'Fund lease'}
        </button>
      </div>
      {!enough && balance !== undefined ? (
        <p className={isMezo ? 'hint' : 'status status-bad'}>
          You need {amount} and hold {formatToken(balance, tokenDecimals)}
          {isMezo ? <> — or use borrow-and-pay above, which needs no MUSD up front.</> : null}
        </p>
      ) : null}
      <TxStatus state={approveTx.state} done="Escrow approved to pull the exact amount." />
      <TxStatus state={fundTx.state} done="Lease funded. Rent starts unlocking now; follow it under Run the lease." />
    </li>
  )
}

export function FundPanel() {
  const { escrow, token, tokenDecimals, tokenSymbol, escrowError } = useContracts()
  const { address: walletAddress } = useWallet()
  const { data: myName } = useRentoutsName(walletAddress)
  const [funded, setFunded] = useState<{ id: bigint; hash: Hash } | null>(null)
  const leases = useLeases(escrow)
  const { data: balance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: walletAddress ? [walletAddress] : undefined,
    chainId: demoChain.id,
    query: walletReadQuery(!!walletAddress),
  })
  const { data: eth } = useBalance({ address: walletAddress, chainId: demoChain.id, query: walletReadQuery(!!walletAddress) })
  const gate = humanGateNotice(useHumanGate(walletAddress))

  // ?mockLease=1 (dev only): fixed sample data stands in for the wallet, the balance and the leases.
  const mock = mockFundScreen
  const address = mock ? MOCK_VIEWER : walletAddress
  const shownBalance = mock ? mock.musd : balance

  const mine = ((mock ? mock.waiting : leases.data) ?? []).filter((l) => address && l.tenant.toLowerCase() === address.toLowerCase())
  const waiting = mine.filter((l) => l.state === LeaseState.CREATED)

  return (
    <div className="stack">
      <div>
        <h2>{isMezo ? 'Pay the lease in MUSD' : 'Fund the lease'}</h2>
        <p className="lede">
          {isMezo ? (
            <>
              Pay the deposit and every period’s rent in one go — straight from a Mezo trove you open in the same
              transaction, or with MUSD you already hold. Either way, only the contract moves the money from here: to
              the landlord as rent, back to you as deposit.
            </>
          ) : (
            <>
              The tenant approves the escrow for the exact amount, then prepays deposit and rent in one transaction. From
              then on only the contract moves the money: to the landlord as rent, back to the tenant as deposit.
            </>
          )}
        </p>
      </div>

      {address ? (
        <dl className="balances">
          <div>
            <dt>{tokenSymbol} balance</dt>
            <dd>{shownBalance !== undefined ? formatToken(shownBalance, tokenDecimals) : '…'}</dd>
          </div>
          <div>
            <dt>{gasLabel}</dt>
            <dd>{mock ? formatBtc(mock.btc) : eth ? Number(eth.formatted).toFixed(4) : '…'}</dd>
          </div>
        </dl>
      ) : (
        <Notice>Connect MetaMask to see your balance and the leases waiting for you.</Notice>
      )}
      <p className="hint">
        {isMezo ? (
          <>
            Need test funds? <ExtLink href="https://faucet.test.mezo.org">Mezo’s faucet</ExtLink> sends testnet BTC.
            Borrow-and-pay needs only that BTC: the MUSD arrives with the payment itself.
          </>
        ) : (
          <>
            Need test funds? The <ExtLink href="https://ethglobal.com/faucet">ETHGlobal faucet</ExtLink> gives 0.05 Sepolia ETH
            and 1 USDC; <ExtLink href="https://faucet.circle.com">Circle’s faucet</ExtLink> gives more USDC.
          </>
        )}
      </p>

      {escrowError ? <Notice tone="error">{escrowError}</Notice> : null}
      {funded ? (
        <Notice tone="ok">
          <strong>Lease #{String(funded.id)} funded.</strong> Rent starts unlocking now:{' '}
          <a href="#run">follow it under Run the lease</a>. <ExtLink href={txUrl(funded.hash)}>View on {explorerLabel}</ExtLink>
        </Notice>
      ) : null}
      {gate ? (
        <Notice tone={gate.tone}>
          <strong>{gate.title}</strong>. {gate.detail}
        </Notice>
      ) : null}
      {!escrow ? (
        <NotConfigured what="The escrow" envVar="VITE_ESCROW_ADDRESS" />
      ) : !address ? null : leases.isPending && !mock ? (
        <p className="hint">Reading leases…</p>
      ) : waiting.length === 0 ? (
        <Empty title="No leases are waiting for your funding">
          <p>
            Ask the landlord to create one for {myName || address}. It appears here as soon as it’s on-chain.
            {mine.length > 0 ? (
              <>
                {' '}
                Your funded leases are under <a href="#run">Run the lease</a>.
              </>
            ) : null}
          </p>
        </Empty>
      ) : (
        <ul className="list">
          {waiting.map((lease) => (
            <FundRow
              key={String(lease.id)}
              lease={lease}
              account={address}
              balance={shownBalance}
              gated={!!gate?.blocksFunding}
              onFunded={(id, hash) => setFunded({ id, hash })}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
