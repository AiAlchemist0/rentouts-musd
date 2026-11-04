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

/**
 * DemoLandlordV2 (src/DemoLandlordV2.sol), transcribed from
 * out/DemoLandlordV2.sol/DemoLandlordV2.json (`forge build`): a testnet landlord anyone can rent
 * from, prepaid or pay-monthly. requestLease(false) creates (or returns) the caller's unfunded
 * prepaid demo lease, requestLease(true) the monthly one; totalDue() is what funding a prepaid
 * lease costs, firstMonthlyDue() what a monthly lease starts with. The ERC1155Holder receiver
 * boilerplate is of no use to the app and stays out, like the V1 ABI.
 */
export const demoLandlordV2Abi = parseAbi([
  'function requestLease(bool monthly) returns (uint256 leaseId)',
  'function lastLeaseOf(address tenant) view returns (uint256 leaseId)',
  'function lastMonthlyLeaseOf(address tenant) view returns (uint256 leaseId)',
  'function totalDue() view returns (uint256)',
  'function firstMonthlyDue() view returns (uint256)',
  'function escrow() view returns (address)',
  'function deposit() view returns (uint128)',
  'function rentPerPeriod() view returns (uint128)',
  'function periodSeconds() view returns (uint32)',
  'function periods() view returns (uint16)',
  'event DemoLeaseCreated(address indexed tenant, uint256 indexed leaseId, bool indexed monthly)',
])
