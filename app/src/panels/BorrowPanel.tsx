import { useState, type FormEvent } from 'react'
import { formatUnits } from 'viem'
import { useBalance, useReadContract } from 'wagmi'
import { borrowerOperationsAbi, MEZO_BORROW } from '../abi/mezo'
import { erc20Abi } from '../abi/erc20'
import { ExtLink, Field, Notice, TxStatus } from '../components/ui'
import { troveHints, useContracts, useDemoClient, useMezoProtocol, useTrove, useTx, useWallet, type MezoProtocol, type Trove } from '../hooks'
import { formatRounded, formatToken, parseToken } from '../lib/format'
import { walletReadQuery } from '../lib/polling'
import {
  collateralFor,
  collateralRatio,
  compositeDebt,
  headroom,
  liquidationPrice,
  ONE,
  percentRatio,
  ratioPercent,
  TroveStatus,
} from '../lib/trove'
import { demoChain } from '../network'

const RATIO_CHOICES = [160, 200, 250] as const
const MEZO_APP = 'https://testnet.mezo.org'

/** "0.05505" BTC, four to six significant decimals. */
export function formatBtc(amount: bigint): string {
  const n = Number(formatUnits(amount, 18))
  if (n === 0) return '0'
  return n >= 1 ? n.toFixed(4) : n.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')
}

/** "$81,644" from an 18-decimal price. */
export function formatUsd(price: bigint): string {
  return `$${Number(price / ONE).toLocaleString('en-US')}`
}

function ratioTone(ratio: bigint, protocol: MezoProtocol): 'ok' | 'warn' | 'bad' {
  if (ratio < protocol.mcr) return 'bad'
  if (ratio < protocol.ccr + percentRatio(10)) return 'warn'
  return 'ok'
}

function RatioValue({ ratio, protocol }: { ratio: bigint; protocol: MezoProtocol }) {
  return <span className={`ratio ratio-${ratioTone(ratio, protocol)}`}>{ratioPercent(ratio)}%</span>
}

function ProtocolStrip({ protocol, btc, musd }: { protocol: MezoProtocol; btc?: bigint; musd?: bigint }) {
  return (
    <dl className="balances balances-4">
      <div>
        <dt>BTC price (Mezo feed)</dt>
        <dd>{formatUsd(protocol.price)}</dd>
      </div>
      <div>
        <dt>Liquidation below</dt>
        <dd>{ratioPercent(protocol.mcr)}% collateral</dd>
      </div>
      <div>
        <dt>Your BTC</dt>
        <dd>{btc !== undefined ? formatBtc(btc) : '—'}</dd>
      </div>
      <div>
        <dt>Your MUSD</dt>
        <dd>{musd !== undefined ? formatRounded(musd, 18) : '—'}</dd>
      </div>
    </dl>
  )
}

function OpenTrove({ protocol, btc }: { protocol: MezoProtocol; btc: bigint | undefined }) {
  const client = useDemoClient()
  const { ready } = useWallet()
  const tx = useTx()
  const minBorrow = Number(protocol.minNetDebt / ONE)
  const [amount, setAmount] = useState(String(Math.max(2000, minBorrow)))
  const [percent, setPercent] = useState<number>(200)

  const borrow = parseToken(amount, 18)
  const fee = borrow !== null ? (borrow * protocol.borrowingRate) / ONE : 0n
  const debt = borrow !== null ? compositeDebt(borrow, fee, protocol.gasCompensation) : 0n
  const coll = borrow !== null ? collateralFor(debt, percentRatio(percent), protocol.price) : 0n
  const tooSmall = borrow !== null && borrow < protocol.minNetDebt
  const short = btc !== undefined && coll > btc
  const valid = borrow !== null && borrow > 0n && !tooSmall

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || borrow === null) return
    const [upper, lower] = await troveHints(client, coll, debt)
    await tx.run(
      {
        address: MEZO_BORROW.borrowerOperations,
        abi: borrowerOperationsAbi,
        functionName: 'openTrove',
        args: [borrow, upper, lower],
        value: coll,
      },
      `Borrow ${formatToken(borrow, 18)} MUSD against ${formatBtc(coll)} BTC`,
    )
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="grid-2">
        <Field label="MUSD to borrow" htmlFor="borrow-amount" hint={`Mezo’s minimum is ${minBorrow.toLocaleString('en-US')} MUSD.`}>
          <input id="borrow-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label" id="ratio-label">
            Collateral ratio
          </span>
          <div className="filter" role="group" aria-labelledby="ratio-label">
            {RATIO_CHOICES.map((p) => (
              <button
                key={p}
                type="button"
                className={`chip${percent === p ? ' chip-on' : ''}`}
                aria-pressed={percent === p}
                onClick={() => setPercent(p)}
              >
                {p}%{p === 200 ? ' · suggested' : ''}
              </button>
            ))}
          </div>
          <div className="hint">Higher is safer: the BTC price can fall further before the trove is at risk.</div>
        </div>
      </div>

      {valid ? (
        <div className="quote">
          <div className="quote-main">
            <span className="quote-label">You lock</span>
            <strong>{formatBtc(coll)} BTC</strong>
            <span className="quote-arrow" aria-hidden="true">→</span>
            <span className="quote-label">you receive</span>
            <strong>{formatToken(borrow!, 18)} MUSD</strong>
          </div>
          <dl className="quote-grid">
            <div>
              <dt>Borrowing fee ({formatUnits(protocol.borrowingRate * 100n, 18)}%)</dt>
              <dd>{formatToken(fee, 18)} MUSD</dd>
            </div>
            <div>
              <dt>Gas reserve (returned when you close)</dt>
              <dd>{formatToken(protocol.gasCompensation, 18)} MUSD</dd>
            </div>
            <div>
              <dt>Trove debt</dt>
              <dd>{formatToken(debt, 18)} MUSD</dd>
            </div>
            <div>
              <dt>Liquidation price</dt>
              <dd>{formatUsd(liquidationPrice(coll, debt, protocol.mcr))} per BTC</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="status status-bad">
          {tooSmall ? `Borrow at least ${minBorrow.toLocaleString('en-US')} MUSD.` : 'Enter an amount of MUSD (up to 18 decimals).'}
        </p>
      )}

      {short ? (
        <Notice tone="warn">
          This needs {formatBtc(coll)} BTC and the wallet holds {formatBtc(btc!)}. Get testnet BTC from{' '}
          <ExtLink href="https://faucet.test.mezo.org">Mezo’s faucet</ExtLink>, or pick a lower ratio.
        </Notice>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || !valid || short || tx.busy}>
          {valid ? `Borrow ${formatToken(borrow!, 18)} MUSD` : 'Borrow MUSD'}
        </button>
        {!ready ? <span className="hint">Connect a wallet on Mezo testnet to borrow.</span> : null}
      </div>
      <TxStatus state={tx.state} done="MUSD is in your wallet and your BTC stays yours, locked in the trove." />
      {tx.state.status === 'success' ? (
        <p className="hint">
          Next: <a href="#fund">pay the deposit and rent in MUSD</a>.
        </p>
      ) : null}
    </form>
  )
}

function BorrowMore({ protocol, trove }: { protocol: MezoProtocol; trove: Trove }) {
  const client = useDemoClient()
  const { ready } = useWallet()
  const tx = useTx()
  const ratio = collateralRatio(trove.coll, trove.debt, protocol.price)
  // Stay at or above 160% after the fee so the trove isn't near the line.
  const target = percentRatio(160)
  const room = headroom(trove.coll, trove.debt, protocol.price, target)
  const maxBorrow = (room * ONE) / (ONE + protocol.borrowingRate)
  const [amount, setAmount] = useState('')

  const borrow = parseToken(amount, 18)
  const fee = borrow !== null ? (borrow * protocol.borrowingRate) / ONE : 0n
  const newDebt = borrow !== null ? trove.debt + borrow + fee : trove.debt
  const newRatio = collateralRatio(trove.coll, newDebt, protocol.price)
  const valid = borrow !== null && borrow > 0n && newRatio >= protocol.mcr

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || borrow === null) return
    const [upper, lower] = await troveHints(client, trove.coll, newDebt)
    await tx.run(
      {
        address: MEZO_BORROW.borrowerOperations,
        abi: borrowerOperationsAbi,
        functionName: 'withdrawMUSD',
        args: [borrow, upper, lower],
      },
      `Borrow ${formatToken(borrow, 18)} more MUSD`,
    )
    setAmount('')
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="trove">
        <p className="trove-title">Your Mezo trove</p>
        <dl className="quote-grid">
          <div>
            <dt>BTC locked</dt>
            <dd>{formatBtc(trove.coll)} BTC</dd>
          </div>
          <div>
            <dt>MUSD owed</dt>
            <dd>{formatRounded(trove.debt, 18)} MUSD</dd>
          </div>
          <div>
            <dt>Collateral ratio</dt>
            <dd>
              <RatioValue ratio={ratio} protocol={protocol} />
            </dd>
          </div>
          <div>
            <dt>Liquidation price</dt>
            <dd>{formatUsd(liquidationPrice(trove.coll, trove.debt, protocol.mcr))} per BTC</dd>
          </div>
        </dl>
      </div>

      <Field
        label="Borrow more MUSD"
        htmlFor="borrow-more"
        hint={
          maxBorrow > 0n ? (
            <>
              Up to{' '}
              <button type="button" className="linkish" onClick={() => setAmount(formatUnits(maxBorrow - (maxBorrow % ONE), 18))}>
                {formatToken(maxBorrow - (maxBorrow % ONE), 18)} MUSD
              </button>{' '}
              keeps the trove at 160% or more.
            </>
          ) : (
            'The trove is below 160%. Add BTC on Mezo before borrowing more.'
          )
        }
      >
        <input id="borrow-more" inputMode="decimal" placeholder="e.g. 100" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>

      {borrow !== null && borrow > 0n ? (
        <p className={valid ? 'summary' : 'status status-bad'}>
          {valid ? (
            <>
              After a {formatToken(fee, 18)} MUSD fee the trove owes <strong>{formatRounded(newDebt, 18)} MUSD</strong> at{' '}
              <RatioValue ratio={newRatio} protocol={protocol} /> collateral.
            </>
          ) : (
            `That would take the trove under ${ratioPercent(protocol.mcr)}%, where it can be liquidated.`
          )}
        </p>
      ) : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || !valid || tx.busy}>
          {valid ? `Borrow ${formatToken(borrow!, 18)} MUSD` : 'Borrow MUSD'}
        </button>
        <ExtLink href={MEZO_APP}>Repay or add BTC on Mezo</ExtLink>
      </div>
      <TxStatus state={tx.state} done="MUSD is in your wallet. Your BTC stays locked in the trove, still yours." />
      {tx.state.status === 'success' ? (
        <p className="hint">
          Next: <a href="#fund">pay the deposit and rent in MUSD</a>.
        </p>
      ) : null}
    </form>
  )
}

export function BorrowPanel() {
  const { token } = useContracts()
  const { address, isConnected } = useWallet()
  const protocol = useMezoProtocol()
  const trove = useTrove(address)
  const { data: btc } = useBalance({ address, chainId: demoChain.id, query: walletReadQuery(!!address) })
  const { data: musd } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: demoChain.id,
    query: walletReadQuery(!!address),
  })

  return (
    <div className="stack">
      <div>
        <h2>Borrow MUSD against your BTC</h2>
        <p className="lede">
          Rent on RentOuts is paid in MUSD, Mezo’s Bitcoin-backed dollar. You don’t have to sell bitcoin to get it: lock
          BTC in a Mezo trove and borrow MUSD against it. Keep your bitcoin, pay your rent.
        </p>
      </div>

      {protocol.isError ? <Notice tone="error">Couldn’t read Mezo Borrow. The testnet RPC may be busy; this retries.</Notice> : null}
      {protocol.data ? <ProtocolStrip protocol={protocol.data} btc={btc?.value} musd={musd} /> : <p className="hint">Reading Mezo Borrow…</p>}

      {!isConnected ? (
        <Notice>
          Connect a wallet to borrow. You need testnet BTC from <ExtLink href="https://faucet.test.mezo.org">Mezo’s faucet</ExtLink>{' '}
          first.
        </Notice>
      ) : !protocol.data || trove.isPending ? null : trove.data?.status === TroveStatus.active ? (
        <BorrowMore protocol={protocol.data} trove={trove.data} />
      ) : (
        <OpenTrove protocol={protocol.data} btc={btc?.value} />
      )}

      <p className="hint">
        This calls Mezo Borrow directly (<code>BorrowerOperations.openTrove</code> / <code>withdrawMUSD</code>). The trove
        is yours, not RentOuts’: manage or repay it any time at <ExtLink href={MEZO_APP}>testnet.mezo.org</ExtLink>. Already
        have MUSD? Skip to <a href="#fund">paying rent</a>.
      </p>
    </div>
  )
}
