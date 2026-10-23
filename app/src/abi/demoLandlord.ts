import { parseAbi } from 'viem'

/** DemoLandlord (src/DemoLandlord.sol): a testnet landlord anyone can rent from. */
export const demoLandlordAbi = parseAbi([
  'function requestLease() returns (uint256 leaseId)',
  'function lastLeaseOf(address tenant) view returns (uint256)',
  'function totalDue() view returns (uint256)',
  'function deposit() view returns (uint128)',
  'function rentPerPeriod() view returns (uint128)',
  'function periodSeconds() view returns (uint32)',
  'function periods() view returns (uint16)',
  'event DemoLeaseCreated(address indexed tenant, uint256 indexed leaseId)',
])
