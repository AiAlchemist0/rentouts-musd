import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { chainPill, chainPillTitle, demoChain, isMezo, switchChainLabel, wrongNetworkCopy } from '../network'
import { useRentoutsName } from '../hooks'
import { errorMessage } from '../lib/errors'
import { shortAddress } from '../lib/format'

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 64 64" aria-hidden="true">
      <mask id="rentouts-logo-cut">
        <polygon points="32,4 56.25,18 56.25,46 32,60 7.75,46 7.75,18" fill="#fff" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
        <path d="M29.25 35.11A7.25 7.25 0 1 1 34.76 35.11L37.44 47.98H26.56Z" fill="#000" />
      </mask>
      <rect width="64" height="64" fill="currentColor" mask="url(#rentouts-logo-cut)" />
    </svg>
  )
}

function WalletButton() {
  const { address, isConnected, connector } = useAccount()
  const { connect, connectors, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: name } = useRentoutsName(address)
  const injectedConnector = connectors[0]
  const hasWallet = typeof window !== 'undefined' && 'ethereum' in window

  if (isConnected && address) {
    return (
      <button type="button" className="btn btn-quiet wallet" onClick={() => disconnect({ connector })} title={`${address}\nClick to disconnect`}>
        <span className="wallet-dot" aria-hidden="true" />
        {name || shortAddress(address)}
      </button>
    )
  }
  if (!hasWallet) {
    return (
      <a className="btn btn-primary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        Install MetaMask
      </a>
    )
  }
  return (
    <span className="wallet-connect">
      <button
        type="button"
        className="btn btn-primary"
        disabled={isPending || !injectedConnector}
        onClick={() => injectedConnector && connect({ connector: injectedConnector, chainId: demoChain.id })}
      >
        {isPending ? 'Connecting…' : 'Connect MetaMask'}
      </button>
      {error ? <span className="wallet-error">{errorMessage(error)}</span> : null}
    </span>
  )
}

export function Header() {
  return (
    <header className="header">
      <div className="wrap header-row">
        <a className="brand" href={isMezo ? '#create' : '#identity'}>
          <Logo />
          <span className="brand-name">RentOuts</span>
          <span className="brand-sub">Escrow</span>
        </a>
        <div className="header-right">
          <span className="chain-pill" title={chainPillTitle}>
            {chainPill}
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  )
}

/** Shown when the wallet is on another chain; reads keep working, writes wait for the switch. */
export function NetworkGuard() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()
  if (!isConnected || chainId === demoChain.id) return null
  return (
    <div className="guard" role="alert">
      <div className="wrap guard-row">
        <p>
          {wrongNetworkCopy}
          {error ? ` ${errorMessage(error)}` : ''}
        </p>
        <button type="button" className="btn btn-primary" disabled={isPending} onClick={() => switchChain({ chainId: demoChain.id })}>
          {isPending ? 'Switching…' : switchChainLabel}
        </button>
      </div>
    </div>
  )
}
