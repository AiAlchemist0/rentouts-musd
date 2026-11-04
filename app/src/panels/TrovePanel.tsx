import { useState, type FormEvent } from 'react'
import { formatUnits } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { borrowerOperationsAbi, MEZO_BORROW } from '../abi/mezo'
import { erc20Abi } from '../abi/erc20'
import { Empty, ExtLink, Field, Notice, TxStatus } from '../components/ui'
import { troveHints, useContracts, useDemoClient, useMezoProtocol, useTrove, useTx, useWallet, type MezoProtocol, type Trove } from '../hooks'
import { formatRounded, formatToken, parseToken } from '../lib/format'
import { walletReadQuery } from '../lib/polling'
import {
  borrowHeadroom,
  collToReach,
  collateralRatio,
  headroom,
  liquidationPrice,
  percentRatio,
  ratioPercent,
  riskLevel,
  TroveStatus,
  withdrawableColl,
  type RiskLevel,
} from '../lib/trove'
import { demoChain } from '../network'
import { GAS_KEEP, formatBtc, formatUsd } from './BorrowPanel'
import { MOCK_BTC_BALANCE, MOCK_MUSD_BALANCE, MOCK_PROTOCOL, MOCK_TROVE } from '../lib/mockTrove'

/** The ratio this app aims at when it suggests a borrow; withdrawals never plan below 150%. */
const SAFE_TARGET = 160
const WITHDRAW_FLOOR = 150

/** Sample data substituted for every chain read when the dev build is opened with ?mockTrove=1. */
type MockTroveData = { protocol: MezoProtocol; trove: Trove; btc: bigint; musd: bigint }

// The check sits at module level so production builds (DEV statically false) fold the branch away and
// tree-shake the mock module: there, override stays undefined and the panel shows on-chain state only.
let mockTroveData: MockTroveData | undefined
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mockTrove')) {
  mockTroveData = { protocol: MOCK_PROTOCOL, trove: MOCK_TROVE, btc: MOCK_BTC_BALANCE, musd: MOCK_MUSD_BALANCE }
}

const RISK_TONE: Record<RiskLevel, 'ok' | 'warn' | 'bad'> = { safe: 'ok', watch: 'warn', danger: 'bad' }

function RiskValue({ icr, protocol, recoveryMode }: { icr: bigint; protocol: MezoProtocol; recoveryMode: boolean }) {
  const risk = riskLevel(icr, protocol.ccr, recoveryMode)
  return <span className={`ratio ratio-${RISK_TONE[risk]}`}>{ratioPercent(icr)}%</span>
}

/** How far the BTC price can still fall before this trove crosses its liquidation price, e.g. "39.8%". */
function dropBeforeLiquidation(trove: Trove, mcr: bigint): number {
  const liquidation = liquidationPrice(trove.coll, trove.debt, mcr)
  if (liquidation === 0n || liquidation >= trove.price) return 0
  return Number(((trove.price - liquidation) * 1000n) / trove.price) / 10
}

function Summary({ protocol, trove }: { protocol: MezoProtocol; trove: Trove }) {
  const ratioRoom = headroom(trove.coll, trove.debt, protocol.price, percentRatio(SAFE_TARGET))
  const capacityLeft = trove.maxBorrowingCapacity > trove.debt ? trove.maxBorrowingCapacity - trove.debt : 0n
  // Mezo refuses any new borrowing in Recovery Mode (it would lower the trove's ratio).
  const room = trove.recoveryMode
    ? 0n
    : borrowHeadroom(trove.coll, trove.debt, protocol.price, percentRatio(SAFE_TARGET), trove.maxBorrowingCapacity)
  const capped = !trove.recoveryMode && capacityLeft < ratioRoom
  const fall = dropBeforeLiquidation(trove, protocol.mcr)
  return (
    <div className="trove">
      <p className="trove-title">Your trove on Mezo</p>
      <dl className="quote-grid">
        <div>
          <dt>BTC locked (still yours)</dt>
          <dd>{formatBtc(trove.coll)} BTC</dd>
        </div>
        <div>
          <dt>MUSD owed</dt>
          <dd>{formatRounded(trove.debt, 18)} MUSD</dd>
        </div>
        <div>
          <dt>Collateral ratio</dt>
          <dd>
            <RiskValue icr={trove.icr} protocol={protocol} recoveryMode={trove.recoveryMode} />
          </dd>
        </div>
        <div>
          <dt>Liquidation below</dt>
          <dd>{formatUsd(liquidationPrice(trove.coll, trove.debt, protocol.mcr))} per BTC</dd>
        </div>
        <div>
          <dt>BTC price can fall</dt>
          <dd>{fall > 0 ? `${fall}% before liquidation` : 'at the line — add BTC now'}</dd>
        </div>
        <div>
          <dt>Can still borrow</dt>
          <dd>{room > 0n ? `${formatRounded(room, 18)} MUSD` : 'nothing right now'}</dd>
        </div>
      </dl>
      <p className="hint">
        {trove.recoveryMode
          ? 'New borrowing is paused while Mezo is in Recovery Mode.'
          : capped
          ? `Mezo caps this trove’s total debt at ${formatRounded(trove.maxBorrowingCapacity, 18)} MUSD (recorded when you opened it), and that cap — not the ratio — is the limit now.`
          : `Keeps the trove at ${SAFE_TARGET}% or better, the lowest ratio this app suggests.`}
      </p>
    </div>
  )
}

function AddCollForm({ protocol, trove, btc, ready }: { protocol: MezoProtocol; trove: Trove; btc: bigint | undefined; ready: boolean }) {
  const client = useDemoClient()
  const tx = useTx()
  const [amount, setAmount] = useState('')
  const add = parseToken(amount, 18)
  const newRatio = collateralRatio(add !== null ? trove.coll + add : trove.coll, trove.debt, protocol.price)
  const spendable = btc !== undefined && btc > GAS_KEEP ? btc - GAS_KEEP : 0n
  const short = btc !== undefined && add !== null && add > spendable
  const reach = collToReach(trove.coll, trove.debt, protocol.price, percentRatio(200))
  const valid = add !== null && add > 0n

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || add === null) return
    const [upper, lower] = await troveHints(client, trove.coll + add, trove.debt)
    await tx.run(
      { address: MEZO_BORROW.borrowerOperations, abi: borrowerOperationsAbi, functionName: 'addColl', args: [upper, lower], value: add },
      `Add ${formatBtc(add)} BTC to the trove`,
    )
    setAmount('')
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h3>Add BTC to the trove</h3>
      <Field
        label="BTC to add"
        htmlFor="trove-add"
        hint={
          <>
            {btc !== undefined ? <>Your wallet holds {formatBtc(btc)} BTC (a little stays back for gas). </> : null}
            {reach > 0n ? (
              <>
                To sit at exactly 200%, add{' '}
                <button type="button" className="linkish" onClick={() => setAmount(formatUnits(reach, 18))}>
                  {formatBtc(reach)} BTC
                </button>
                .
              </>
            ) : (
              'The trove is already at 200% or above; any top-up adds margin.'
            )}
          </>
        }
      >
        <input id="trove-add" inputMode="decimal" placeholder="e.g. 0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>

      {amount.trim() !== '' && !valid ? (
        <p className="status status-bad">Enter a BTC amount (up to 18 decimals).</p>
      ) : valid ? (
        <p className="summary">
          After adding, the trove sits at <RiskValue icr={newRatio} protocol={protocol} recoveryMode={trove.recoveryMode} /> collateral
          and the liquidation price moves to {formatUsd(liquidationPrice(trove.coll + add!, trove.debt, protocol.mcr))} per BTC.
        </p>
      ) : null}

      {short ? (
        <Notice tone="warn">
          That is more BTC than the wallet holds to spare. Get testnet BTC from{' '}
          <ExtLink href="https://faucet.test.mezo.org">Mezo’s faucet</ExtLink>, or add less.
        </Notice>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || !valid || short || tx.busy}>
          {valid ? `Add ${formatBtc(add!)} BTC` : 'Add BTC'}
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet.</span> : null}
      </div>
      <TxStatus state={tx.state} done="BTC is locked in the trove: your ratio is higher and the liquidation price is further away." />
    </form>
  )
}

function RepayForm({ protocol, trove, musd, ready }: { protocol: MezoProtocol; trove: Trove; musd: bigint | undefined; ready: boolean }) {
  const client = useDemoClient()
  const tx = useTx()
  const [amount, setAmount] = useState('')
  // The gas reserve never counts as debt, and Mezo's minimum debt stays: repay at most debt - reserve - minimum.
  const netDebt = trove.debt > protocol.gasCompensation ? trove.debt - protocol.gasCompensation : 0n
  const maxRepay = netDebt > protocol.minNetDebt ? netDebt - protocol.minNetDebt : 0n
  const repay = parseToken(amount, 18)
  const withinMax = repay !== null && repay <= maxRepay
  const shortBalance = musd !== undefined && repay !== null && repay > musd
  const newDebt = withinMax ? trove.debt - repay! : trove.debt
  const newRatio = collateralRatio(trove.coll, newDebt, protocol.price)
  const valid = repay !== null && repay > 0n && withinMax && !shortBalance

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || repay === null) return
    const [upper, lower] = await troveHints(client, trove.coll, newDebt)
    await tx.run(
      { address: MEZO_BORROW.borrowerOperations, abi: borrowerOperationsAbi, functionName: 'repayMUSD', args: [repay, upper, lower] },
      `Repay ${formatToken(repay, 18)} MUSD`,
    )
    setAmount('')
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h3>Repay MUSD</h3>
      <Field
        label="MUSD to repay"
        htmlFor="trove-repay"
        hint={
          <>
            {maxRepay > 0n ? (
              <>
                Up to{' '}
                <button type="button" className="linkish" onClick={() => setAmount(formatUnits(maxRepay, 18))}>
                  {formatRounded(maxRepay, 18)} MUSD
                </button>{' '}
                keeps the trove at Mezo’s minimum debt.
              </>
            ) : (
              'This trove is at Mezo’s minimum debt already; close it below to clear the rest.'
            )}
            {musd !== undefined ? <> Your wallet holds {formatRounded(musd, 18)} MUSD.</> : null}
          </>
        }
      >
        <input id="trove-repay" inputMode="decimal" placeholder="e.g. 500" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>

      {amount.trim() !== '' && repay !== null && repay > 0n && !withinMax ? (
        <p className="status status-bad">
          You can repay at most {formatRounded(maxRepay, 18)} MUSD: a trove must keep its gas reserve and at least{' '}
          {formatRounded(protocol.minNetDebt, 18)} MUSD debt, or be closed in one go below.
        </p>
      ) : amount.trim() !== '' && shortBalance ? (
        <p className="status status-bad">
          You hold {musd !== undefined ? formatRounded(musd, 18) : '—'} MUSD; that repay needs {formatRounded(repay!, 18)}.
        </p>
      ) : valid ? (
        <p className="summary">
          After repaying, the trove owes <strong>{formatRounded(newDebt, 18)} MUSD</strong> and sits at{' '}
          <RiskValue icr={newRatio} protocol={protocol} recoveryMode={trove.recoveryMode} /> collateral.
        </p>
      ) : amount.trim() !== '' && !valid ? (
        <p className="status status-bad">Enter an amount of MUSD (up to 18 decimals).</p>
      ) : null}

      <p className="hint">The MUSD is burned straight from your wallet — no approval needed.</p>

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || !valid || tx.busy}>
          {valid ? `Repay ${formatRounded(repay!, 18)} MUSD` : 'Repay MUSD'}
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet.</span> : null}
      </div>
      <TxStatus state={tx.state} done="MUSD repaid: your debt is smaller and your BTC is that much safer." />
    </form>
  )
}

function WithdrawForm({ protocol, trove, ready }: { protocol: MezoProtocol; trove: Trove; ready: boolean }) {
  const client = useDemoClient()
  const tx = useTx()
  const [amount, setAmount] = useState('')
  const max = withdrawableColl(trove.coll, trove.debt, protocol.price, percentRatio(WITHDRAW_FLOOR))
  const take = parseToken(amount, 18)
  const withinMax = take !== null && take <= max
  const newColl = withinMax ? trove.coll - take! : trove.coll
  const newRatio = collateralRatio(newColl, trove.debt, protocol.price)
  const valid = take !== null && take > 0n && withinMax

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || take === null) return
    const [upper, lower] = await troveHints(client, newColl, trove.debt)
    await tx.run(
      { address: MEZO_BORROW.borrowerOperations, abi: borrowerOperationsAbi, functionName: 'withdrawColl', args: [take, upper, lower] },
      `Withdraw ${formatBtc(take)} BTC from the trove`,
    )
    setAmount('')
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h3>Withdraw BTC</h3>
      <Field
        label="BTC to withdraw"
        htmlFor="trove-withdraw"
        hint={
          trove.recoveryMode
            ? 'Withdrawals are paused while Mezo is in Recovery Mode.'
            : max > 0n
              ? (
                <>
                  Up to{' '}
                  <button type="button" className="linkish" onClick={() => setAmount(formatUnits(max, 18))}>
                    {formatBtc(max)} BTC
                  </button>{' '}
                  keeps the trove at 150% or above. Mezo can also refuse a withdrawal that would pull the whole system under 150%.
                </>
              )
              : 'Withdrawing anything would take this trove under 150%, where a BTC price drop can liquidate it. Add BTC or repay MUSD first.'
        }
      >
        <input id="trove-withdraw" inputMode="decimal" placeholder="e.g. 0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={trove.recoveryMode} />
      </Field>

      {trove.recoveryMode ? (
        <Notice tone="warn">
          Recovery Mode: Mezo doesn’t allow collateral withdrawals until the whole system is back above 150%. Repaying MUSD
          or adding BTC still works.
        </Notice>
      ) : amount.trim() !== '' && take !== null && take > 0n && !withinMax ? (
        <p className="status status-bad">
          That would take the trove under {WITHDRAW_FLOOR}%. You can withdraw at most {formatBtc(max)} BTC.
        </p>
      ) : valid ? (
        <p className="summary">
          After withdrawing, the trove sits at <RiskValue icr={newRatio} protocol={protocol} recoveryMode={trove.recoveryMode} /> collateral.
        </p>
      ) : amount.trim() !== '' && !valid ? (
        <p className="status status-bad">Enter a BTC amount (up to 18 decimals).</p>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || !valid || tx.busy || trove.recoveryMode}>
          {valid ? `Withdraw ${formatBtc(take!)} BTC` : 'Withdraw BTC'}
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet.</span> : null}
      </div>
      <TxStatus state={tx.state} done="BTC is back in your wallet, still yours." />
    </form>
  )
}

function CloseForm({ protocol, trove, musd, ready }: { protocol: MezoProtocol; trove: Trove; musd: bigint | undefined; ready: boolean }) {
  const tx = useTx()
  const need = trove.debt > protocol.gasCompensation ? trove.debt - protocol.gasCompensation : 0n
  const short = musd !== undefined && musd < need

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    await tx.run(
      { address: MEZO_BORROW.borrowerOperations, abi: borrowerOperationsAbi, functionName: 'closeTrove', args: [] },
      'Close the trove',
    )
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h3>Close the trove</h3>
      <p className="hint">
        Done borrowing? Closing repays the whole debt in one go — {formatRounded(need, 18)} MUSD — and all{' '}
        {formatBtc(trove.coll)} BTC comes back to your wallet, including the {formatRounded(protocol.gasCompensation, 18)} MUSD
        gas reserve. The wallet needs the full {formatRounded(need, 18)} MUSD for that one transaction.
      </p>

      {trove.recoveryMode ? (
        <Notice tone="warn">Recovery Mode: Mezo doesn’t allow closing a trove until the whole system is back above 150%.</Notice>
      ) : short ? (
        <p className="status status-bad">
          You need {formatRounded(need, 18)} MUSD in the wallet and hold {musd !== undefined ? formatRounded(musd, 18) : '—'}. Repay
          part of the debt above, or borrow the difference elsewhere.
        </p>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-danger" disabled={!ready || trove.recoveryMode || short || tx.busy}>
          {`Close the trove and unlock ${formatBtc(trove.coll)} BTC`}
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet.</span> : null}
      </div>
      <TxStatus state={tx.state} done="Trove closed: the debt is gone and your BTC is back in your wallet." />
    </form>
  )
}

/** One-line note for a trove that isn't active any more (or never was). */
const CLOSED_COPY: Record<number, string> = {
  [TroveStatus.nonExistent]: 'You haven’t opened a trove yet.',
  [TroveStatus.closedByOwner]: 'Your trove is closed: all the BTC came back to your wallet.',
  [TroveStatus.closedByLiquidation]: 'This trove was liquidated: its BTC was sold to cover the debt.',
  [TroveStatus.closedByRedemption]: 'This trove was closed by redemption: another MUSD holder repaid the debt and the BTC came back.',
}

export function TrovePanel() {
  const { token } = useContracts()
  const { address, isConnected, ready } = useWallet()
  const protocolQuery = useMezoProtocol()
  const troveQuery = useTrove(address)
  const { data: btc } = useBalance({ address, chainId: demoChain.id, query: walletReadQuery(!!address) })
  const { data: musd } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: demoChain.id,
    query: walletReadQuery(!!address),
  })

  // ?mockTrove=1 (dev builds only): fixed sample data, so the panel can be reviewed with no wallet and no RPC.
  const mock = mockTroveData
  const protocol = mock ? mock.protocol : protocolQuery.data
  const trove = mock ? mock.trove : troveQuery.data
  const walletBtc = mock ? mock.btc : btc?.value
  const walletMusd = mock ? mock.musd : musd

  const active = trove?.status === TroveStatus.active
  const risk = protocol && trove && active ? riskLevel(trove.icr, protocol.ccr, trove.recoveryMode) : 'safe'

  return (
    <div className="stack">
      <div>
        <h2>Your trove</h2>
        <p className="lede">
          The BTC you locked when you borrowed is still yours — Mezo just holds it as security. This panel watches it for
          you: top it up, pay MUSD back, take BTC out, or close the trove when you’re done.
        </p>
      </div>

      {!isConnected && !mock ? (
        <Notice>
          Connect a wallet to see your trove. No trove yet? <a href="#borrow">Borrow MUSD against BTC</a> first — you lock
          BTC and receive MUSD to pay rent with.
        </Notice>
      ) : !protocol || !trove ? (
        <p className="hint">Reading your trove…</p>
      ) : !active ? (
        <Empty title={CLOSED_COPY[trove.status] ?? 'This trove isn’t active.'}>
          <p>
            <a href="#borrow">Borrow MUSD</a> opens one: lock BTC, receive MUSD, keep your bitcoin.
          </p>
        </Empty>
      ) : (
        <>
          {trove.recoveryMode ? (
            <Notice tone="warn">
              <strong>Mezo is in Recovery Mode.</strong> The whole system sits under 150% collateral, so troves under 150% can
              be liquidated until it recovers. Withdrawals are paused; adding BTC and repaying MUSD still work — they are the
              fastest way out.
            </Notice>
          ) : null}
          {risk === 'danger' ? (
            <Notice tone="error">
              <strong>This trove is under 150% collateral.</strong> A further drop in the BTC price can liquidate it: the BTC
              is sold to cover the debt. Add BTC or repay MUSD below to pull the ratio back up.
            </Notice>
          ) : null}

          <Summary protocol={protocol} trove={trove} />

          <AddCollForm protocol={protocol} trove={trove} btc={walletBtc} ready={ready} />
          <RepayForm protocol={protocol} trove={trove} musd={walletMusd} ready={ready} />
          <WithdrawForm protocol={protocol} trove={trove} ready={ready} />
          <CloseForm protocol={protocol} trove={trove} musd={walletMusd} ready={ready} />
        </>
      )}
    </div>
  )
}
