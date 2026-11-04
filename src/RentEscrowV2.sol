// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRentEscrowV2} from "./interfaces/IRentEscrowV2.sol";
import {IHumanGate} from "./interfaces/IHumanGate.sol";
import {IMezoBorrowerOperationsSignatures} from "./interfaces/IMezoBorrowerOperationsSignatures.sol";
import {LeaseShare1155} from "./LeaseShare1155.sol";

/// @title RentEscrowV2
/// @notice Wave-2 non-custodial rental escrow on Mezo: the V1 lifecycle (prepaid deposit + all rent
///         in MUSD, period-by-period release to the landlord, deposit back at the end, fixed-arbiter
///         disputes) plus borrow-and-fund in one transaction, mutual early termination, a dispute
///         timeout, and pay-monthly leases drawn from the tenant's Mezo trove. See {IRentEscrowV2}
///         for the lifecycle and the invariants (INV-1..INV-6) exercised by
///         test/RentEscrowV2.invariant.t.sol.
/// @dev    No owner, no admin, no fees, no upgradeability: token, arbiter, leaseShare, humanGate,
///         borrowerOpsSignatures and disputeTimeout are immutable. RentEscrow (V1) stays deployed
///         and untouched; this contract restates its behaviour with the Wave-2 additions, and the
///         only party-independent role is still the arbiter, who can never be a lease's landlord or
///         tenant and can only split a disputed lease's own escrow between that lease's parties.
///         The three new settlement paths are stricter still: an accepted mutual termination moves
///         tokens only per terms both parties signed off on, resolveByTimeout pays a fixed,
///         pre-agreed-by-deployment split that nobody chooses at call time, and claimDefault pays a
///         split computed only from the lease's own funded terms. Mezo's relay accepts
///         signatures from anyone, so a copied signature can mint MUSD here with no lease behind
///         it: that unbooked pot is tracked apart from every lease (totalEscrowed /
///         unbookedBalance) and only the arbiter can hand it back (returnUnbooked) — never a
///         lease's own escrow.
///         MONTHLY leases (createLeaseMonthly) keep the same term, clock and claim cadence as
///         prepaid ones, but funding covers deposit + ONE period's rent and the tenant tops up with
///         payRent / withdrawAndPayRent; rent is only released for funded periods, and every split
///         (dispute, timeout, termination, default, close) is derived from escrowBalance and
///         periodsFunded, so a partially funded lease settles exactly on what it took in. A tenant
///         who lets an unfunded period run one full period (the grace) past its due date defaults:
///         claimDefault gives the landlord the funded unclaimed rent plus at most one period's rent
///         out of the deposit, the tenant the rest of the deposit.
///         humanGate (optional) is asked once, in every funding path, whether the tenant is a
///         verified human; a gate can only refuse NEW funding. The token must be a plain ERC-20
///         (no fee-on-transfer / rebasing), e.g. MUSD on Mezo.
contract RentEscrowV2 is IRentEscrowV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @inheritdoc IRentEscrowV2
    uint256 public constant SHARES_PER_LEASE = 100;
    /// @inheritdoc IRentEscrowV2
    uint32 public constant MIN_PERIOD = 60;
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @inheritdoc IRentEscrowV2
    address public immutable token;
    /// @inheritdoc IRentEscrowV2
    address public immutable arbiter;
    /// @inheritdoc IRentEscrowV2
    address public immutable leaseShare;
    /// @inheritdoc IRentEscrowV2
    address public immutable humanGate;
    /// @inheritdoc IRentEscrowV2
    address public immutable borrowerOpsSignatures;
    /// @inheritdoc IRentEscrowV2
    uint64 public immutable disputeTimeout;

    /// @inheritdoc IRentEscrowV2
    uint256 public nextLeaseId = 1;
    /// @inheritdoc IRentEscrowV2
    mapping(uint256 leaseId => uint256 amount) public escrowBalance;
    /// @inheritdoc IRentEscrowV2
    /// @dev Sum of every lease's escrowBalance (INV-6), maintained wherever escrowBalance changes.
    ///      Balance beyond it is the unbooked pot: returnUnbooked's whole world.
    uint256 public totalEscrowed;

    mapping(uint256 leaseId => Lease) internal _leases;
    mapping(address tenant => TenantStats) internal _stats;
    /// @dev Rent periods earned (elapsed, claimed or not) when the lease's dispute was opened. Rent
    ///      stops accruing then, so resolveDispute and resolveByTimeout can tell a refund of
    ///      unearned rent apart from the deposit coming back.
    mapping(uint256 leaseId => uint16 periods) internal _earnedAtDispute;
    /// @dev When each lease's dispute was opened; resolveByTimeout fires after this + disputeTimeout.
    mapping(uint256 leaseId => uint64 openedAt) internal _disputeOpenedAt;
    /// @dev The open mutual-termination proposal per lease (see the `termination` getter).
    mapping(uint256 leaseId => Termination) internal _terminations;

    /// @notice Constructor argument was the zero address (token or arbiter).
    error ZeroAddress();
    /// @notice A non-zero humanGate must be a contract: an EOA would make every funding revert.
    error HumanGateHasNoCode(address humanGate);

    /// @param token_                 escrow token (MUSD on Mezo testnet: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503)
    /// @param arbiter_               dispute arbiter: an EOA or a contract (e.g. a Safe multisig)
    /// @param leaseShare_            LeaseShare1155 this contract mints lease shares on, or address(0) to disable
    /// @param humanGate_             IHumanGate checked in every funding path (normally a HumanGate),
    ///                               or address(0) for no gating at all
    /// @param borrowerOpsSignatures_ Mezo's BorrowerOperationsSignatures relayed by borrowAndFund /
    ///                               withdrawAndFund, or address(0) to disable both
    /// @param disputeTimeout_        seconds a dispute stays open before resolveByTimeout may fire
    // forge-lint: disable-next-item(missing-zero-check) -- address(0) leaseShare_ / humanGate_ / borrowerOpsSignatures_ mean "disabled"
    constructor(
        IERC20 token_,
        address arbiter_,
        address leaseShare_,
        address humanGate_,
        address borrowerOpsSignatures_,
        uint64 disputeTimeout_
    ) {
        if (address(token_) == address(0) || arbiter_ == address(0)) revert ZeroAddress();
        if (humanGate_ != address(0) && humanGate_.code.length == 0) revert HumanGateHasNoCode(humanGate_);
        if (disputeTimeout_ == 0) revert ZeroDisputeTimeout();
        token = address(token_);
        arbiter = arbiter_;
        leaseShare = leaseShare_;
        humanGate = humanGate_;
        borrowerOpsSignatures = borrowerOpsSignatures_;
        disputeTimeout = disputeTimeout_;
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IRentEscrowV2
    function getLease(uint256 leaseId) external view returns (Lease memory) {
        return _leases[leaseId];
    }

    /// @inheritdoc IRentEscrowV2
    function tenantStats(address tenant) external view returns (TenantStats memory) {
        return _stats[tenant];
    }

    /// @inheritdoc IRentEscrowV2
    function termination(uint256 leaseId) external view returns (Termination memory) {
        return _terminations[leaseId];
    }

    /// @inheritdoc IRentEscrowV2
    function disputeOpenedAt(uint256 leaseId) external view returns (uint64) {
        return _disputeOpenedAt[leaseId];
    }

    /// @inheritdoc IRentEscrowV2
    function unbookedBalance() public view returns (uint256) {
        // balanceOf >= totalEscrowed always (INV-6): every escrowed token arrived before it was
        // booked, and lease payouts draw the balance down together with totalEscrowed.
        return IERC20(token).balanceOf(address(this)) - totalEscrowed;
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Zero unless the lease is ACTIVE (rent is frozen while DISPUTED). Capped at periodsFunded:
    ///      a monthly lease only ever releases rent that was actually paid in (a prepaid lease is
    ///      fully funded from the start, so this cap never binds for it).
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function claimable(uint256 leaseId) public view returns (uint16 periods, uint256 amount) {
        Lease storage l = _leases[leaseId];
        if (l.state != State.ACTIVE) return (0, 0);
        uint256 elapsed = _elapsedPeriods(l);
        if (elapsed > l.periodsFunded) elapsed = l.periodsFunded;
        // elapsed >= periodsClaimed: periodsClaimed only ever catches up to a past capped elapsed.
        // casting to 'uint16' is safe because elapsed <= l.periodsFunded, a uint16
        // forge-lint: disable-next-item(unsafe-typecast)
        periods = uint16(elapsed) - l.periodsClaimed;
        amount = uint256(periods) * l.rentPerPeriod;
    }

    /// @inheritdoc IRentEscrowV2
    function endTime(uint256 leaseId) public view returns (uint64) {
        Lease storage l = _leases[leaseId];
        if (l.startTime == 0) return 0;
        return _endTime(l);
    }

    // ------------------------------------------------------------------ actions

    /// @inheritdoc IRentEscrowV2
    /// @dev Reverts InvalidTerms if the arbiter would be the landlord or the tenant: an arbiter that
    ///      is also a party could open a dispute and rule the whole escrow to itself.
    ///      If lease shares are enabled, mints SHARES_PER_LEASE shares of tokenId == leaseId to the
    ///      landlord. LeaseShare1155 only lets allowlisted addresses receive shares, so a landlord
    ///      who is not on the compliance allowlist cannot list (the whole call reverts).
    function createLease(address tenant, uint128 deposit, uint128 rentPerPeriod, uint32 periodSeconds, uint16 periods)
        external
        nonReentrant
        returns (uint256 leaseId)
    {
        leaseId = _create(tenant, deposit, rentPerPeriod, periodSeconds, periods, false);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Same terms and checks as createLease (the uint128 bound is on deposit + ALL rent: a
    ///      monthly lease can grow to hold exactly that once every period is paid in). Emits
    ///      LeaseCreatedMonthly so indexers can tell the two kinds apart by event alone.
    function createLeaseMonthly(
        address tenant,
        uint128 deposit,
        uint128 rentPerPeriod,
        uint32 periodSeconds,
        uint16 periods
    ) external nonReentrant returns (uint256 leaseId) {
        leaseId = _create(tenant, deposit, rentPerPeriod, periodSeconds, periods, true);
    }

    function _create(
        address tenant,
        uint128 deposit,
        uint128 rentPerPeriod,
        uint32 periodSeconds,
        uint16 periods,
        bool monthly
    ) internal returns (uint256 leaseId) {
        uint256 total = uint256(deposit) + uint256(rentPerPeriod) * periods;
        if (
            tenant == address(0) || tenant == msg.sender || msg.sender == arbiter || tenant == arbiter
                || uint256(deposit) + rentPerPeriod == 0 || periods == 0 || periodSeconds < MIN_PERIOD
                || total > type(uint128).max
        ) revert InvalidTerms();

        leaseId = nextLeaseId++;
        _leases[leaseId] = Lease({
            landlord: msg.sender,
            tenant: tenant,
            deposit: deposit,
            rentPerPeriod: rentPerPeriod,
            periodSeconds: periodSeconds,
            periods: periods,
            periodsClaimed: 0,
            periodsFunded: 0,
            startTime: 0,
            monthly: monthly,
            state: State.CREATED
        });
        if (monthly) {
            emit LeaseCreatedMonthly(leaseId, msg.sender, tenant, deposit, rentPerPeriod, periodSeconds, periods);
        } else {
            emit LeaseCreated(leaseId, msg.sender, tenant, deposit, rentPerPeriod, periodSeconds, periods);
        }

        if (leaseShare != address(0)) {
            // state is written above and every mutating entry point is nonReentrant
            // forge-lint: disable-next-line(reentrancy-no-eth)
            LeaseShare1155(leaseShare).mintShare(leaseId, msg.sender, SHARES_PER_LEASE);
        }
    }

    /// @inheritdoc IRentEscrowV2
    function cancelLease(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.CREATED);
        if (msg.sender != l.landlord) revert NotLandlord(leaseId);

        l.state = State.CANCELLED;
        emit LeaseCancelled(leaseId);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev The human-gate check is a view (staticcall) made before any state change; a gate that
    ///      reverts makes funding revert (fail closed). Same bookkeeping as the borrow/withdraw
    ///      funding paths, via _bookFunding.
    function fundLease(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.CREATED);
        if (msg.sender != l.tenant) revert NotTenant(leaseId);
        _requireVerifiedHuman(msg.sender);

        _bookFunding(l, leaseId);
        IERC20(token).safeTransferFrom(msg.sender, address(this), _owed(l));
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev The signature is checked by Mezo's BorrowerOperationsSignatures, not here; what this
    ///      contract enforces is that the caller is the lease's tenant and the borrower whose trove
    ///      opens, and that the recipient is itself — so the tenant's signature is the only thing
    ///      that can move their trove, and it names this contract as recipient. The MUSD received is
    ///      measured (balance delta), never taken from the arguments: INV-5.
    function borrowAndFund(
        uint256 leaseId,
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external payable nonReentrant {
        if (borrowerOpsSignatures == address(0)) revert MezoDisabled();
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.CREATED);
        if (msg.sender != l.tenant) revert NotTenant(leaseId);
        _requireVerifiedHuman(msg.sender);

        uint256 owed = _owed(l);
        uint256 before = IERC20(token).balanceOf(address(this));
        // state is only read above and every mutating entry point is nonReentrant
        // forge-lint: disable-next-line(reentrancy-no-eth)
        IMezoBorrowerOperationsSignatures(borrowerOpsSignatures).openTroveWithSignature{value: msg.value}(
            debtAmount, upperHint, lowerHint, msg.sender, address(this), signature, deadline
        );
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received < owed) revert InsufficientBorrowed(leaseId, received, owed);

        _bookFunding(l, leaseId);
        // reentry is impossible (nonReentrant) and the amounts come from the measured delta
        // forge-lint: disable-next-line(reentrancy-events)
        emit LeaseBorrowFunded(leaseId, msg.sender, debtAmount, received, received - owed);
        _pay(msg.sender, received - owed); // surplus back to the tenant
    }

    /// @dev Mezo's withdraw-MUSD path always pays the caller "back" its collateral delta through
    ///      ActivePool.sendCollateral — a BTC transfer even when the delta is zero, which is the
    ///      only amount that can ever reach this contract (borrowAndFund forwards all BTC it
    ///      receives straight into the trove). Without a receiver that transfer reverts ("Sending
    ///      BTC failed") and no withdrawAndFund could ever complete. Only the zero-value touch is
    ///      accepted: this escrow's asset is MUSD, so any real BTC would be stuck forever (nothing
    ///      here can spend it) — a non-zero transfer reverts StrayBtc and bounces back to its sender.
    receive() external payable {
        if (msg.value != 0) revert StrayBtc(msg.value);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Arbiter-only, and only out of the pot beyond totalEscrowed (InsufficientUnbooked if
    ///      more): no lease's escrow can be reached through here. Moves no lease state, books
    ///      nothing; the `to` address is the arbiter's judgement from the on-chain evidence.
    function returnUnbooked(address to, uint256 amount) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        if (to == address(0)) revert ZeroAddress();
        uint256 available = unbookedBalance();
        if (amount > available) revert InsufficientUnbooked(amount, available);

        emit UnbookedReturned(to, amount);
        _pay(to, amount);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Same trust shape as borrowAndFund, against the tenant's existing trove: the signature
    ///      (checked by Mezo) fixes amount, borrower = msg.sender, recipient = this contract.
    function withdrawAndFund(
        uint256 leaseId,
        uint256 amount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external nonReentrant {
        if (borrowerOpsSignatures == address(0)) revert MezoDisabled();
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.CREATED);
        if (msg.sender != l.tenant) revert NotTenant(leaseId);
        _requireVerifiedHuman(msg.sender);

        uint256 owed = _owed(l);
        uint256 received = _mezoWithdraw(amount, upperHint, lowerHint, msg.sender, signature, deadline);
        if (received < owed) revert InsufficientBorrowed(leaseId, received, owed);

        _bookFunding(l, leaseId);
        // reentry is impossible (nonReentrant) and the amounts come from the measured delta
        // forge-lint: disable-next-line(reentrancy-events)
        emit LeaseBorrowFunded(leaseId, msg.sender, amount, received, received - owed);
        _pay(msg.sender, received - owed); // surplus back to the tenant
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Tenant only, ACTIVE monthly leases only: a prepaid lease is fully funded from the start
    ///      (NotMonthly) and a disputed one must settle before it can take on new periods. Same
    ///      human-gate check as every funding path. Books the periods before the pull (CEI), like
    ///      fundLease books before its transferFrom.
    function payRent(uint256 leaseId, uint16 count) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        if (!l.monthly) revert NotMonthly(leaseId);
        if (msg.sender != l.tenant) revert NotTenant(leaseId);
        _requireVerifiedHuman(msg.sender);

        count = _cappedPayCount(l, leaseId, count);
        uint256 amount = uint256(count) * l.rentPerPeriod;

        // funding bookkeeping, the payRent way: periods grow with the balance, never past `periods`
        l.periodsFunded += count;
        escrowBalance[leaseId] += amount;
        totalEscrowed += amount;
        emit RentPaid(leaseId, msg.sender, count, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Same trust shape as withdrawAndFund (the signature fixes amount, borrower = msg.sender,
    ///      recipient = this contract; the MUSD received is measured, never taken from the
    ///      arguments: INV-5), paying rent periods instead of funding the lease. Tenant only, ACTIVE
    ///      monthly leases only, same human-gate check as every funding path.
    function withdrawAndPayRent(
        uint256 leaseId,
        uint16 count,
        uint256 amount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external nonReentrant {
        if (borrowerOpsSignatures == address(0)) revert MezoDisabled();
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        if (!l.monthly) revert NotMonthly(leaseId);
        if (msg.sender != l.tenant) revert NotTenant(leaseId);
        _requireVerifiedHuman(msg.sender);

        count = _cappedPayCount(l, leaseId, count);
        uint256 owed = uint256(count) * l.rentPerPeriod;
        uint256 received = _mezoWithdraw(amount, upperHint, lowerHint, msg.sender, signature, deadline);
        if (received < owed) revert InsufficientBorrowed(leaseId, received, owed);

        l.periodsFunded += count;
        escrowBalance[leaseId] += owed;
        totalEscrowed += owed;
        // reentry is impossible (nonReentrant) and the amounts come from the measured delta
        // forge-lint: disable-next-line(reentrancy-events)
        emit RentPaid(leaseId, msg.sender, count, owed);
        emit LeaseBorrowFunded(leaseId, msg.sender, amount, received, received - owed);
        _pay(msg.sender, received - owed); // surplus back to the tenant
    }

    /// @inheritdoc IRentEscrowV2
    function claimRent(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        (uint16 periods, uint256 amount) = claimable(leaseId);
        if (periods == 0) revert NothingToClaim(leaseId);

        l.periodsClaimed += periods;
        escrowBalance[leaseId] -= amount;
        totalEscrowed -= amount;
        TenantStats storage s = _stats[l.tenant];
        s.periodsPaid += periods;
        // casting to 'uint128' is safe because amount <= deposit + rent * periods <= type(uint128).max
        // forge-lint: disable-next-line(unsafe-typecast)
        s.rentPaid += uint128(amount);
        address landlord = l.landlord;
        emit RentClaimed(leaseId, landlord, periods, amount);

        _pay(landlord, amount);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev The default rule, mechanically from the lease's own funded terms: period i (0-based) is
    ///      due at startTime + i * periodSeconds, so with graceSeconds == periodSeconds the lease is
    ///      in default exactly when now >= startTime + periodsFunded * periodSeconds + periodSeconds
    ///      while periodsFunded < periods (the next unfunded period has run a full period past its
    ///      due date; "elapsed > periodsFunded" is the same condition, written on the clock). The
    ///      deposit forfeit is capped at ONE unpaid period's rent and at the deposit itself, so a
    ///      tenant who paid deposit + n periods can never lose more than one period they did not
    ///      pay, and a landlord can never reach unfunded rent. Counts leasesDefaulted, never
    ///      leasesCompleted.
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function claimDefault(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        if (msg.sender != l.landlord) revert NotLandlord(leaseId);
        if (!l.monthly) revert NotMonthly(leaseId);
        uint256 dueAt = uint256(l.startTime) + uint256(l.periodsFunded) * l.periodSeconds + l.periodSeconds;
        if (l.periodsFunded == l.periods || block.timestamp < dueAt) revert NotDefaulted(leaseId, dueAt);

        // all funded periods have elapsed by then (elapsed > periodsFunded), so the funded
        // unclaimed rent is earned; the forfeit comes out of the deposit only
        uint16 fundedUnclaimed = l.periodsFunded - l.periodsClaimed;
        uint256 rentToLandlord = uint256(fundedUnclaimed) * l.rentPerPeriod;
        uint128 deposit = l.deposit;
        // forfeit <= one unpaid period's rent, and <= the deposit (uint128: min of two uint128s)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 forfeit = l.rentPerPeriod < deposit ? l.rentPerPeriod : deposit;
        uint256 toLandlord = rentToLandlord + forfeit;
        uint256 toTenant = escrowBalance[leaseId] - toLandlord; // == deposit - forfeit

        l.periodsClaimed = l.periodsFunded;
        l.state = State.CLOSED;
        totalEscrowed -= escrowBalance[leaseId];
        escrowBalance[leaseId] = 0;
        TenantStats storage s = _stats[l.tenant];
        s.leasesDefaulted += 1;
        s.periodsPaid += fundedUnclaimed;
        // casting to 'uint128' is safe because rentToLandlord <= rent * periods <= type(uint128).max
        // forge-lint: disable-next-line(unsafe-typecast)
        s.rentPaid += uint128(rentToLandlord);
        s.depositsPosted += deposit;
        // casting to 'uint128' is safe because toTenant <= deposit, a uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        s.depositsReturned += uint128(toTenant);
        emit LeaseDefaulted(leaseId, l.landlord, rentToLandlord, forfeit, toTenant);

        _pay(l.landlord, toLandlord);
        _pay(l.tenant, toTenant);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Reverts TermNotOver before endTime, and for anyone but the landlord until
    ///      endTime + periodSeconds (the grace window in which the landlord can still dispute).
    ///      A monthly lease must also be fully funded (RentNotFullyFunded): closeLease pays every
    ///      remaining period's rent, which only exists when the tenant actually paid them in. An
    ///      underfunded monthly lease past its due date is the landlord's claimDefault instead.
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function closeLease(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        uint256 end = _endTime(l);
        if (block.timestamp < end) revert TermNotOver(leaseId);
        if (msg.sender != l.landlord && block.timestamp < end + l.periodSeconds) revert TermNotOver(leaseId);
        if (l.periodsFunded != l.periods) revert RentNotFullyFunded(leaseId, l.periodsFunded, l.periods);

        uint16 remaining = l.periods - l.periodsClaimed;
        uint256 toLandlord = uint256(remaining) * l.rentPerPeriod;
        uint128 deposit = l.deposit;
        address tenant = l.tenant;

        l.periodsClaimed = l.periods;
        l.state = State.CLOSED;
        totalEscrowed -= escrowBalance[leaseId]; // == deposit + toLandlord
        escrowBalance[leaseId] = 0;
        TenantStats storage s = _stats[tenant];
        s.leasesCompleted += 1;
        s.periodsPaid += remaining;
        // casting to 'uint128' is safe because toLandlord <= rent * periods <= type(uint128).max
        // forge-lint: disable-next-line(unsafe-typecast)
        s.rentPaid += uint128(toLandlord);
        s.depositsPosted += deposit;
        s.depositsReturned += deposit;
        emit LeaseClosed(leaseId, tenant, deposit, toLandlord);

        _pay(l.landlord, toLandlord);
        _pay(tenant, deposit);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Open to either party for as long as the lease is ACTIVE: after the term and after the
    ///      grace window too, until someone calls closeLease. Moves no tokens, so it works even when
    ///      the token blocks one party. Unlike V1 there IS a way out without the arbiter: after
    ///      disputeTimeout, resolveByTimeout.
    function openDispute(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        if (msg.sender != l.tenant && msg.sender != l.landlord) revert NotParty(leaseId);

        (uint16 due,) = claimable(leaseId); // read while still ACTIVE
        _earnedAtDispute[leaseId] = l.periodsClaimed + due;
        // casting to 'uint64' is safe because timestamps fit in 64 bits for ~5e11 years
        // forge-lint: disable-next-line(unsafe-typecast)
        _disputeOpenedAt[leaseId] = uint64(block.timestamp);
        l.state = State.DISPUTED;
        _stats[l.tenant].leasesDisputed += 1;
        emit DisputeOpened(leaseId, msg.sender);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev The tenant's share rounds down; the landlord gets the rest, so the payout is exact.
    ///      Counts toward depositsPosted / depositsReturned and rentPaid / periodsPaid, never toward
    ///      leasesCompleted. See _recordRuling for how the split is read into the stats.
    function resolveDispute(uint256 leaseId, uint16 tenantBps) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        if (tenantBps > BPS_DENOMINATOR) revert InvalidBps(tenantBps);
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.DISPUTED);

        uint256 balance = escrowBalance[leaseId];
        uint256 toTenant = balance * tenantBps / BPS_DENOMINATOR;
        uint256 toLandlord = balance - toTenant;

        l.state = State.CLOSED;
        totalEscrowed -= balance;
        escrowBalance[leaseId] = 0;
        _recordRuling(l, _earnedAtDispute[leaseId], toTenant, toLandlord);
        emit DisputeResolved(leaseId, tenantBps, toTenant, toLandlord);

        _pay(l.tenant, toTenant);
        _pay(l.landlord, toLandlord);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Callable by anyone: the split is fixed (earned-at-dispute rent to the landlord,
    ///      everything else to the tenant), so nobody gains by firing it early or late beyond the
    ///      boundary. The arbiter's resolveDispute still works right up to this call; afterwards
    ///      the lease is CLOSED and only InvalidState remains.
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function resolveByTimeout(uint256 leaseId) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.DISPUTED);
        if (block.timestamp < uint256(_disputeOpenedAt[leaseId]) + uint256(disputeTimeout)) {
            revert DisputeNotTimedOut(leaseId);
        }

        uint16 earned = _earnedAtDispute[leaseId];
        // earned >= periodsClaimed (recorded that way in openDispute), so this cannot underflow
        uint256 toLandlord = uint256(earned - l.periodsClaimed) * l.rentPerPeriod;
        uint256 toTenant = escrowBalance[leaseId] - toLandlord; // unearned rent + deposit

        l.state = State.CLOSED;
        totalEscrowed -= escrowBalance[leaseId];
        escrowBalance[leaseId] = 0;
        _recordRuling(l, earned, toTenant, toLandlord);
        emit DisputeTimedOut(leaseId, msg.sender, toTenant, toLandlord);

        _pay(l.tenant, toTenant);
        _pay(l.landlord, toLandlord);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Either party may propose, and either party's new proposal replaces the open one; the
    ///      hash the other party will confirm (see acceptTermination) covers proposer, penalty and
    ///      expiry. The penalty bound is checked here against the tenant side as of now, and again
    ///      at accept time (rent keeps accruing, so the tenant side shrinks).
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function proposeTermination(uint256 leaseId, uint128 penaltyToLandlord, uint64 expiry) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        if (msg.sender != l.tenant && msg.sender != l.landlord) revert NotParty(leaseId);
        if (uint256(expiry) <= block.timestamp) revert InvalidExpiry(leaseId, expiry);

        uint256 tenantSide = _tenantSide(l);
        if (penaltyToLandlord > tenantSide) revert PenaltyTooHigh(leaseId, penaltyToLandlord, tenantSide);

        _terminations[leaseId] =
            Termination({proposer: msg.sender, penaltyToLandlord: penaltyToLandlord, expiry: expiry});
        emit TerminationProposed(leaseId, msg.sender, penaltyToLandlord, expiry);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev Works whatever state the lease has drifted to (disputed, closed): a proposal can only
    ///      ever be accepted on an ACTIVE lease, so this just clears the offer.
    function withdrawTermination(uint256 leaseId) external nonReentrant {
        Termination storage p = _terminations[leaseId];
        if (p.proposer == address(0)) revert NoProposal(leaseId);
        if (msg.sender != p.proposer) revert NotProposer(leaseId);

        delete _terminations[leaseId];
        emit TerminationWithdrawn(leaseId, msg.sender);
    }

    /// @inheritdoc IRentEscrowV2
    /// @dev The acceptor passes termsHash to confirm the exact terms off-chain; a replaced or
    ///      withdrawn proposal hashes differently (WrongTermsHash) or is gone (NoProposal).
    ///      Settlement: landlord = earned-but-unclaimed rent (via claimable) + penalty; tenant =
    ///      everything else (unearned rent + deposit - penalty). Books through _recordRuling like a
    ///      ruling, plus leasesTerminatedEarly — never leasesCompleted or leasesDisputed.
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function acceptTermination(uint256 leaseId, bytes32 termsHash) external nonReentrant {
        Lease storage l = _leases[leaseId];
        _requireState(l, leaseId, State.ACTIVE);
        Termination memory p = _terminations[leaseId];
        if (p.proposer == address(0)) revert NoProposal(leaseId);
        if (msg.sender != l.tenant && msg.sender != l.landlord) revert NotParty(leaseId);
        if (msg.sender == p.proposer) revert ProposerCannotAccept(leaseId);
        if (block.timestamp >= p.expiry) revert ProposalExpired(leaseId);
        if (keccak256(abi.encode(leaseId, p.proposer, p.penaltyToLandlord, p.expiry)) != termsHash) {
            revert WrongTermsHash(leaseId);
        }

        (uint16 due, uint256 earnedUnclaimed) = claimable(leaseId);
        uint16 elapsed = l.periodsClaimed + due; // == min(elapsed, periodsFunded), a funded count
        uint256 tenantSide = uint256(l.deposit) + uint256(l.periodsFunded - elapsed) * l.rentPerPeriod;
        if (p.penaltyToLandlord > tenantSide) revert PenaltyTooHigh(leaseId, p.penaltyToLandlord, tenantSide);

        uint256 toLandlord = earnedUnclaimed + p.penaltyToLandlord;
        uint256 toTenant = escrowBalance[leaseId] - toLandlord;

        // _recordRuling reads periodsClaimed as it is now: the earned-but-unclaimed rent leaves
        // with the landlord, as if it had been claimed right before the settlement.
        _recordRuling(l, elapsed, toTenant, toLandlord);
        l.periodsClaimed = elapsed;
        l.state = State.CLOSED;
        totalEscrowed -= escrowBalance[leaseId];
        escrowBalance[leaseId] = 0;
        delete _terminations[leaseId];
        _stats[l.tenant].leasesTerminatedEarly += 1;
        emit TerminationAccepted(leaseId, msg.sender, toTenant, toLandlord);

        _pay(l.landlord, toLandlord);
        _pay(l.tenant, toTenant);
    }

    // ------------------------------------------------------------------ internal

    function _requireState(Lease storage l, uint256 leaseId, State expected) internal view {
        if (l.state != expected) revert InvalidState(leaseId, l.state);
    }

    function _requireVerifiedHuman(address tenant) internal view {
        if (humanGate != address(0) && !IHumanGate(humanGate).isVerified(tenant)) {
            revert NotVerifiedHuman(tenant);
        }
    }

    /// @dev What funding costs, and what the escrow holds for the lease right after: deposit + all
    ///      rent for a prepaid lease, deposit + the FIRST period's rent for a monthly one (the rest
    ///      arrives period by period through payRent / withdrawAndPayRent).
    function _owed(Lease storage l) internal view returns (uint256) {
        uint256 fundedPeriods = l.monthly ? 1 : l.periods;
        return uint256(l.deposit) + uint256(l.rentPerPeriod) * fundedPeriods;
    }

    /// @dev Caps a payRent / withdrawAndPayRent count at the unfunded remainder (periodsFunded
    ///      never grows past `periods`) and refuses a count of zero.
    function _cappedPayCount(Lease storage l, uint256 leaseId, uint16 count) internal view returns (uint16) {
        // periodsFunded <= periods is invariant, so this cannot underflow
        uint16 remaining = l.periods - l.periodsFunded;
        if (count > remaining) count = remaining;
        if (count == 0) revert RentFullyFunded(leaseId);
        return count;
    }

    /// @dev Relays a tenant-signed WithdrawMUSD to Mezo (borrower = the caller, recipient = this
    ///      escrow) and returns the MUSD that actually arrived, measured as a balance delta: the
    ///      caller decides what a sufficient amount is and refunds the surplus (INV-5). Shared by
    ///      withdrawAndFund and withdrawAndPayRent.
    function _mezoWithdraw(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        // state is only read by the caller and every mutating entry point is nonReentrant
        // forge-lint: disable-next-item(reentrancy-no-eth)
        IMezoBorrowerOperationsSignatures(borrowerOpsSignatures)
            .withdrawMUSDWithSignature(amount, upperHint, lowerHint, borrower, address(this), signature, deadline);
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    /// @dev Books a freshly funded lease the same way for all three funding paths: CREATED -> ACTIVE
    ///      at now, the owed amount becomes the lease's escrow, the tenant's funded count grows.
    ///      Called after the MUSD has arrived (fundLease pulls it first via transferFrom; the
    ///      borrow/withdraw paths have already received it from the trove operation).
    function _bookFunding(Lease storage l, uint256 leaseId) internal {
        uint256 amount = _owed(l);
        // casting to 'uint64' is safe because timestamps fit in 64 bits for ~5e11 years
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 start = uint64(block.timestamp);
        l.state = State.ACTIVE;
        l.startTime = start;
        // prepaid leases are fully funded the moment they start; monthly ones hold one period
        l.periodsFunded = l.monthly ? 1 : l.periods;
        // every funding path calls this exactly once per lease, from State.CREATED, where
        // escrowBalance[leaseId] is still 0: the sum grows by exactly `amount`
        totalEscrowed += amount;
        escrowBalance[leaseId] = amount;
        _stats[l.tenant].leasesFunded += 1;
        // on the borrow/withdraw paths this runs after the trove operation (nonReentrant, and the
        // amount is the lease's own owed, not the external call's return)
        // forge-lint: disable-next-line(reentrancy-events)
        emit LeaseFunded(leaseId, l.tenant, amount, start);
    }

    /// @dev Whole periods elapsed since funding, capped at the term.
    // forge-lint: disable-next-item(block-timestamp) -- periods are >= 60s; seconds of drift are harmless
    function _elapsedPeriods(Lease storage l) internal view returns (uint16) {
        uint256 elapsed = (block.timestamp - l.startTime) / l.periodSeconds;
        if (elapsed > l.periods) elapsed = l.periods;
        // casting to 'uint16' is safe because elapsed <= l.periods, a uint16
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(elapsed);
    }

    /// @dev Unearned rent + deposit: what is on the tenant's side of an early settlement. Only
    ///      FUNDED periods count (a prepaid lease funds them all): unfunded periods of a monthly
    ///      lease are neither in the escrow nor the tenant's to give up.
    function _tenantSide(Lease storage l) internal view returns (uint256) {
        uint256 elapsed = _elapsedPeriods(l);
        if (elapsed > l.periodsFunded) elapsed = l.periodsFunded;
        return uint256(l.deposit) + uint256(l.periodsFunded - elapsed) * l.rentPerPeriod;
    }

    /// @dev Books a dispute ruling into the tenant's stats. The escrow pot is, in order, rent not
    ///      yet earned when the dispute opened, the deposit, then earned-but-unclaimed rent. The
    ///      tenant's payout is read from the front (unearned refund, then deposit back), the
    ///      landlord's from the back (earned rent first). `earned` is _earnedAtDispute (>=
    ///      periodsClaimed, <= periodsFunded). Only funded periods count as unearned rent: a
    ///      monthly lease's unfunded periods never entered the pot. Shared by resolveDispute,
    ///      resolveByTimeout and acceptTermination, which all settle the whole remaining escrow in
    ///      one split.
    function _recordRuling(Lease storage l, uint16 earned, uint256 toTenant, uint256 toLandlord) internal {
        uint128 deposit = l.deposit;
        uint256 unearnedRent = uint256(l.periodsFunded - earned) * l.rentPerPeriod;
        uint256 depositBack = toTenant > unearnedRent ? toTenant - unearnedRent : 0;
        if (depositBack > deposit) depositBack = deposit;

        uint16 earnedUnclaimed = earned - l.periodsClaimed;
        uint256 rentReleased = uint256(earnedUnclaimed) * l.rentPerPeriod;
        if (rentReleased > toLandlord) rentReleased = toLandlord;
        // casting to 'uint16' is safe because rentReleased / rentPerPeriod <= earnedUnclaimed, a uint16
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 periodsReleased = l.rentPerPeriod == 0 ? earnedUnclaimed : uint16(rentReleased / l.rentPerPeriod);

        TenantStats storage s = _stats[l.tenant];
        s.periodsPaid += periodsReleased;
        // casting to 'uint128' is safe because rentReleased <= rent * periods <= type(uint128).max
        // forge-lint: disable-next-line(unsafe-typecast)
        s.rentPaid += uint128(rentReleased);
        s.depositsPosted += deposit;
        // casting to 'uint128' is safe because depositBack <= deposit, a uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        s.depositsReturned += uint128(depositBack);
    }

    function _endTime(Lease storage l) internal view returns (uint64) {
        return l.startTime + uint64(l.periodSeconds) * l.periods;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }
}
