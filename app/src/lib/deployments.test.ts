import { describe, expect, it } from 'vitest'
import { musdAbi } from '../abi/musd'
import { MEZO_CHAIN_ID } from '../network'
import { asAddress, parseDeployments, resolveContracts } from './deployments'

// The shapes script/DeployEscrow.s.sol and script/DeployAIArbiter.s.sol write (addresses lower-cased, as vm.serializeAddress does).
const file = {
  baseSepolia: { chainId: 84532, LeaseShare1155: { address: '0x5490e5dFcDcA741aC99127f66B4abf6204cd64C5' } },
  sepolia: {
    chainId: 11155111,
    deployer: '0xdd9c17ecae9301b67de17f1ba2b5084eac59ccce',
    token: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    arbiter: '0x3333333333333333333333333333333333333333',
    humanGate: '0x4444444444444444444444444444444444444444',
    leaseShare1155: '0x5555555555555555555555555555555555555555',
    rentEscrow: '0x6666666666666666666666666666666666666666',
  },
  sepoliaAIArbiter: {
    chainId: 11155111,
    deployer: '0xdd9c17ecae9301b67de17f1ba2b5084eac59ccce',
    human: '0x798b01cef62b889943ce1d3c5011a755b297e486',
    agent: '0x4a444685f3e700d0d5b8fe53d987f8029cced0da',
    challengeWindow: 120,
    fromBlock: 11800000,
    aiArbiter: '0x3333333333333333333333333333333333333333',
  },
}

describe('asAddress', () => {
  it('checksums valid addresses and drops everything else', () => {
    expect(asAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238')).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
    expect(asAddress(' 0x1c7d4b196cb0c7b01d743fbc6116a902379c7238 ')).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
    expect(asAddress('0x0000000000000000000000000000000000000000')).toBeUndefined()
    expect(asAddress('0x1234')).toBeUndefined()
    expect(asAddress(42)).toBeUndefined()
    expect(asAddress(undefined)).toBeUndefined()
  })
})

describe('parseDeployments', () => {
  it('reads both script entries', () => {
    expect(parseDeployments(file)).toEqual({
      rentEscrow: '0x6666666666666666666666666666666666666666',
      leaseShare1155: '0x5555555555555555555555555555555555555555',
      humanGate: '0x4444444444444444444444444444444444444444',
      token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      arbiter: '0x3333333333333333333333333333333333333333',
      aiArbiter: '0x3333333333333333333333333333333333333333',
      aiFromBlock: 11_800_000n,
    })
  })

  it('degrades to nothing when the file or an entry is missing', () => {
    const empty = parseDeployments(undefined)
    expect(Object.values(empty).every((v) => v === undefined)).toBe(true)
    expect(parseDeployments({ baseSepolia: file.baseSepolia }).rentEscrow).toBeUndefined()
    expect(parseDeployments({ sepolia: file.sepolia }).aiArbiter).toBeUndefined()
    expect(parseDeployments({ sepoliaAIArbiter: file.sepoliaAIArbiter }).rentEscrow).toBeUndefined()
    expect(parseDeployments('nope').rentEscrow).toBeUndefined()
    expect(parseDeployments([file]).rentEscrow).toBeUndefined()
  })

  it('ignores entries for another chain and malformed values', () => {
    expect(parseDeployments({ sepolia: { ...file.sepolia, chainId: 84532 } }).rentEscrow).toBeUndefined()
    const bad = parseDeployments({ sepolia: { ...file.sepolia, rentEscrow: 'not an address' }, sepoliaAIArbiter: { ...file.sepoliaAIArbiter, fromBlock: -5 } })
    expect(bad.rentEscrow).toBeUndefined()
    expect(bad.leaseShare1155).toBe('0x5555555555555555555555555555555555555555')
    expect(bad.aiFromBlock).toBeUndefined()
    expect(parseDeployments({ sepoliaAIArbiter: { ...file.sepoliaAIArbiter, fromBlock: '12' } }).aiFromBlock).toBe(12n)
  })
})

describe('resolveContracts', () => {
  const deployed = parseDeployments(file)
  const other = '0x7777777777777777777777777777777777777777'

  it('uses deployments.json when no env var is set', () => {
    expect(resolveContracts({}, deployed)).toEqual({
      escrow: deployed.rentEscrow,
      leaseShare: deployed.leaseShare1155,
      token: deployed.token,
      humanGate: deployed.humanGate,
      arbiter: deployed.arbiter,
      aiArbiter: deployed.aiArbiter,
      aiFromBlock: 11_800_000n,
    })
  })

  it('lets VITE_* env vars win', () => {
    const r = resolveContracts({ leaseShare: other, token: other, aiArbiter: other }, deployed)
    expect(r).toMatchObject({ escrow: deployed.rentEscrow, leaseShare: other, token: other, aiArbiter: other })
    // fromBlock belongs to the recorded AIArbiter only
    expect(r.aiFromBlock).toBeUndefined()
  })

  it('drops the recorded escrow’s satellites when the env points at another escrow', () => {
    const r = resolveContracts({ escrow: other }, deployed)
    expect(r).toMatchObject({ escrow: other, leaseShare: undefined, token: undefined, humanGate: undefined, arbiter: undefined })
    expect(r.aiArbiter).toBe(deployed.aiArbiter)
    // …but keeps them when the env names the recorded escrow itself
    expect(resolveContracts({ escrow: deployed.rentEscrow }, deployed).humanGate).toBe(deployed.humanGate)
  })

  it('is empty with nothing deployed and nothing set', () => {
    expect(Object.values(resolveContracts({}, parseDeployments(undefined))).every((v) => v === undefined)).toBe(true)
  })
})

describe('mezoTestnet entry', () => {
  const musd = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503'
  const raw = {
    ...file,
    mezoTestnet: {
      chainId: MEZO_CHAIN_ID,
      rentEscrow: file.sepolia.rentEscrow,
      token: musd,
      leaseShare1155: file.sepolia.leaseShare1155,
    },
  }

  it('stays off the default Sepolia parse', () => {
    expect(parseDeployments(raw).token).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
  })

  it('reads mezoTestnet when selected and does not pull the Sepolia AI arbiter', () => {
    const parsed = parseDeployments(raw, { key: 'mezoTestnet', chainId: MEZO_CHAIN_ID })
    expect(parsed.token).toBe(musd)
    expect(parsed.rentEscrow).toBe('0x6666666666666666666666666666666666666666')
    expect(parsed.aiArbiter).toBeUndefined()
  })

  it('reads the DemoLandlord when recorded, and only from the selected entry', () => {
    const demo = '0x6621dE90776302aD1a3C0190141f9169B4A0112B'
    const withDemo = { ...raw, mezoTestnet: { ...raw.mezoTestnet, demoLandlord: demo.toLowerCase() } }
    expect(parseDeployments(withDemo, { key: 'mezoTestnet', chainId: MEZO_CHAIN_ID }).demoLandlord).toBe(demo)
    expect(parseDeployments(withDemo).demoLandlord).toBeUndefined()
  })
})

describe('mezoTestnetV2 entry (the Wave-2 deploy)', () => {
  const musd = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503'
  const signatures = '0xD757e3646AF370b15f32EB557F0F8380Df7D639e'
  const escrowV2 = '0xdD4A5747d336Bb6653a5430d87CdaAc89dd9113e'
  const arbiter = '0x1da334A5FaB59a741fDAE7f081c7f592027b3106'
  const raw = {
    ...file,
    mezoTestnet: {
      chainId: MEZO_CHAIN_ID,
      rentEscrow: file.sepolia.rentEscrow,
      demoLandlord: '0x6621de90776302ad1a3c0190141f9169b4a0112b',
    },
    mezoTestnetV2: {
      chainId: MEZO_CHAIN_ID,
      rentEscrowV2: escrowV2,
      token: musd.toLowerCase(),
      arbiter: arbiter.toLowerCase(),
      borrowerOpsSignatures: signatures.toLowerCase(),
      disputeTimeout: 600,
      leaseShare1155: file.sepolia.leaseShare1155,
    },
  }

  it('with v2: true reads the escrow under rentEscrowV2 plus the Wave-2 fields', () => {
    const parsed = parseDeployments(raw, { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID, v2: true })
    expect(parsed.rentEscrow).toBe(escrowV2)
    expect(parsed.token).toBe(musd)
    expect(parsed.arbiter).toBe(arbiter)
    expect(parsed.borrowerOpsSignatures).toBe(signatures)
    expect(parsed.disputeTimeout).toBe(600)
    // The V1 demo landlord is not the V2 entry's, so it must not leak into the active parse.
    expect(parsed.demoLandlord).toBeUndefined()
  })

  it('without v2 the entry keeps rentEscrowV2 apart from rentEscrow (and reads no Wave-2 fields)', () => {
    const parsed = parseDeployments(raw, { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID })
    expect(parsed.rentEscrow).toBeUndefined()
    expect(parsed.borrowerOpsSignatures).toBeUndefined()
    expect(parsed.disputeTimeout).toBeUndefined()
  })

  it('degrades when the Wave-2 fields are missing or malformed', () => {
    const thin = parseDeployments(
      { mezoTestnetV2: { chainId: MEZO_CHAIN_ID, rentEscrowV2: escrowV2 } },
      { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID, v2: true },
    )
    expect(thin.rentEscrow).toBe(escrowV2)
    expect(thin.borrowerOpsSignatures).toBeUndefined()
    expect(thin.disputeTimeout).toBeUndefined()

    const malformed = parseDeployments(
      { mezoTestnetV2: { chainId: MEZO_CHAIN_ID, rentEscrowV2: 'nope', disputeTimeout: -5 } },
      { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID, v2: true },
    )
    expect(malformed.rentEscrow).toBeUndefined()
    expect(malformed.disputeTimeout).toBeUndefined()
  })

  it('ignores a V2 entry recorded for another chain', () => {
    const other = parseDeployments(
      { mezoTestnetV2: { ...raw.mezoTestnetV2, chainId: 31_612 } },
      { key: 'mezoTestnetV2', chainId: MEZO_CHAIN_ID, v2: true },
    )
    expect(other.rentEscrow).toBeUndefined()
  })
})

describe('MUSD abi', () => {
  it('includes the ERC-20 calls the checkout makes', () => {
    const names = musdAbi.flatMap((item) => (item.type === 'function' && item.name ? [item.name] : []))
    expect(names).toEqual(expect.arrayContaining(['decimals', 'symbol', 'balanceOf', 'allowance', 'approve']))
  })
})
