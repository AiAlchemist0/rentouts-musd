// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {IRentEscrowV2} from "../src/interfaces/IRentEscrowV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {HumanGate} from "../src/HumanGate.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";
import {MockHumanVerifier} from "./helpers/MockHumanVerifier.sol";
import {MockBorrowerOperationsSignatures, MintableMUSD} from "./helpers/MockBorrowerOperationsSignatures.sol";
import {MezoSignatures} from "./helpers/MezoSignatures.sol";

/// @notice Drives RentEscrowV2 through random lease lifecycles across several actors — including
///         monthly leases, borrow-and-fund via the Mezo mock, payRent, defaults, mutual
///         terminations and dispute timeouts — and keeps an independent ledger of every token
///         transfer out of the escrow (read from the token's Transfer logs, not from the escrow's
///         own bookkeeping).
contract EscrowV2Handler is Test {
    bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");

    RentEscrowV2 public immutable escrow;
    MockUSDC public immutable musd;
    MockBorrowerOperationsSignatures public immutable mezo;
    address public immutable arbiter;
    address public immutable keeper; // unrelated third party that pokes claim/close/timeout
    address[] public actors; // landlords and tenants

    /// @dev Actor private keys (actors are vm.addr(key)), so the handler can sign trove operations.
    mapping(address => uint256) public actorKeys;

    /// @dev Block time survives between handler calls only through this ghost.
    uint256 public currentTime;

    // INV-1: per-address ledger + recipient check
    mapping(address => uint256) public ghostMinted; // test tokens minted to an actor so it can fund
    mapping(address => uint256) public ghostPaidIn; // paid by an actor into the escrow
    mapping(address => uint256) public ghostReceived; // paid by the escrow to this address
    uint256 public ghostOutToNonParty; // escrow transfers to anyone but the lease's tenant/landlord
    uint256 public ghostWrongPayout; // a settlement paid a party something other than its due

    // INV-3: rent actually transferred to the landlord per lease (terminations book only the
    // earned-rent part of the landlord's payout; a penalty is not rent)
    mapping(uint256 => uint256) public ghostRentReleased;

    // INV-4: settlements that split the whole remaining escrow (ruling, timeout, termination)
    mapping(uint256 => bool) public ghostResolved;
    mapping(uint256 => uint256) public ghostEscrowAtResolve;
    mapping(uint256 => uint256) public ghostResolvePayout;
    uint256 public ghostBadSplit;

    // INV-6: the unbooked pot — MUSD that reached the escrow without a lease (a stray transfer,
    // the shape a front-run relay leaves behind), returned only by the arbiter
    uint256 public ghostUnbooked;

    // INV-7: per-lease ledger — what was booked INTO the lease (funding + payRent; a borrow-path
    // surplus refund never enters it) against what the escrow paid OUT to that lease's parties.
    // Funding-path refunds to the tenant are deliberately excluded: they were never lease money.
    mapping(uint256 => uint256) public ghostLeasePaidIn;
    mapping(uint256 => uint256) public ghostLeasePaidOut;

    mapping(bytes32 => uint256) public calls;

    modifier useTime() {
        vm.warp(currentTime);
        _;
    }

    constructor(
        RentEscrowV2 escrow_,
        MockUSDC musd_,
        MockBorrowerOperationsSignatures mezo_,
        address arbiter_,
        address keeper_,
        address[] memory actors_,
        uint256[] memory keys_
    ) {
        escrow = escrow_;
        musd = musd_;
        mezo = mezo_;
        arbiter = arbiter_;
        keeper = keeper_;
        actors = actors_;
        for (uint256 i; i < actors_.length; i++) {
            actorKeys[actors_[i]] = keys_[i];
            vm.deal(actors_[i], 1_000 ether); // BTC for the collateral borrowAndFund forwards
        }
        currentTime = block.timestamp;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------------ actions

    function createLease(
        uint256 landlordSeed,
        uint256 tenantSeed,
        uint128 deposit,
        uint128 rent,
        uint32 periodSeconds,
        uint16 periods
    ) external useTime {
        _createLease(landlordSeed, tenantSeed, deposit, rent, periodSeconds, periods, false);
    }

    /// @dev The same shape, as a monthly lease: funding will cover deposit + one period only.
    function createLeaseMonthly(
        uint256 landlordSeed,
        uint256 tenantSeed,
        uint128 deposit,
        uint128 rent,
        uint32 periodSeconds,
        uint16 periods
    ) external useTime {
        _createLease(landlordSeed, tenantSeed, deposit, rent, periodSeconds, periods, true);
    }

    function _createLease(
        uint256 landlordSeed,
        uint256 tenantSeed,
        uint128 deposit,
        uint128 rent,
        uint32 periodSeconds,
        uint16 periods,
        bool monthly
    ) internal {
        address landlord = actors[landlordSeed % actors.length];
        address tenant = actors[tenantSeed % actors.length];
        if (tenant == landlord) tenant = actors[(tenantSeed % actors.length + 1) % actors.length];
        deposit = uint128(bound(deposit, 0, 10_000e6));
        rent = uint128(bound(rent, 0, 5_000e6));
        if (deposit == 0 && rent == 0) deposit = 1;
        periodSeconds = uint32(bound(periodSeconds, 60, 6 hours));
        periods = uint16(bound(periods, 1, 12));

        if (monthly) {
            vm.prank(landlord);
            escrow.createLeaseMonthly(tenant, deposit, rent, periodSeconds, periods);
            calls["createLeaseMonthly"]++;
        } else {
            vm.prank(landlord);
            escrow.createLease(tenant, deposit, rent, periodSeconds, periods);
            calls["createLease"]++;
        }
    }

    function cancelLease(uint256 seed) external useTime {
        if (seed % 4 != 0) return; // keep most proposals alive long enough to be funded
        uint256 id = _find(seed, IRentEscrowV2.State.CREATED);
        if (id == 0) return;
        vm.prank(escrow.getLease(id).landlord);
        escrow.cancelLease(id);
        calls["cancelLease"]++;
    }

    function fundLease(uint256 seed) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.CREATED);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        uint256 total = _owedAtFunding(l);

        musd.mint(l.tenant, total);
        ghostMinted[l.tenant] += total;
        vm.prank(l.tenant);
        musd.approve(address(escrow), total);
        vm.recordLogs();
        vm.prank(l.tenant);
        escrow.fundLease(id);
        ghostPaidIn[l.tenant] += total;
        ghostLeasePaidIn[id] += total;
        _outflows(id); // funding must not move anything out
        calls["fundLease"]++;
    }

    /// @dev borrowAndFund through the mock: the tenant signs a real OpenTrove digest for a debt
    ///      covering the lease (plus a bounded surplus) and the escrow relays it. The mock mints to
    ///      the escrow, so unlike fundLease nothing leaves the tenant's balance: only the surplus
    ///      refund can come back, and INV-1's ledger must see exactly that.
    function borrowAndFund(uint256 seed, uint256 surplus, uint256 collateral) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.CREATED);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        uint256 owed = _owedAtFunding(l);
        uint256 debt = owed + bound(surplus, 0, 500e6);
        uint256 value = bound(collateral, 0, 0.05 ether);
        uint256 deadline = currentTime + 1 hours;
        bytes memory sig = MezoSignatures.sign(
            actorKeys[l.tenant],
            MezoSignatures.openTroveDigest(
                address(mezo), value, debt, l.tenant, address(escrow), mezo.getNonce(l.tenant), deadline
            )
        );

        vm.recordLogs();
        vm.prank(l.tenant);
        escrow.borrowAndFund{value: value}(id, debt, address(0), address(0), sig, deadline);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        if (toTenant != debt - owed || toLandlord != 0) ghostWrongPayout++;
        ghostLeasePaidIn[id] += owed;
        calls["borrowAndFund"]++;
    }

    /// @dev withdrawAndFund through the mock, same shape as borrowAndFund without collateral.
    function withdrawAndFund(uint256 seed, uint256 surplus) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.CREATED);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        uint256 owed = _owedAtFunding(l);
        uint256 debt = owed + bound(surplus, 0, 500e6);
        uint256 deadline = currentTime + 1 hours;
        bytes memory sig = MezoSignatures.sign(
            actorKeys[l.tenant],
            MezoSignatures.withdrawMUSDDigest(
                address(mezo), debt, l.tenant, address(escrow), mezo.getNonce(l.tenant), deadline
            )
        );

        vm.recordLogs();
        vm.prank(l.tenant);
        escrow.withdrawAndFund(id, debt, address(0), address(0), sig, deadline);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        if (toTenant != debt - owed || toLandlord != 0) ghostWrongPayout++;
        ghostLeasePaidIn[id] += owed;
        calls["withdrawAndFund"]++;
    }

    /// @dev What funding a lease costs the way the escrow computes it: prepaid = deposit + all
    ///      rent, monthly = deposit + the first period only.
    function _owedAtFunding(IRentEscrowV2.Lease memory l) internal pure returns (uint256) {
        uint256 fundedPeriods = l.monthly ? 1 : l.periods;
        return uint256(l.deposit) + uint256(l.rentPerPeriod) * fundedPeriods;
    }

    /// @dev The tenant tops up a monthly lease with a bounded count of further periods.
    function payRent(uint256 seed, uint16 count) external useTime {
        uint256 id = _findPayable(seed);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        count = uint16(bound(count, 1, l.periods - l.periodsFunded));
        uint256 amount = uint256(l.rentPerPeriod) * count;

        musd.mint(l.tenant, amount);
        ghostMinted[l.tenant] += amount;
        vm.prank(l.tenant);
        musd.approve(address(escrow), amount);
        vm.recordLogs();
        vm.prank(l.tenant);
        escrow.payRent(id, count);
        ghostPaidIn[l.tenant] += amount;
        ghostLeasePaidIn[id] += amount;
        _outflows(id); // payRent must move nothing out
        calls["payRent"]++;
    }

    /// @dev The landlord defaults an underfunded monthly lease once its grace has passed; the
    ///      mechanical split is checked exactly (funded unclaimed rent + one period's rent out of
    ///      the deposit to the landlord, the rest of the deposit to the tenant).
    function claimDefault(uint256 seed) external useTime {
        uint256 id = _findDefaultable(seed);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        uint256 rentPart = uint256(l.periodsFunded - l.periodsClaimed) * l.rentPerPeriod;
        uint256 forfeit = uint256(l.rentPerPeriod) < uint256(l.deposit) ? uint256(l.rentPerPeriod) : uint256(l.deposit);

        uint256 before = escrow.escrowBalance(id);
        vm.recordLogs();
        vm.prank(l.landlord);
        escrow.claimDefault(id);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        if (toLandlord != rentPart + forfeit || toTenant != uint256(l.deposit) - forfeit) ghostWrongPayout++;
        ghostRentReleased[id] += rentPart;
        ghostLeasePaidOut[id] += toTenant + toLandlord;
        ghostResolved[id] = true; // a default settles the whole remaining escrow, like a ruling
        ghostEscrowAtResolve[id] = before;
        ghostResolvePayout[id] = toTenant + toLandlord;
        calls["claimDefault"]++;
    }

    function warp(uint256 secs) external {
        currentTime += bound(secs, 0, 12 hours);
        calls["warp"]++;
    }

    function claimRent(uint256 seed, uint256 callerSeed) external useTime {
        uint256 id = _findClaimable(seed);
        if (id == 0) return;
        (, uint256 expected) = escrow.claimable(id);

        vm.recordLogs();
        vm.prank(_anyone(callerSeed));
        escrow.claimRent(id);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        if (toTenant != 0 || toLandlord != expected) ghostWrongPayout++;
        ghostRentReleased[id] += toLandlord;
        ghostLeasePaidOut[id] += toTenant + toLandlord;
        calls["claimRent"]++;
    }

    function closeLease(uint256 seed, uint256 callerSeed) external useTime {
        uint256 id = _findClosable(seed);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        address caller = _anyone(callerSeed);
        // Only the landlord may close inside the one-period grace window.
        if (block.timestamp < uint256(escrow.endTime(id)) + l.periodSeconds) caller = l.landlord;

        vm.recordLogs();
        vm.prank(caller);
        escrow.closeLease(id);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        // _findClosable only returns fully funded leases, so funded == periods here.
        uint256 rentDue = uint256(l.rentPerPeriod) * (l.periodsFunded - l.periodsClaimed);
        if (toTenant != l.deposit || toLandlord != rentDue) ghostWrongPayout++;
        ghostRentReleased[id] += toLandlord;
        ghostLeasePaidOut[id] += toTenant + toLandlord;
        calls["closeLease"]++;
    }

    function openDispute(uint256 seed, bool byLandlord) external useTime {
        if (seed % 3 != 0) return; // most leases should run to term
        uint256 id = _find(seed, IRentEscrowV2.State.ACTIVE);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        vm.prank(byLandlord ? l.landlord : l.tenant);
        escrow.openDispute(id);
        calls["openDispute"]++;
    }

    function resolveDispute(uint256 seed, uint16 tenantBps) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.DISPUTED);
        if (id == 0) return;
        tenantBps = uint16(bound(tenantBps, 0, 10_000));
        uint256 before = escrow.escrowBalance(id);

        vm.recordLogs();
        vm.prank(arbiter);
        escrow.resolveDispute(id, tenantBps);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        ghostResolved[id] = true;
        ghostEscrowAtResolve[id] = before;
        ghostResolvePayout[id] = toTenant + toLandlord;
        ghostLeasePaidOut[id] += toTenant + toLandlord;
        if (toTenant != before * tenantBps / 10_000 || toTenant + toLandlord != before) ghostBadSplit++;
        calls["resolveDispute"]++;
    }

    /// @dev Timeout resolution, only once the lease's dispute is actually old enough.
    function resolveByTimeout(uint256 seed, uint256 callerSeed) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.DISPUTED);
        if (id == 0) return;
        if (block.timestamp < uint256(escrow.disputeOpenedAt(id)) + escrow.disputeTimeout()) return;

        uint256 before = escrow.escrowBalance(id);
        vm.recordLogs();
        vm.prank(_anyone(callerSeed));
        escrow.resolveByTimeout(id);
        (uint256 toTenant, uint256 toLandlord) = _outflows(id);

        ghostResolved[id] = true;
        ghostEscrowAtResolve[id] = before;
        ghostResolvePayout[id] = toTenant + toLandlord;
        ghostLeasePaidOut[id] += toTenant + toLandlord;
        if (toTenant + toLandlord != before) ghostBadSplit++;
        calls["resolveByTimeout"]++;
    }

    /// @dev Either party proposes a fresh termination with a bounded penalty and a future expiry.
    ///      The tenant side is the FUNDED one (the contract's _tenantSide caps elapsed at
    ///      periodsFunded), so the bound never over- or under-shoots for a monthly lease.
    function proposeTermination(uint256 seed, bool byLandlord, uint128 penalty, uint256 horizon) external useTime {
        uint256 id = _find(seed, IRentEscrowV2.State.ACTIVE);
        if (id == 0) return;
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        uint256 elapsed = (block.timestamp - l.startTime) / l.periodSeconds;
        if (elapsed > l.periodsFunded) elapsed = l.periodsFunded;
        uint256 tenantSide = uint256(l.deposit) + uint256(l.periodsFunded - elapsed) * l.rentPerPeriod;
        penalty = uint128(bound(penalty, 0, tenantSide));
        uint64 expiry = uint64(block.timestamp + bound(horizon, 1, 48 hours));

        vm.prank(byLandlord ? l.landlord : l.tenant);
        escrow.proposeTermination(id, penalty, expiry);
        calls["proposeTermination"]++;
    }

    /// @dev The counterparty accepts the stored proposal, but only while it would not revert: not
    ///      expired, and the penalty still within the (shrunken) tenant side.
    function acceptTermination(uint256 seed) external useTime {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            if (escrow.getLease(id).state != IRentEscrowV2.State.ACTIVE) continue;
            IRentEscrowV2.Termination memory p = escrow.termination(id);
            if (p.proposer == address(0) || block.timestamp >= p.expiry) continue;
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            (uint16 due,) = escrow.claimable(id);
            uint256 tenantSide =
                uint256(l.deposit) + uint256(l.periodsFunded - (l.periodsClaimed + due)) * l.rentPerPeriod;
            if (p.penaltyToLandlord > tenantSide) continue;

            uint256 before = escrow.escrowBalance(id);
            vm.recordLogs();
            vm.prank(p.proposer == l.tenant ? l.landlord : l.tenant);
            escrow.acceptTermination(id, keccak256(abi.encode(id, p.proposer, p.penaltyToLandlord, p.expiry)));
            (uint256 toTenant, uint256 toLandlord) = _outflows(id);

            // The penalty is not rent: only the earned part of the landlord's payout is.
            ghostRentReleased[id] += toLandlord - p.penaltyToLandlord;
            ghostResolved[id] = true;
            ghostEscrowAtResolve[id] = before;
            ghostResolvePayout[id] = toTenant + toLandlord;
            ghostLeasePaidOut[id] += toTenant + toLandlord;
            if (toTenant + toLandlord != before) ghostBadSplit++;
            calls["acceptTermination"]++;
            return;
        }
    }

    /// @dev The proposer pulls their open offer, whatever state the lease has drifted to.
    function withdrawTermination(uint256 seed) external useTime {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            IRentEscrowV2.Termination memory p = escrow.termination(id);
            if (p.proposer == address(0)) continue;
            vm.prank(p.proposer);
            escrow.withdrawTermination(id);
            calls["withdrawTermination"]++;
            return;
        }
    }

    /// @dev MUSD reaches the escrow with no lease behind it (the shape a front-run relay or a
    ///      mistaken transfer leaves behind): minted to an actor, transferred straight in, booked
    ///      to the unbooked ghost — and to the actor's INV-1 ledger as paid in.
    function strayTransfer(uint256 actorSeed, uint256 amount) external useTime {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 300e6);

        musd.mint(a, amount);
        ghostMinted[a] += amount;
        vm.prank(a);
        musd.transfer(address(escrow), amount);
        ghostPaidIn[a] += amount;
        ghostUnbooked += amount;
        calls["strayTransfer"]++;
    }

    /// @dev The arbiter hands back part of the unbooked pot to an actor — never more than it holds.
    function returnUnbooked(uint256 actorSeed, uint256 amount) external useTime {
        uint256 available = escrow.unbookedBalance();
        if (available == 0) return;
        address to = actors[actorSeed % actors.length];
        amount = bound(amount, 0, available);
        if (amount == 0) return;

        vm.recordLogs();
        vm.prank(arbiter);
        escrow.returnUnbooked(to, amount);
        _bookOutflows();
        ghostUnbooked -= amount;
        calls["returnUnbooked"]++;
    }

    // ------------------------------------------------------------------ internal

    /// @dev Reads the token Transfer logs emitted by the last escrow call and books every transfer
    ///      whose sender is the escrow. Anything sent to a non-party of `leaseId` is flagged.
    function _outflows(uint256 leaseId) internal returns (uint256 toTenant, uint256 toLandlord) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        IRentEscrowV2.Lease memory l = escrow.getLease(leaseId);
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(musd) || logs[i].topics[0] != TRANSFER_SIG) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != address(escrow)) continue;
            address to = address(uint160(uint256(logs[i].topics[2])));
            uint256 amount = abi.decode(logs[i].data, (uint256));
            ghostReceived[to] += amount;
            if (to == l.tenant) toTenant += amount;
            else if (to == l.landlord) toLandlord += amount;
            else ghostOutToNonParty++;
        }
    }

    /// @dev Same log walk with no lease to classify by: books every escrow payout to its
    ///      recipient's ledger (used by returnUnbooked, which pays whoever the arbiter names).
    function _bookOutflows() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(musd) || logs[i].topics[0] != TRANSFER_SIG) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != address(escrow)) continue;
            ghostReceived[address(uint160(uint256(logs[i].topics[2])))] += abi.decode(logs[i].data, (uint256));
        }
    }

    function _anyone(uint256 seed) internal view returns (address) {
        uint256 i = seed % (actors.length + 2);
        if (i == actors.length) return keeper;
        if (i == actors.length + 1) return arbiter;
        return actors[i];
    }

    function _count() internal view returns (uint256) {
        return escrow.nextLeaseId() - 1;
    }

    function _find(uint256 seed, IRentEscrowV2.State state) internal view returns (uint256) {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            if (escrow.getLease(id).state == state) return id;
        }
        return 0;
    }

    function _findClaimable(uint256 seed) internal view returns (uint256) {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            (uint16 periods,) = escrow.claimable(id);
            if (periods > 0) return id;
        }
        return 0;
    }

    /// @dev Fully funded only: closeLease reverts RentNotFullyFunded on an underfunded monthly
    ///      lease (that one belongs to claimDefault), and fail_on_revert is on.
    function _findClosable(uint256 seed) internal view returns (uint256) {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            if (
                l.state == IRentEscrowV2.State.ACTIVE && l.periodsFunded == l.periods
                    && block.timestamp >= escrow.endTime(id)
            ) {
                return id;
            }
        }
        return 0;
    }

    /// @dev An ACTIVE monthly lease with periods still to fund.
    function _findPayable(uint256 seed) internal view returns (uint256) {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            if (l.state == IRentEscrowV2.State.ACTIVE && l.monthly && l.periodsFunded < l.periods) return id;
        }
        return 0;
    }

    /// @dev An ACTIVE monthly lease whose unfunded period is one full period (the grace) past due.
    function _findDefaultable(uint256 seed) internal view returns (uint256) {
        uint256 n = _count();
        for (uint256 i; i < n; i++) {
            uint256 id = 1 + (seed % n + i) % n;
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            if (l.state != IRentEscrowV2.State.ACTIVE || !l.monthly || l.periodsFunded >= l.periods) continue;
            if (block.timestamp >= uint256(l.startTime) + uint256(l.periodsFunded) * l.periodSeconds + l.periodSeconds)
            {
                return id;
            }
        }
        return 0;
    }
}

/// @notice INV-1..INV-6 from IRentEscrowV2's NatSpec, checked after every handler call.
contract RentEscrowV2InvariantTest is Test {
    MockUSDC internal musd;
    LeaseShare1155 internal shares;
    RentEscrowV2 internal escrow;
    EscrowV2Handler internal handler;

    address internal arbiter = makeAddr("arbiter");
    address internal keeper = makeAddr("keeper");

    /// @dev Dispute timeouts short enough for the fuzzer to reach within a run.
    uint64 internal constant DISPUTE_TIMEOUT = 4 hours;

    function setUp() public {
        vm.warp(1_700_000_000);
        musd = new MockUSDC();
        shares = new LeaseShare1155(address(this), "https://rentouts.co/api/lease-share/{id}.json");
        MockBorrowerOperationsSignatures mezo = new MockBorrowerOperationsSignatures(MintableMUSD(address(musd)));
        // Funding goes through a HumanGate with a verifier plugged in, as it will with World ID.
        MockHumanVerifier verifier = new MockHumanVerifier();
        HumanGate gate = new HumanGate(address(this), address(verifier));
        escrow = new RentEscrowV2(
            IERC20(address(musd)), arbiter, address(shares), address(gate), address(mezo), DISPUTE_TIMEOUT
        );
        shares.setMinter(address(escrow));

        // Actors hold known keys: borrowAndFund signs a real OpenTrove digest for the tenant.
        address[] memory actors = new address[](4);
        uint256[] memory keys = new uint256[](4);
        actors[0] = vm.addr(0x61); // alice
        actors[1] = vm.addr(0x62); // bob
        actors[2] = vm.addr(0x63); // carol
        actors[3] = vm.addr(0x64); // dave
        keys[0] = 0x61;
        keys[1] = 0x62;
        keys[2] = 0x63;
        keys[3] = 0x64;
        for (uint256 i; i < actors.length; i++) {
            shares.setAllowlist(actors[i], true); // every actor may list as a landlord
            verifier.setVerified(actors[i], true); // and fund as a verified tenant
        }

        handler = new EscrowV2Handler(escrow, musd, mezo, arbiter, keeper, actors, keys);

        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = EscrowV2Handler.createLease.selector;
        selectors[1] = EscrowV2Handler.createLeaseMonthly.selector;
        selectors[2] = EscrowV2Handler.cancelLease.selector;
        selectors[3] = EscrowV2Handler.fundLease.selector;
        selectors[4] = EscrowV2Handler.borrowAndFund.selector;
        selectors[5] = EscrowV2Handler.withdrawAndFund.selector;
        selectors[6] = EscrowV2Handler.payRent.selector;
        selectors[7] = EscrowV2Handler.warp.selector;
        selectors[8] = EscrowV2Handler.claimRent.selector;
        selectors[9] = EscrowV2Handler.closeLease.selector;
        selectors[10] = EscrowV2Handler.openDispute.selector;
        selectors[11] = EscrowV2Handler.resolveDispute.selector;
        selectors[12] = EscrowV2Handler.resolveByTimeout.selector;
        selectors[13] = EscrowV2Handler.proposeTermination.selector;
        selectors[14] = EscrowV2Handler.acceptTermination.selector;
        selectors[15] = EscrowV2Handler.withdrawTermination.selector;
        selectors[16] = EscrowV2Handler.strayTransfer.selector;
        selectors[17] = EscrowV2Handler.returnUnbooked.selector;
        selectors[18] = EscrowV2Handler.claimDefault.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Coverage guard, not an escrow invariant: every run must settle at least one lease (close,
    /// ruling, timeout, accepted termination or a default), so INV-1..INV-7 are checked against
    /// real payouts and not just creation and funding. Kept loose on purpose: at depth 256 each
    /// path is hit in nearly every run, but a per-path minimum could flake.
    function afterInvariant() public {
        uint256 settled = handler.calls("closeLease") + handler.calls("resolveDispute")
            + handler.calls("resolveByTimeout") + handler.calls("acceptTermination") + handler.calls("claimDefault");
        assertGt(settled, 0, "run settled no lease: the handler never reached a settlement");
    }

    /// INV-1: funds only ever move to the lease's tenant or landlord (no owner, no fee, no admin).
    function invariant_INV1_FundsOnlyReachLeaseParties() public {
        assertEq(handler.ghostOutToNonParty(), 0, "escrow paid a non-party");
        assertEq(handler.ghostWrongPayout(), 0, "a funding or settlement paid the wrong amount");
        // Nobody outside the actor set ever holds tokens: not the arbiter, keeper, or share issuer.
        assertEq(musd.balanceOf(arbiter), 0, "arbiter holds tokens");
        assertEq(musd.balanceOf(keeper), 0, "keeper holds tokens");
        assertEq(musd.balanceOf(address(this)), 0, "issuer holds tokens");
        // Each actor's balance is exactly what it was minted, minus what it escrowed, plus what the
        // escrow paid it as a tenant/landlord (borrow funding refunds count as payments back): the
        // log-based ledger misses no transfer.
        for (uint256 i; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(
                musd.balanceOf(a),
                handler.ghostMinted(a) - handler.ghostPaidIn(a) + handler.ghostReceived(a),
                "actor ledger mismatch"
            );
        }
    }

    /// INV-2: each lease's escrowBalance is exactly its remaining terms (deposit + FUNDED unclaimed
    /// rent — for a prepaid lease periodsFunded == periods, so the formula is the V1 one), and the
    /// balances sum to totalEscrowed. The token balance may sit above the sum: that difference is
    /// the unbooked pot (INV-6), which belongs to no lease.
    function invariant_INV2_EscrowBalancesSumToTotalEscrowed() public {
        uint256 n = escrow.nextLeaseId();
        uint256 sum;
        for (uint256 id = 1; id < n; id++) {
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            uint256 bal = escrow.escrowBalance(id);
            sum += bal;
            if (l.state == IRentEscrowV2.State.ACTIVE || l.state == IRentEscrowV2.State.DISPUTED) {
                assertEq(
                    bal,
                    uint256(l.deposit) + uint256(l.rentPerPeriod) * (l.periodsFunded - l.periodsClaimed),
                    "live lease holds other than deposit + funded unclaimed rent"
                );
            } else {
                assertEq(bal, 0, "settled/unfunded lease holds escrow");
            }
        }
        assertEq(sum, escrow.totalEscrowed(), "sum(escrowBalance) != totalEscrowed");
    }

    /// INV-3: rent released for a lease never exceeds rentPerPeriod * elapsed periods (capped at term).
    function invariant_INV3_RentNeverExceedsElapsedPeriods() public {
        uint256 n = escrow.nextLeaseId();
        uint256 nowTs = handler.currentTime();
        for (uint256 id = 1; id < n; id++) {
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            uint256 released = handler.ghostRentReleased(id);
            if (l.startTime == 0) {
                assertEq(released, 0, "rent released before funding");
                continue;
            }
            uint256 elapsed = (nowTs - l.startTime) / l.periodSeconds;
            if (elapsed > l.periods) elapsed = l.periods;
            assertLe(l.periodsClaimed, elapsed, "claimed periods ahead of time");
            assertLe(released, uint256(l.rentPerPeriod) * elapsed, "rent released ahead of time");
            assertEq(released, uint256(l.rentPerPeriod) * l.periodsClaimed, "rent ledger mismatch");
        }
    }

    /// INV-4: a settlement (arbiter ruling, dispute timeout or accepted mutual termination) pays out
    /// exactly the lease's remaining escrow, split between tenant and landlord.
    function invariant_INV4_SettlementPaysOutExactlyRemainingEscrow() public {
        assertEq(handler.ghostBadSplit(), 0, "settlement split mismatch");
        uint256 n = escrow.nextLeaseId();
        for (uint256 id = 1; id < n; id++) {
            if (!handler.ghostResolved(id)) continue;
            assertEq(handler.ghostResolvePayout(id), handler.ghostEscrowAtResolve(id), "payout != remaining escrow");
            assertEq(escrow.escrowBalance(id), 0, "settled lease still holds escrow");
            assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
        }
    }

    /// INV-5: a lease is only ever booked as funded with at least the MUSD its terms require, and
    /// never with more than arrived: any surplus is refunded to the tenant in the same transaction.
    /// "Its terms" follows the funding mode: deposit + all rent prepaid, deposit + the periods paid
    /// in so far on a monthly lease (never more than the full term).
    function invariant_INV5_BorrowFundingBooksExactlyWhatArrived() public {
        uint256 n = escrow.nextLeaseId();
        for (uint256 id = 1; id < n; id++) {
            IRentEscrowV2.Lease memory l = escrow.getLease(id);
            uint256 owed = uint256(l.deposit) + uint256(l.rentPerPeriod) * l.periodsFunded;
            assertLe(escrow.escrowBalance(id), owed, "lease holds more than its funded terms require");
            assertLe(owed, uint256(l.deposit) + uint256(l.rentPerPeriod) * l.periods, "funded past the term");
            if (l.state == IRentEscrowV2.State.ACTIVE && l.periodsClaimed == 0) {
                assertEq(escrow.escrowBalance(id), owed, "an unclaimed live lease holds exactly deposit + funded rent");
            }
        }
    }

    /// INV-6: the escrow's token balance is never below totalEscrowed (leases always hold real
    /// MUSD), and the balance beyond it is exactly the unbooked pot the handler tracked — stray
    /// transfers in, arbiter returns out, and nothing else ever moves it.
    function invariant_INV6_UnbookedPotMatchesTheLedger() public {
        assertLe(
            escrow.totalEscrowed(),
            musd.balanceOf(address(escrow)),
            "token balance fell below totalEscrowed: a lease's escrow was spent"
        );
        assertEq(
            musd.balanceOf(address(escrow)) - escrow.totalEscrowed(),
            handler.ghostUnbooked(),
            "balance beyond totalEscrowed != unbooked ledger"
        );
        assertEq(escrow.unbookedBalance(), handler.ghostUnbooked(), "unbookedBalance() != ledger");
    }

    /// INV-7: no lease ever pays out more than it took in. The handler's per-lease ledger books
    /// every MUSD the escrow booked INTO the lease (funding + payRent; borrow-path surplus refunds
    /// never enter it — they were never lease money) against every MUSD the escrow paid OUT to that
    /// lease's parties. A settled (CLOSED/CANCELLED) lease must have paid out exactly what it took
    /// in; a live one at most that.
    function invariant_INV7_NoLeasePaysOutMoreThanItTookIn() public {
        uint256 n = escrow.nextLeaseId();
        for (uint256 id = 1; id < n; id++) {
            assertLe(handler.ghostLeasePaidOut(id), handler.ghostLeasePaidIn(id), "lease paid out more than it took in");
            IRentEscrowV2.State s = escrow.getLease(id).state;
            if (s == IRentEscrowV2.State.CLOSED || s == IRentEscrowV2.State.CANCELLED) {
                assertEq(
                    handler.ghostLeasePaidOut(id),
                    handler.ghostLeasePaidIn(id),
                    "settled lease did not pay out exactly what it took in"
                );
            }
        }
    }
}
