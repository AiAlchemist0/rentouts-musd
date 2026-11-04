import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import deployment from '../../ens/deployments/sepolia.json'
import { parseDeployments, resolveContracts } from './lib/deployments'
import { DEFAULT_JUDGE_ENS_NAME } from './lib/judgeName'
import { isMezo, MEZO_CHAIN_ID, MUSD_TESTNET } from './network'

const env = import.meta.env

/** Parses an optional address env var. Empty, malformed or zero means "not configured". */
export function optionalAddress(value: string | undefined): Address | undefined {
  const v = value?.trim()
  if (!v) return undefined
  if (!isAddress(v, { strict: false })) {
    console.warn(`Ignoring malformed address in env: ${v}`)
    return undefined
  }
  const address = getAddress(v)
  return address === zeroAddress ? undefined : address
}

export const SEPOLIA_RPC_URL = env.VITE_SEPOLIA_RPC_URL?.trim() || 'https://ethereum-sepolia-rpc.publicnode.com'
export const MEZO_RPC_URL = env.VITE_MEZO_RPC_URL?.trim() || 'https://rpc.test.mezo.org'
/** RPC for the chain this build is aimed at. */
export const RPC_URL = isMezo ? MEZO_RPC_URL : SEPOLIA_RPC_URL

/** Circle's USDC on Ethereum Sepolia (6 decimals). */
export const CIRCLE_USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
/** Mezo testnet MUSD (18 decimals). */
export const MUSD: Address = getAddress(MUSD_TESTNET)

/** ENSv2 deployment, straight from ens/deployments/sepolia.json (written by the ENS deploy script). */
export const ENS = {
  chainId: deployment.chainId,
  subnames: getAddress(deployment.rentoutsSubnames),
  resolver: getAddress(deployment.permissionedResolver),
  registry: getAddress(deployment.userRegistry),
  universalResolver: getAddress(deployment.universalResolver),
  /** Block RentoutsSubnames was deployed in (ens/broadcast/.../subnames-latest.json). Log scans start here. */
  subnamesDeployBlock: 11_779_455n,
} as const

/**
 * The repo-root deployments.json, written by script/DeployEscrow.s.sol ("sepolia"),
 * script/DeployAIArbiter.s.sol ("sepoliaAIArbiter") and script/DeployEscrowV2.s.sol ("mezoTestnetV2").
 * A glob, so a checkout without the file (nothing deployed yet) still builds: the result is just empty.
 * The Mezo build runs the Wave-2 escrow: rentEscrowV2 is the active escrow, and the V1 "mezoTestnet"
 * entry stays readable below it (earlier leases).
 */
const deploymentsFile = Object.values(
  import.meta.glob<unknown>('../../deployments.json', { eager: true, import: 'default' }),
)[0]
export const DEPLOYMENTS = parseDeployments(
  deploymentsFile,
  isMezo ? { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID, v2: true } : undefined,
)
/** The first Mezo deploy (V1), read-only: leases made before the V2 escrow still show in the lease screen. */
export const DEPLOYMENTS_V1 = isMezo
  ? parseDeployments(deploymentsFile, { key: 'mezoTestnet', chainId: MEZO_CHAIN_ID })
  : undefined

/** The VITE_* address overrides are Sepolia addresses; a Mezo build reads only deployments.json "mezoTestnet". */
const addressEnv: Partial<Record<string, string>> = isMezo ? {} : env

const configured = resolveContracts(
  {
    escrow: optionalAddress(addressEnv.VITE_ESCROW_ADDRESS),
    leaseShare: optionalAddress(addressEnv.VITE_LEASE_SHARE_ADDRESS),
    token: optionalAddress(addressEnv.VITE_TOKEN_ADDRESS),
    aiArbiter: optionalAddress(addressEnv.VITE_AI_ARBITER_ADDRESS),
  },
  DEPLOYMENTS,
)

/**
 * CredentialSync from ens/deployments/sepolia.json (written by `ens.sh credentialSync`), trusted only when
 * the escrow it was deployed for is the escrow this app uses.
 */
function recordedCredentialSync(): Address | undefined {
  const record = deployment as { credentialSync?: string; escrow?: string }
  const sync = optionalAddress(record.credentialSync)
  const forEscrow = optionalAddress(record.escrow)
  if (!sync) return undefined
  if (configured.escrow && forEscrow && getAddress(forEscrow) !== getAddress(configured.escrow)) return undefined
  return sync
}

/**
 * Contracts that may not be deployed yet: VITE_* env vars first, then deployments.json. `undefined` = not
 * configured; the UI degrades. Once the escrow is read, its token(), leaseShare(), humanGate() and arbiter() win.
 */
export const ENV_CONTRACTS = {
  escrow: configured.escrow,
  leaseShare: configured.leaseShare,
  /** ENS credentials live on Sepolia only. */
  credentialSync: isMezo ? undefined : (optionalAddress(env.VITE_CREDENTIAL_SYNC_ADDRESS) ?? recordedCredentialSync()),
  token: configured.token ?? (isMezo ? MUSD : CIRCLE_USDC),
  humanGate: configured.humanGate,
  arbiter: configured.arbiter,
  /** AIArbiter. If unset, the app checks whether RentEscrow.arbiter() is one. */
  aiArbiter: isMezo ? undefined : configured.aiArbiter,
  /** Where AIArbiter log scans start (deployments.json "sepoliaAIArbiter".fromBlock), if known. */
  aiFromBlock: configured.aiFromBlock,
  /** Wave-2: Mezo's BorrowerOperationsSignatures the one-transaction borrow-and-pay signs against (hint until escrow.borrowerOpsSignatures() is read). */
  borrowerOpsSignatures: isMezo ? DEPLOYMENTS.borrowerOpsSignatures : undefined,
  /** Wave-2: seconds a dispute stays open (hint until escrow.disputeTimeout() is read). */
  disputeTimeout: isMezo ? DEPLOYMENTS.disputeTimeout : undefined,
  /** The V1 Mezo escrow and its lease shares, when the V2 deploy is the active one. */
  escrowV1: isMezo ? DEPLOYMENTS_V1?.rentEscrow : undefined,
  leaseShareV1: isMezo ? DEPLOYMENTS_V1?.leaseShare1155 : undefined,
} as const

/**
 * DemoLandlord recorded for this escrow (Mezo only; it creates leases on the escrow it was deployed for).
 * The V2 entry records none — the deployed demo landlord is bound to the V1 escrow, whose leases this
 * app can no longer fund — so the one-wallet demo card is off on the Wave-2 build.
 */
export const DEMO_LANDLORD = configured.escrow && DEPLOYMENTS.rentEscrow === configured.escrow ? DEPLOYMENTS.demoLandlord : undefined

/** The AI judge's ENS name, shown on proposals when it resolves to AIArbiter's agent. */
export const JUDGE_ENS_NAME = env.VITE_JUDGE_ENS_NAME?.trim() || DEFAULT_JUDGE_ENS_NAME

export const EXPLORER = isMezo ? 'https://explorer.test.mezo.org' : 'https://sepolia.etherscan.io'
export const ENS_APP = 'https://sepolia.app.ens.domains'

/** The rentouts.* text records the credential card shows, in display order. */
export const CREDENTIAL_KEYS = [
  'rentouts.credential',
  'rentouts.status',
  'rentouts.leasesCompleted',
  'rentouts.disputes',
  'rentouts.rentPaid',
  'rentouts.depositReturnRate',
  'rentouts.rating',
] as const
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]

/**
 * Demo defaults. Sepolia amounts fit the 1 USDC faucet drip. Mezo amounts are whole MUSD
 * (18 decimals) sized under a 2,000 MUSD testnet trove.
 */
export const LEASE_DEFAULTS = isMezo
  ? { deposit: '100', rentPerPeriod: '50', periodSeconds: '120', periods: '3' }
  : { deposit: '0.25', rentPerPeriod: '0.20', periodSeconds: '120', periods: '3' }
