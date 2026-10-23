import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'

export const SEPOLIA_CHAIN_ID = 11_155_111

/**
 * What the app takes from the repo-root deployments.json. script/DeployEscrow.s.sol writes the "sepolia" entry
 * (rentEscrow, leaseShare1155, humanGate, token, arbiter); script/DeployAIArbiter.s.sol writes
 * "sepoliaAIArbiter" (aiArbiter, human, agent, challengeWindow, fromBlock). Every field is optional: a missing
 * file, entry or key just means "not deployed".
 */
export type Deployments = {
  rentEscrow?: Address
  leaseShare1155?: Address
  humanGate?: Address
  token?: Address
  arbiter?: Address
  aiArbiter?: Address
  /** A block at or before the AIArbiter deploy: where log scans for Evidence / Proposed start. */
  aiFromBlock?: bigint
  /** DemoLandlord (Mezo): lets one wallet request a lease as tenant. */
  demoLandlord?: Address
}

/** A non-zero address, checksummed; anything else (missing, malformed, zero) is undefined. */
export function asAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!isAddress(v, { strict: false })) return undefined
  const address = getAddress(v)
  return address === zeroAddress ? undefined : address
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** An entry counts only on the chain it was written for; the scripts always write chainId. */
function entryOn(value: unknown, chainId: number): Record<string, unknown> | undefined {
  const entry = asRecord(value)
  if (!entry) return undefined
  return entry.chainId === undefined || Number(entry.chainId) === chainId ? entry : undefined
}

function asBlock(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim())
  return undefined
}

/**
 * Reads one core entry plus, on Sepolia, "sepoliaAIArbiter". Never throws.
 * Pass `{ key: 'mezoTestnet', chainId: 31611 }` for the Mezo deploy. Default is the Tokyo Sepolia record.
 */
export function parseDeployments(raw: unknown, selector?: { key: string; chainId: number }): Deployments {
  const root = asRecord(raw)
  const key = selector?.key ?? 'sepolia'
  const chainId = selector?.chainId ?? SEPOLIA_CHAIN_ID
  const core = entryOn(root?.[key], chainId)
  const ai = selector ? undefined : entryOn(root?.sepoliaAIArbiter, SEPOLIA_CHAIN_ID)
  return {
    rentEscrow: asAddress(core?.rentEscrow),
    leaseShare1155: asAddress(core?.leaseShare1155),
    humanGate: asAddress(core?.humanGate),
    token: asAddress(core?.token),
    arbiter: asAddress(core?.arbiter),
    aiArbiter: asAddress(ai?.aiArbiter),
    aiFromBlock: ai ? asBlock(ai.fromBlock) : undefined,
    demoLandlord: asAddress(core?.demoLandlord),
  }
}

/** VITE_* overrides, already parsed with asAddress. */
export type EnvAddresses = {
  escrow?: Address
  leaseShare?: Address
  token?: Address
  aiArbiter?: Address
}

export type ConfiguredContracts = {
  escrow?: Address
  leaseShare?: Address
  token?: Address
  /** Hints until the escrow is read: RentEscrow.humanGate() / arbiter() are the source of truth. */
  humanGate?: Address
  arbiter?: Address
  aiArbiter?: Address
  aiFromBlock?: bigint
}

/**
 * Env wins over deployments.json. The record's leaseShare / token / humanGate / arbiter describe the recorded
 * escrow, so they're dropped when VITE_ESCROW_ADDRESS points somewhere else; likewise the record's fromBlock
 * belongs to the recorded AIArbiter only.
 */
export function resolveContracts(env: EnvAddresses, deployed: Deployments): ConfiguredContracts {
  const same = (a: Address | undefined, b: Address | undefined) => !!a && !!b && isAddressEqual(a, b)
  const escrow = env.escrow ?? deployed.rentEscrow
  const recordedEscrow = !env.escrow || same(env.escrow, deployed.rentEscrow)
  const aiArbiter = env.aiArbiter ?? deployed.aiArbiter
  return {
    escrow,
    leaseShare: env.leaseShare ?? (recordedEscrow ? deployed.leaseShare1155 : undefined),
    token: env.token ?? (recordedEscrow ? deployed.token : undefined),
    humanGate: recordedEscrow ? deployed.humanGate : undefined,
    arbiter: recordedEscrow ? deployed.arbiter : undefined,
    aiArbiter,
    aiFromBlock: same(aiArbiter, deployed.aiArbiter) ? deployed.aiFromBlock : undefined,
  }
}
