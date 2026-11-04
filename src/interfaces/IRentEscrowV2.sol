// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRentEscrowV2
/// @notice The Wave-2 rental escrow: everything IRentEscrow does (non-custodial prepaid rent in
///         MUSD on Mezo, per-period release to the landlord, deposit back at the end, fixed-arbiter
///         disputes), plus the three Wave-2 additions:
///
///           borrow-and-fund in one transaction  {borrowAndFund} / {withdrawAndFund} relay a
///                tenant-signed Mezo Borrow trove operation and fund the lease with the MUSD it
///                sends to the escrow (no second transaction, no MUSD balance needed up front);
///           mutual early termination            {proposeTermination} / {withdrawTermination} /
///                {acceptTermination} settle an active lease by agreement: earned-but-unclaimed
///                rent plus an agreed penalty to the landlord, everything else to the tenant;
///           dispute timeout                      {resolveByTimeout} lets anyone end a dispute the
///                arbiter has left open longer than the immutable disputeTimeout: earned rent
///                (as of the dispute) to the landlord, everything else to the tenant.
///
///         This interface intentionally does NOT extend IRentEscrow: TenantStats gains fields
///         (leasesTerminatedEarly, leasesDefaulted), and a struct cannot be re-declared in a
///         derived interface, so V2 restates the V1 surface verbatim with those changes. Lifecycle
///         and invariants are IRentEscrow's, with INV-4 generalized: a resolution (arbiter ruling,
///         dispute timeout, accepted mutual termination or a default claim) pays out exactly the
///         lease's remaining escrow. New invariants cover the funding paths and the unbooked pot:
///         INV-5  a lease is only ever booked as funded with at least the MUSD its terms require
///                (a prepaid lease: deposit + every period's rent; a monthly lease: deposit + the
///                first period's rent at funding, then exactly count periods' rent per payRent),
///                and never with more than arrived: any surplus is refunded to the tenant in the
///                same transaction;
///         INV-6  totalEscrowed always equals the sum of every lease's escrowBalance, and the
///                escrow's token balance is never below it: the unbooked MUSD (balance -
///                totalEscrowed) is what the arbiter may hand back via returnUnbooked.
///
///         On top of the three Wave-2 additions above, a landlord may create a lease as MONTHLY
///         ({createLeaseMonthly}): funding covers the deposit plus ONE period's rent, and the
///         tenant tops up period by period with {payRent} (an MUSD transferFrom) or
///         {withdrawAndPayRent} (a Mezo WithdrawMUSD signature that mints the rent straight out of
///         the tenant's trove — "rent paid from your bitcoin, month by month, without selling it").
///         Rent can only be released for funded periods, and a tenant who stops paying defaults
///         after a grace of one full period: {claimDefault} then gives the landlord the funded
///         unclaimed rent plus at most ONE period's rent out of the deposit, and the tenant the
///         rest of the deposit.
interface IRentEscrowV2 {
    enum State {
        NONE,
        CREATED,
        ACTIVE,
        DISPUTED,
        CLOSED,
        CANCELLED
    }

    struct Lease {
        address landlord;
        address tenant;
        uint128 deposit; // token units (MUSD on Mezo: 18 decimals)
        uint128 rentPerPeriod; // token units
        uint32 periodSeconds; // >= MIN_PERIOD; short periods make a live demo possible
        uint16 periods; // lease term, in periods
        uint16 periodsClaimed; // rent periods already released to the landlord
        uint16 periodsFunded; // rent periods paid into the escrow (a prepaid lease: == periods)
        uint64 startTime; // set when the tenant funds
        bool monthly; // pay-monthly: funding covers deposit + one period, topped up by payRent
        State state;
    }

    /// @notice An open mutual-termination offer. At most one per lease: a new proposal replaces it.
    struct Termination {
        address proposer; // the tenant or the landlord who signed the offer
        uint128 penaltyToLandlord; // MUSD the tenant gives up on top of earned rent
        uint64 expiry; // the other party must accept strictly before this timestamp
    }

    /// @notice Per-tenant track record, read by RentOuts' ENS credential sync (rentouts.* records).
    struct TenantStats {
        uint32 leasesFunded;
        uint32 leasesCompleted; // closed normally (no dispute, no early termination)
        uint32 leasesDisputed; // disputes opened on this tenant's leases (by either party)
        uint32 leasesTerminatedEarly; // ended by an accepted mutual termination
        uint32 leasesDefaulted; // monthly leases ended by claimDefault (the tenant stopped paying)
        uint32 periodsPaid; // rent periods released to landlords
        uint128 rentPaid; // token units released to landlords
        uint128 depositsPosted; // token units of deposit posted on leases that have ended
        uint128 depositsReturned; // token units of deposit returned to the tenant
    }

    event LeaseCreated(
        uint256 indexed leaseId,
        address indexed landlord,
        address indexed tenant,
        uint128 deposit,
        uint128 rentPerPeriod,
        uint32 periodSeconds,
        uint16 periods
    );
    /// @dev Same terms as LeaseCreated, but for a monthly lease (createLeaseMonthly): funding will
    ///      cover deposit + one period's rent, topped up later by payRent / withdrawAndPayRent.
    event LeaseCreatedMonthly(
        uint256 indexed leaseId,
        address indexed landlord,
        address indexed tenant,
        uint128 deposit,
        uint128 rentPerPeriod,
        uint32 periodSeconds,
        uint16 periods
    );
    event LeaseFunded(uint256 indexed leaseId, address indexed tenant, uint256 amount, uint64 startTime);
    /// @dev Emitted by the borrow/withdraw funding paths (borrowAndFund, withdrawAndFund,
    ///      withdrawAndPayRent) in addition to LeaseFunded / RentPaid.
    event LeaseBorrowFunded(
        uint256 indexed leaseId, address indexed tenant, uint256 debt, uint256 received, uint256 refund
    );
    /// @dev A monthly lease's rent was paid in: payRent or withdrawAndPayRent.
    event RentPaid(uint256 indexed leaseId, address indexed payer, uint16 count, uint256 amount);
    /// @dev A monthly lease was closed by claimDefault: the landlord took the funded unclaimed rent
    ///      plus `depositForfeit` out of the deposit; the tenant the rest of the deposit.
    event LeaseDefaulted(
        uint256 indexed leaseId,
        address indexed landlord,
        uint256 rentToLandlord,
        uint256 depositForfeit,
        uint256 toTenant
    );
    event RentClaimed(uint256 indexed leaseId, address indexed landlord, uint16 periods, uint256 amount);
    event LeaseClosed(uint256 indexed leaseId, address indexed tenant, uint256 toTenant, uint256 toLandlord);
    event LeaseCancelled(uint256 indexed leaseId);
    event DisputeOpened(uint256 indexed leaseId, address indexed by);
    event DisputeResolved(uint256 indexed leaseId, uint16 tenantBps, uint256 toTenant, uint256 toLandlord);
    /// @dev A dispute ended by the timeout instead of an arbiter ruling.
    event DisputeTimedOut(uint256 indexed leaseId, address indexed caller, uint256 toTenant, uint256 toLandlord);
    event TerminationProposed(
        uint256 indexed leaseId, address indexed proposer, uint128 penaltyToLandlord, uint64 expiry
    );
    event TerminationWithdrawn(uint256 indexed leaseId, address indexed proposer);
    event TerminationAccepted(
        uint256 indexed leaseId, address indexed acceptedBy, uint256 toTenant, uint256 toLandlord
    );
    /// @dev The arbiter returned unbooked MUSD (see returnUnbooked) to `to`.
    event UnbookedReturned(address indexed to, uint256 amount);

    error InvalidTerms();
    error InvalidState(uint256 leaseId, State state);
    error NotLandlord(uint256 leaseId);
    error NotTenant(uint256 leaseId);
    error NotParty(uint256 leaseId);
    error NotArbiter();
    error NothingToClaim(uint256 leaseId);
    error TermNotOver(uint256 leaseId);
    error InvalidBps(uint16 bps);
    error NotVerifiedHuman(address account);
    /// @notice borrowerOpsSignatures is address(0): the borrow/withdraw funding paths are disabled.
    error MezoDisabled();
    /// @notice The trove operation sent the escrow less MUSD than the lease requires.
    error InsufficientBorrowed(uint256 leaseId, uint256 received, uint256 owed);
    /// @notice Constructor argument disputeTimeout was zero.
    error ZeroDisputeTimeout();
    /// @notice resolveByTimeout called before disputeOpenedAt + disputeTimeout.
    error DisputeNotTimedOut(uint256 leaseId);
    /// @notice No open termination proposal on the lease (never proposed, or withdrawn/consumed).
    error NoProposal(uint256 leaseId);
    /// @notice withdrawTermination called by anyone but the proposer.
    error NotProposer(uint256 leaseId);
    /// @notice acceptTermination called at or after the proposal's expiry.
    error ProposalExpired(uint256 leaseId);
    /// @notice acceptTermination's termsHash does not hash the stored proposal.
    error WrongTermsHash(uint256 leaseId);
    /// @notice The party that proposed a termination cannot also accept it.
    error ProposerCannotAccept(uint256 leaseId);
    /// @notice proposeTermination with an expiry that is not in the future.
    error InvalidExpiry(uint256 leaseId, uint64 expiry);
    /// @notice The penalty exceeds the tenant's side (unearned rent + deposit); checked at propose
    ///         and re-checked at accept (time passes, the tenant side shrinks).
    error PenaltyTooHigh(uint256 leaseId, uint256 penalty, uint256 tenantSide);
    /// @notice returnUnbooked asked for more MUSD than the unbooked pot holds. The arbiter can
    ///         never touch any lease's escrow, only the balance beyond totalEscrowed.
    error InsufficientUnbooked(uint256 requested, uint256 available);
    /// @notice The action only exists for monthly leases (payRent, withdrawAndPayRent,
    ///         claimDefault): a prepaid lease is fully funded the moment it starts.
    error NotMonthly(uint256 leaseId);
    /// @notice payRent / withdrawAndPayRent with nothing left to fund: every period of the lease is
    ///         already paid in (count was zero, or capped to zero against the unfunded remainder).
    error RentFullyFunded(uint256 leaseId);
    /// @notice closeLease on a monthly lease that is not fully funded: the landlord should let the
    ///         term run and use claimDefault instead once the tenant misses a period past the grace.
    error RentNotFullyFunded(uint256 leaseId, uint16 funded, uint16 required);
    /// @notice claimDefault before the default is due: an unfunded period must be overdue by more
    ///         than the grace (one full periodSeconds), i.e. before `dueAt`. Also fires for a fully
    ///         funded monthly lease (dueAt is then endTime + periodSeconds, past which closeLease,
    ///         not claimDefault, is the way out).
    error NotDefaulted(uint256 leaseId, uint256 dueAt);
    /// @notice A non-zero BTC transfer to the escrow. The escrow never holds BTC on purpose (its
    ///         asset is MUSD), so there would be no way to spend it: it bounces back to the sender.
    ///         Mezo's trove code does send the escrow one BTC transfer — always with value zero.
    error StrayBtc(uint256 amount);

    // ------------------------------------------------------------------ config (immutable)

    function token() external view returns (address);
    function arbiter() external view returns (address);
    /// @notice LeaseShare1155 (Curvegrid RWA) or address(0) if disabled. createLease mints
    ///         SHARES_PER_LEASE shares of tokenId == leaseId to the landlord; the landlord must be
    ///         allowlisted there (compliance-aware listing).
    function leaseShare() external view returns (address);
    /// @notice IHumanGate consulted by every funding path (fundLease, borrowAndFund,
    ///         withdrawAndFund, payRent, withdrawAndPayRent), or address(0) if funding is not
    ///         gated at all.
    function humanGate() external view returns (address);
    /// @notice Mezo's BorrowerOperationsSignatures, relayed by borrowAndFund / withdrawAndFund, or
    ///         address(0) to disable both (they then revert MezoDisabled).
    function borrowerOpsSignatures() external view returns (address);
    /// @notice Seconds after a dispute opens before anyone may call resolveByTimeout. Immutable,
    ///         always > 0.
    function disputeTimeout() external view returns (uint64);
    function SHARES_PER_LEASE() external view returns (uint256);
    function MIN_PERIOD() external view returns (uint32);

    // ------------------------------------------------------------------ views

    function nextLeaseId() external view returns (uint256);
    function getLease(uint256 leaseId) external view returns (Lease memory);
    function escrowBalance(uint256 leaseId) external view returns (uint256);
    /// @notice Sum of every lease's escrowBalance: the MUSD that belongs to leases (INV-6). The
    ///         token balance beyond this is the unbooked pot (see unbookedBalance / returnUnbooked).
    function totalEscrowed() external view returns (uint256);
    /// @notice The escrow's token balance that belongs to no lease: what a front-run relay, a
    ///         mistaken or a plain transfer left behind, and what returnUnbooked may hand back.
    function unbookedBalance() external view returns (uint256);
    function tenantStats(address tenant) external view returns (TenantStats memory);
    /// @notice Rent periods elapsed but not yet released, and their amount.
    function claimable(uint256 leaseId) external view returns (uint16 periods, uint256 amount);
    /// @notice startTime + periods * periodSeconds (0 before funding).
    function endTime(uint256 leaseId) external view returns (uint64);
    /// @notice The open mutual-termination proposal, or a zeroed Termination if there is none.
    function termination(uint256 leaseId) external view returns (Termination memory);
    /// @notice When the lease's dispute was opened (0 if never).
    function disputeOpenedAt(uint256 leaseId) external view returns (uint64);

    // ------------------------------------------------------------------ actions

    /// @notice Landlord (msg.sender) proposes a lease to `tenant`. Leases are numbered from 1.
    function createLease(address tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods)
        external
        returns (uint256 leaseId);

    /// @notice Same terms as createLease, but pay-monthly: funding (any of fundLease, borrowAndFund,
    ///         withdrawAndFund) covers deposit + ONE period's rent and sets periodsFunded = 1; the
    ///         tenant then pays each further period with payRent / withdrawAndPayRent. The term,
    ///         endTime and the release of rent to the landlord (claimable, capped at periodsFunded)
    ///         are exactly the prepaid lease's.
    function createLeaseMonthly(
        address tenant,
        uint128 deposit,
        uint128 rentPerPeriod,
        uint32 periodSeconds,
        uint16 periods
    ) external returns (uint256 leaseId);

    /// @notice Landlord withdraws an unfunded lease. CREATED -> CANCELLED.
    function cancelLease(uint256 leaseId) external;

    /// @notice Tenant prepays deposit + rentPerPeriod * periods (needs token approval). CREATED -> ACTIVE.
    ///         If humanGate is set, reverts NotVerifiedHuman unless humanGate.isVerified(tenant).
    function fundLease(uint256 leaseId) external;

    /// @notice Tenant (msg.sender) funds the lease by opening their own Mezo trove in the same
    ///         transaction: the escrow relays `signature` to BorrowerOperationsSignatures with
    ///         borrower = msg.sender, recipient = the escrow and BTC collateral = msg.value. The
    ///         signature must cover exactly those values (assetAmount = msg.value, debtAmount,
    ///         borrower, recipient, nonce, deadline). The escrow measures the MUSD it actually
    ///         received, reverts InsufficientBorrowed if it is less than deposit + all rent, books
    ///         the lease exactly like fundLease and refunds any surplus to the tenant. CREATED -> ACTIVE.
    ///         Reverts MezoDisabled if borrowerOpsSignatures is address(0).
    ///
    ///         Front-running: BorrowerOperationsSignatures does not restrict who submits a
    ///         signature, so a watcher can copy a tenant's pending signature and relay it to Mezo
    ///         directly, with recipient = this escrow. The tenant's nonce is spent and their trove
    ///         debt grows, but no lease is booked; the tenant's own borrowAndFund then reverts (the
    ///         nonce is used). Nothing is lost: the tenant can always fall back to fundLease (or
    ///         sign a fresh operation), and the minted MUSD sits in unbookedBalance() until the
    ///         arbiter returns it with returnUnbooked to whoever the Mezo event logs show it
    ///         belongs to. The escrow itself never books unbooked MUSD into a lease: funding always
    ///         books exactly the lease's owed amount.
    function borrowAndFund(
        uint256 leaseId,
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    /// @notice Same as borrowAndFund for a tenant who already has a trove: the escrow relays a
    ///         WithdrawMUSD signature (borrower = msg.sender, recipient = the escrow) that mints
    ///         `amount` of new MUSD against the tenant's trove and sends it here. Not payable.
    ///         Mezo settles the trove's collateral delta with a BTC transfer to the caller — zero
    ///         here, which is why the escrow has a receive() that accepts only value-zero BTC
    ///         transfers (see StrayBtc). Subject to the same front-running as borrowAndFund, with
    ///         the same fallback (fundLease) and the same recovery (returnUnbooked).
    function withdrawAndFund(
        uint256 leaseId,
        uint256 amount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external;

    /// @notice Releases every elapsed, unclaimed rent period to the landlord, capped at the funded
    ///         periods (a monthly lease only releases rent that was actually paid in). Callable by
    ///         anyone (funds can only go to the landlord). ACTIVE only; frozen while DISPUTED.
    function claimRent(uint256 leaseId) external;

    /// @notice The tenant pays `count` further rent periods of an ACTIVE monthly lease up front,
    ///         pulling count * rentPerPeriod (needs token approval); periodsFunded grows by count
    ///         and never past `periods` (a larger count is capped to the unfunded remainder, a zero
    ///         one — or a capped-to-zero one — reverts RentFullyFunded). Monthly leases only: a
    ///         prepaid lease reverts NotMonthly (it is fully funded from the start).
    function payRent(uint256 leaseId, uint16 count) external;

    /// @notice payRent through the tenant's Mezo trove: the escrow relays a WithdrawMUSD signature
    ///         (borrower = msg.sender, recipient = the escrow) that mints `amount` of new MUSD
    ///         against the tenant's trove and sends it here. The count is capped like payRent's;
    ///         the measured MUSD delta must cover count * rentPerPeriod (InsufficientBorrowed
    ///         otherwise) and any surplus is refunded to the tenant in the same transaction.
    ///         Mezo's zero-value BTC touch to the caller works through receive() (see StrayBtc).
    ///         Reverts MezoDisabled if borrowerOpsSignatures is address(0), NotMonthly for prepaid
    ///         leases. Subject to the same front-running as withdrawAndFund, with the same fallback
    ///         (payRent) and the same recovery (returnUnbooked).
    function withdrawAndPayRent(
        uint256 leaseId,
        uint16 count,
        uint256 amount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external;

    /// @notice The landlord closes a monthly lease whose tenant stopped paying. A period i (0-based)
    ///         is due at startTime + i * periodSeconds; the lease is in default once
    ///         block.timestamp >= startTime + periodsFunded * periodSeconds + periodSeconds (the
    ///         grace is one full period of that lease) while periodsFunded < periods. Split: the
    ///         landlord takes the funded-but-unclaimed rent plus at most ONE period's rent out of
    ///         the deposit (capped at the deposit), the tenant the rest of the deposit; the lease
    ///         goes CLOSED and the tenant's stats count leasesDefaulted. ACTIVE, monthly, landlord
    ///         only; reverts NotDefaulted before the boundary (a fully funded lease never defaults).
    function claimDefault(uint256 leaseId) external;

    /// @notice After the term: remaining rent to the landlord, deposit to the tenant. ACTIVE -> CLOSED.
    ///         The landlord may close as soon as the term ends; anyone may close one period later
    ///         (the grace period gives the landlord time to open a dispute over the deposit).
    ///         A monthly lease must be fully funded (periodsFunded == periods, RentNotFullyFunded
    ///         otherwise): an underfunded lease past its due date is the landlord's claimDefault.
    function closeLease(uint256 leaseId) external;

    /// @notice Tenant or landlord freezes the lease for the arbiter. ACTIVE -> DISPUTED.
    function openDispute(uint256 leaseId) external;

    /// @notice Arbiter splits the lease's remaining escrow: tenantBps/10000 to the tenant, the rest
    ///         to the landlord. DISPUTED -> CLOSED. Works at any time until someone calls
    ///         resolveByTimeout.
    function resolveDispute(uint256 leaseId, uint16 tenantBps) external;

    /// @notice Anyone may end a dispute that has outlived disputeTimeout: the landlord keeps the
    ///         rent earned when the dispute was opened but not yet claimed, the tenant gets the
    ///         rest (unearned rent + deposit). DISPUTED -> CLOSED.
    function resolveByTimeout(uint256 leaseId) external;

    /// @notice Tenant or landlord offers to end an ACTIVE lease early: the landlord receives the
    ///         earned-but-unclaimed rent plus `penaltyToLandlord`, the tenant everything else
    ///         (unearned rent + deposit - penalty). Replaces any open proposal on the lease.
    ///         `penaltyToLandlord` must not exceed the tenant's side (unearned rent + deposit).
    function proposeTermination(uint256 leaseId, uint128 penaltyToLandlord, uint64 expiry) external;

    /// @notice The proposer takes their open proposal off the table.
    function withdrawTermination(uint256 leaseId) external;

    /// @notice The other party accepts before `expiry`, confirming the exact terms by hash:
    ///         termsHash == keccak256(abi.encode(leaseId, proposer, penaltyToLandlord, expiry)).
    ///         Settles the escrow and moves the lease to CLOSED; counts as leasesTerminatedEarly.
    function acceptTermination(uint256 leaseId, bytes32 termsHash) external;

    /// @notice The arbiter returns unbooked MUSD — the escrow's token balance beyond totalEscrowed,
    ///         i.e. MUSD that belongs to no lease (a front-run relay's mint, a mistaken or a plain
    ///         transfer) — to `to`, chosen from what the Mezo event logs (or the transfer itself)
    ///         show the MUSD belongs to. The arbiter can never touch any lease's escrow: the
    ///         payment is capped at unbookedBalance() (InsufficientUnbooked). This is the one
    ///         arbiter power that is not a dispute ruling, and it moves no lease's funds.
    function returnUnbooked(address to, uint256 amount) external;
}
