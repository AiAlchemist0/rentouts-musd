import { parseAbi, type Address } from 'viem'

/**
 * RentEscrowV2, transcribed from src/interfaces/IRentEscrowV2.sol (checked against
 * out/RentEscrowV2.sol/RentEscrowV2.json from `forge build`). It restates the V1 surface verbatim
 * (same State enum: NONE, CREATED, ACTIVE, DISPUTED, CLOSED, CANCELLED) with the Wave-2 additions:
 * the Lease struct gains periodsFunded and monthly (pay-monthly leases), TenantStats gains
 * leasesTerminatedEarly and leasesDefaulted, borrowAndFund / withdrawAndFund relay a tenant-signed
 * Mezo trove operation, proposeTermination / acceptTermination settle a lease by agreement,
 * resolveByTimeout ends an abandoned dispute after the immutable disputeTimeout, and payRent /
 * withdrawAndPayRent / claimDefault run the pay-monthly top-up and default rule.
 * The Mezo build talks to this ABI; the Sepolia build stays on rentEscrowAbi (see activeEscrowAbi).
 */
export const rentEscrowV2Abi = parseAbi([
  'struct Lease { address landlord; address tenant; uint128 deposit; uint128 rentPerPeriod; uint32 periodSeconds; uint16 periods; uint16 periodsClaimed; uint16 periodsFunded; uint64 startTime; bool monthly; uint8 state; }',
  'struct TenantStats { uint32 leasesFunded; uint32 leasesCompleted; uint32 leasesDisputed; uint32 leasesTerminatedEarly; uint32 leasesDefaulted; uint32 periodsPaid; uint128 rentPaid; uint128 depositsPosted; uint128 depositsReturned; }',
  'struct Termination { address proposer; uint128 penaltyToLandlord; uint64 expiry; }',

  'event LeaseCreated(uint256 indexed leaseId, address indexed landlord, address indexed tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods)',
  'event LeaseCreatedMonthly(uint256 indexed leaseId, address indexed landlord, address indexed tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods)',
  'event LeaseFunded(uint256 indexed leaseId, address indexed tenant, uint256 amount, uint64 startTime)',
  'event LeaseBorrowFunded(uint256 indexed leaseId, address indexed tenant, uint256 debt, uint256 received, uint256 refund)',
  'event RentPaid(uint256 indexed leaseId, address indexed payer, uint16 count, uint256 amount)',
  'event LeaseDefaulted(uint256 indexed leaseId, address indexed landlord, uint256 rentToLandlord, uint256 depositForfeit, uint256 toTenant)',
  'event RentClaimed(uint256 indexed leaseId, address indexed landlord, uint16 periods, uint256 amount)',
  'event LeaseClosed(uint256 indexed leaseId, address indexed tenant, uint256 toTenant, uint256 toLandlord)',
  'event LeaseCancelled(uint256 indexed leaseId)',
  'event DisputeOpened(uint256 indexed leaseId, address indexed by)',
  'event DisputeResolved(uint256 indexed leaseId, uint16 tenantBps, uint256 toTenant, uint256 toLandlord)',
  'event DisputeTimedOut(uint256 indexed leaseId, address indexed caller, uint256 toTenant, uint256 toLandlord)',
  'event TerminationProposed(uint256 indexed leaseId, address indexed proposer, uint128 penaltyToLandlord, uint64 expiry)',
  'event TerminationWithdrawn(uint256 indexed leaseId, address indexed proposer)',
  'event TerminationAccepted(uint256 indexed leaseId, address indexed acceptedBy, uint256 toTenant, uint256 toLandlord)',
  'event UnbookedReturned(address indexed to, uint256 amount)',

  'error InvalidTerms()',
  'error InvalidState(uint256 leaseId, uint8 state)',
  'error NotLandlord(uint256 leaseId)',
  'error NotTenant(uint256 leaseId)',
  'error NotParty(uint256 leaseId)',
  'error NotArbiter()',
  'error NothingToClaim(uint256 leaseId)',
  'error TermNotOver(uint256 leaseId)',
  'error InvalidBps(uint16 bps)',
  'error NotVerifiedHuman(address account)',
  'error MezoDisabled()',
  'error InsufficientBorrowed(uint256 leaseId, uint256 received, uint256 owed)',
  'error ZeroDisputeTimeout()',
  'error DisputeNotTimedOut(uint256 leaseId)',
  'error NoProposal(uint256 leaseId)',
  'error NotProposer(uint256 leaseId)',
  'error ProposalExpired(uint256 leaseId)',
  'error WrongTermsHash(uint256 leaseId)',
  'error ProposerCannotAccept(uint256 leaseId)',
  'error InvalidExpiry(uint256 leaseId, uint64 expiry)',
  'error PenaltyTooHigh(uint256 leaseId, uint256 penalty, uint256 tenantSide)',
  'error InsufficientUnbooked(uint256 requested, uint256 available)',
  'error NotMonthly(uint256 leaseId)',
  'error RentFullyFunded(uint256 leaseId)',
  'error RentNotFullyFunded(uint256 leaseId, uint16 funded, uint16 required)',
  'error NotDefaulted(uint256 leaseId, uint256 dueAt)',
  'error StrayBtc(uint256 amount)',
  // Thrown by the contract itself (OpenZeppelin guard, token transfers, constructor and deploy checks).
  'error HumanGateHasNoCode(address humanGate)',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error ZeroAddress()',

  'function token() view returns (address)',
  'function arbiter() view returns (address)',
  'function leaseShare() view returns (address)',
  'function humanGate() view returns (address)',
  'function borrowerOpsSignatures() view returns (address)',
  'function disputeTimeout() view returns (uint64)',
  'function SHARES_PER_LEASE() view returns (uint256)',
  'function MIN_PERIOD() view returns (uint32)',

  'function nextLeaseId() view returns (uint256)',
  'function getLease(uint256 leaseId) view returns (Lease)',
  'function escrowBalance(uint256 leaseId) view returns (uint256)',
  'function totalEscrowed() view returns (uint256)',
  'function unbookedBalance() view returns (uint256)',
  'function tenantStats(address tenant) view returns (TenantStats)',
  'function claimable(uint256 leaseId) view returns (uint16 periods, uint256 amount)',
  'function endTime(uint256 leaseId) view returns (uint64)',
  'function termination(uint256 leaseId) view returns (Termination)',
  'function disputeOpenedAt(uint256 leaseId) view returns (uint64)',

  'function createLease(address tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods) returns (uint256 leaseId)',
  'function createLeaseMonthly(address tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods) returns (uint256 leaseId)',
  'function cancelLease(uint256 leaseId)',
  'function fundLease(uint256 leaseId)',
  'function borrowAndFund(uint256 leaseId, uint256 debtAmount, address upperHint, address lowerHint, bytes signature, uint256 deadline) payable',
  'function withdrawAndFund(uint256 leaseId, uint256 amount, address upperHint, address lowerHint, bytes signature, uint256 deadline)',
  'function payRent(uint256 leaseId, uint16 count)',
  'function withdrawAndPayRent(uint256 leaseId, uint16 count, uint256 amount, address upperHint, address lowerHint, bytes signature, uint256 deadline)',
  'function claimRent(uint256 leaseId)',
  'function claimDefault(uint256 leaseId)',
  'function closeLease(uint256 leaseId)',
  'function openDispute(uint256 leaseId)',
  'function resolveDispute(uint256 leaseId, uint16 tenantBps)',
  'function resolveByTimeout(uint256 leaseId)',
  'function proposeTermination(uint256 leaseId, uint128 penaltyToLandlord, uint64 expiry)',
  'function withdrawTermination(uint256 leaseId)',
  'function acceptTermination(uint256 leaseId, bytes32 termsHash)',
  'function returnUnbooked(address to, uint256 amount)',
])

/** An open mutual-termination offer, as termination(leaseId) returns it. proposer 0x000…0 = none. */
export type TerminationRow = { proposer: Address; penaltyToLandlord: bigint; expiry: bigint }
