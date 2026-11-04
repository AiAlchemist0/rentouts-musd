// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {IRentEscrowV2} from "../src/interfaces/IRentEscrowV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {HumanGate} from "../src/HumanGate.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";
import {MockHumanVerifier} from "./helpers/MockHumanVerifier.sol";
import {MockBorrowerOperationsSignatures, MintableMUSD} from "./helpers/MockBorrowerOperationsSignatures.sol";
import {MezoSignatures} from "./helpers/MezoSignatures.sol";

/// @notice RentEscrowV2 unit tests: the three Wave-2 additions on top of the V1 behaviour, plus a
///         parity smoke test for the V1 paths that now share their bookkeeping with the new ones.
contract RentEscrowV2Test is Test {
    MockUSDC internal musd;
    LeaseShare1155 internal shares;
    MockBorrowerOperationsSignatures internal mezo;
    RentEscrowV2 internal escrow;

    address internal issuer = makeAddr("issuer"); // LeaseShare1155 owner
    address internal arbiter = makeAddr("arbiter");
    address internal landlord = makeAddr("landlord"); // allowlisted
    address internal stranger = makeAddr("stranger");

    /// @dev The tenant needs a known key: it signs the Mezo trove operations the escrow relays.
    uint256 internal constant TENANT_KEY = 0xA11CE;
    address internal tenant;

    uint128 internal constant DEPOSIT = 300e6;
    uint128 internal constant RENT = 100e6; // 100 MUSD / period
    uint32 internal constant PERIOD = 1 days;
    uint16 internal constant PERIODS = 3;
    uint256 internal constant TOTAL = uint256(DEPOSIT) + uint256(RENT) * PERIODS;

    uint64 internal constant TIMEOUT = 7 days;
    uint256 internal constant COLLATERAL = 0.05 ether; // mock BTC attached to borrowAndFund

    function setUp() public {
        vm.warp(1_700_000_000);
        tenant = vm.addr(TENANT_KEY);
        musd = new MockUSDC();
        shares = new LeaseShare1155(issuer, "https://rentouts.co/api/lease-share/{id}.json");
        mezo = new MockBorrowerOperationsSignatures(MintableMUSD(address(musd)));
        escrow = new RentEscrowV2(IERC20(address(musd)), arbiter, address(shares), address(0), address(mezo), TIMEOUT);

        vm.startPrank(issuer);
        shares.setMinter(address(escrow));
        shares.setAllowlist(landlord, true);
        vm.stopPrank();
        vm.deal(tenant, 1 ether); // BTC for the collateral the escrow forwards
    }

    // ------------------------------------------------------------------ helpers

    function _create() internal returns (uint256 id) {
        vm.prank(landlord);
        id = escrow.createLease(tenant, DEPOSIT, RENT, PERIOD, PERIODS);
    }

    function _fund(uint256 id) internal {
        musd.mint(tenant, TOTAL);
        vm.startPrank(tenant);
        musd.approve(address(escrow), TOTAL);
        escrow.fundLease(id);
        vm.stopPrank();
    }

    function _createAndFund() internal returns (uint256 id) {
        id = _create();
        _fund(id);
    }

    function _dispute(uint256 id) internal {
        vm.prank(tenant);
        escrow.openDispute(id);
    }

    function _invalidState(uint256 id, IRentEscrowV2.State s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IRentEscrowV2.InvalidState.selector, id, s);
    }

    function _openSig(uint256 debt, uint256 value, uint256 deadline) internal view returns (bytes memory) {
        return MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.openTroveDigest(
                address(mezo), value, debt, tenant, address(escrow), mezo.getNonce(tenant), deadline
            )
        );
    }

    function _withdrawSig(uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.withdrawMUSDDigest(
                address(mezo), amount, tenant, address(escrow), mezo.getNonce(tenant), deadline
            )
        );
    }

    /// @dev Signs before the prank: evaluating the signature arguments would otherwise consume it
    ///      (MezoSignatures reads the mock's nonce).
    function _borrowAndFund(uint256 id, uint256 debt) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(debt, COLLATERAL, deadline);
        vm.prank(tenant);
        escrow.borrowAndFund{value: COLLATERAL}(id, debt, address(0), address(0), sig, deadline);
    }

    function _withdrawAndFund(uint256 id, uint256 amount) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(amount, deadline);
        vm.prank(tenant);
        escrow.withdrawAndFund(id, amount, address(0), address(0), sig, deadline);
    }

    function _termsHash(uint256 id, address proposer, uint128 penalty, uint64 expiry) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, proposer, penalty, expiry));
    }

    // ------------------------------------------------------------------ config

    function test_Config() public {
        assertEq(escrow.token(), address(musd));
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.leaseShare(), address(shares));
        assertEq(escrow.humanGate(), address(0));
        assertEq(escrow.borrowerOpsSignatures(), address(mezo));
        assertEq(escrow.disputeTimeout(), TIMEOUT);
        assertEq(escrow.SHARES_PER_LEASE(), 100);
        assertEq(escrow.MIN_PERIOD(), 60);
        assertEq(escrow.nextLeaseId(), 1);
        assertEq(escrow.disputeOpenedAt(1), 0);
        IRentEscrowV2.Termination memory none = escrow.termination(1);
        assertEq(none.proposer, address(0));
    }

    function test_Constructor_RevertsOnZeroTokenOrArbiter() public {
        vm.expectRevert(RentEscrowV2.ZeroAddress.selector);
        new RentEscrowV2(IERC20(address(0)), arbiter, address(0), address(0), address(0), TIMEOUT);
        vm.expectRevert(RentEscrowV2.ZeroAddress.selector);
        new RentEscrowV2(IERC20(address(musd)), address(0), address(0), address(0), address(0), TIMEOUT);
        vm.expectRevert(IRentEscrowV2.ZeroDisputeTimeout.selector);
        new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(0), address(0), 0);
    }

    // ------------------------------------------------------------------ borrowAndFund

    function test_BorrowAndFund_OpensTroveAndFundsInOneTx() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseFunded(id, tenant, TOTAL, uint64(block.timestamp));
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseBorrowFunded(id, tenant, TOTAL, TOTAL, 0);
        vm.prank(tenant);
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);

        // The lease is booked exactly like a fundLease.
        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(uint8(l.state), uint8(IRentEscrowV2.State.ACTIVE));
        assertEq(l.startTime, block.timestamp);
        assertEq(escrow.escrowBalance(id), TOTAL);
        assertEq(musd.balanceOf(address(escrow)), TOTAL);
        assertEq(escrow.endTime(id), block.timestamp + uint256(PERIOD) * PERIODS);
        assertEq(escrow.tenantStats(tenant).leasesFunded, 1);
        assertEq(musd.balanceOf(tenant), 0, "no refund when the debt is exactly the owed amount");

        // The relayed trove operation: borrower is the tenant, recipient is the escrow, the
        // collateral arrived, and the signature (so the nonce) was consumed.
        assertEq(mezo.lastBorrower(), tenant);
        assertEq(mezo.lastRecipient(), address(escrow));
        assertEq(mezo.lastCaller(), address(escrow));
        assertEq(mezo.lastDebtAmount(), TOTAL);
        assertEq(mezo.lastAssetAmount(), COLLATERAL);
        assertTrue(mezo.troveOpened());
        assertEq(mezo.getNonce(tenant), 1);
        assertEq(address(mezo).balance, COLLATERAL); // the BTC went through to the (mock) protocol
        assertEq(address(escrow).balance, 0); // the escrow never holds BTC
    }

    function test_BorrowAndFund_SurplusRefundedToTenant() public {
        uint256 id = _create();
        uint256 surplus = 137e6;
        _borrowAndFund(id, TOTAL + surplus);

        assertEq(escrow.escrowBalance(id), TOTAL, "only the owed amount is booked");
        assertEq(musd.balanceOf(address(escrow)), TOTAL);
        assertEq(musd.balanceOf(tenant), surplus);
        assertEq(mezo.lastDebtAmount(), TOTAL + surplus);
    }

    function test_BorrowAndFund_RevertsWhenDebtBelowOwed() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL - 1, COLLATERAL, deadline);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InsufficientBorrowed.selector, id, TOTAL - 1, TOTAL));
        vm.prank(tenant);
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL - 1, address(0), address(0), sig, deadline);

        // The whole transaction unwound: no trove, no booking, no nonce consumed.
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CREATED));
        assertEq(escrow.escrowBalance(id), 0);
        assertFalse(mezo.troveOpened());
        assertEq(mezo.getNonce(tenant), 0);
        assertEq(address(mezo).balance, 0);
    }

    function test_BorrowAndFund_RevertsOnWrongSigner() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = MezoSignatures.sign(
            0xBAD, // not the tenant
            MezoSignatures.openTroveDigest(
                address(mezo), COLLATERAL, TOTAL, tenant, address(escrow), mezo.getNonce(tenant), deadline
            )
        );
        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
        assertEq(mezo.getNonce(tenant), 0);
    }

    function test_BorrowAndFund_RevertsOnExpiredDeadline() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp - 1; // Mezo checks deadline inclusively
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);
        vm.prank(tenant);
        vm.expectRevert(bytes("Signature expired"));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
    }

    function test_BorrowAndFund_RevertsOnReplayedSignature() public {
        // Two identical leases make an identical digest (same tenant, recipient, amounts), so the
        // second use of the signature hits the moved nonce.
        uint256 a = _create();
        uint256 b = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);

        vm.prank(tenant);
        escrow.borrowAndFund{value: COLLATERAL}(a, TOTAL, address(0), address(0), sig, deadline);
        assertEq(mezo.getNonce(tenant), 1);

        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.borrowAndFund{value: COLLATERAL}(b, TOTAL, address(0), address(0), sig, deadline);
        assertEq(uint8(escrow.getLease(b).state), uint8(IRentEscrowV2.State.CREATED));
    }

    function test_BorrowAndFund_SignatureCoversTheCollateral() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline); // signed for COLLATERAL...
        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.borrowAndFund{value: COLLATERAL + 1}(id, TOTAL, address(0), address(0), sig, deadline); // ...sent more
    }

    function test_BorrowAndFund_RevertsForNonTenant() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);
        vm.deal(landlord, 1 ether); // the call is payable: non-tenants must reach the check
        vm.deal(stranger, 1 ether);
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotTenant.selector, id));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotTenant.selector, id));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
    }

    function test_BorrowAndFund_RevertsUnlessCreated() public {
        uint256 id = _createAndFund();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);
        vm.prank(tenant);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.ACTIVE));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
        vm.prank(tenant);
        vm.expectRevert(_invalidState(7, IRentEscrowV2.State.NONE));
        escrow.borrowAndFund{value: COLLATERAL}(7, TOTAL, address(0), address(0), sig, deadline);
    }

    function test_BorrowAndFund_HumanGateAppliesToBorrowedFundsToo() public {
        MockHumanVerifier verifier = new MockHumanVerifier();
        HumanGate gate = new HumanGate(address(this), address(verifier));
        RentEscrowV2 gated =
            new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(gate), address(mezo), TIMEOUT);
        uint256 id = gated.createLease(tenant, DEPOSIT, RENT, PERIOD, PERIODS);

        uint256 deadline = block.timestamp + 1 hours;
        // The digest names the gated escrow as recipient.
        bytes memory sig = MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.openTroveDigest(
                address(mezo), COLLATERAL, TOTAL, tenant, address(gated), mezo.getNonce(tenant), deadline
            )
        );
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotVerifiedHuman.selector, tenant));
        gated.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
        assertFalse(mezo.troveOpened(), "the trove must not open for an unverified tenant");
        assertEq(mezo.getNonce(tenant), 0);

        verifier.setVerified(tenant, true);
        vm.prank(tenant);
        gated.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);
        assertEq(gated.escrowBalance(id), TOTAL);
    }

    function test_BorrowAndFund_DisabledReverts() public {
        RentEscrowV2 disabled =
            new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(0), address(0), TIMEOUT);
        vm.prank(tenant);
        vm.expectRevert(IRentEscrowV2.MezoDisabled.selector);
        disabled.borrowAndFund{value: COLLATERAL}(1, TOTAL, address(0), address(0), "", 0);
        vm.prank(tenant);
        vm.expectRevert(IRentEscrowV2.MezoDisabled.selector);
        disabled.withdrawAndFund(1, TOTAL, address(0), address(0), "", 0);
    }

    // ------------------------------------------------------------------ withdrawAndFund

    function test_WithdrawAndFund_MintsAgainstTroveAndFunds() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(TOTAL, deadline);

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseFunded(id, tenant, TOTAL, uint64(block.timestamp));
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseBorrowFunded(id, tenant, TOTAL, TOTAL, 0);
        vm.prank(tenant);
        escrow.withdrawAndFund(id, TOTAL, address(0), address(0), sig, deadline);

        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.ACTIVE));
        assertEq(escrow.escrowBalance(id), TOTAL);
        assertEq(musd.balanceOf(address(escrow)), TOTAL);
        assertEq(mezo.lastBorrower(), tenant);
        assertEq(mezo.lastRecipient(), address(escrow));
        assertTrue(mezo.musdWithdrawn());
        assertEq(mezo.getNonce(tenant), 1);
        assertEq(address(escrow).balance, 0, "the zero-value BTC touch left nothing"); // see receive()
    }

    /// @dev Mezo's MUSD-withdraw path always BTC-transfers the caller its (zero) collateral delta
    ///      — see RentEscrowV2.receive: that zero-value touch must succeed, while any real BTC
    ///      (nothing could ever spend it) bounces back to its sender with StrayBtc.
    function test_ReceiveAcceptsOnlyMezoZeroValueBtcTouch() public {
        uint256 id = _create();
        (bool ok,) = address(escrow).call{value: 0}("");
        assertTrue(ok, "the zero-value BTC touch must succeed");
        assertEq(address(escrow).balance, 0);

        vm.deal(address(this), 1 wei);
        bytes memory ret;
        (ok, ret) = address(escrow).call{value: 1 wei}("");
        assertFalse(ok, "non-zero BTC must bounce");
        assertEq(ret, abi.encodeWithSelector(IRentEscrowV2.StrayBtc.selector, 1 wei));
        assertEq(address(escrow).balance, 0, "non-zero BTC bounced back");
        assertEq(address(this).balance, 1 wei, "the sender keeps its BTC");

        // The MUSD flow is unaffected either way.
        _withdrawAndFund(id, TOTAL);
        assertEq(escrow.escrowBalance(id), TOTAL, "only the measured MUSD delta is booked");
        assertEq(escrow.unbookedBalance(), 0);
        assertEq(address(escrow).balance, 0, "the MUSD flow never touches BTC");
    }

    function test_WithdrawAndFund_SurplusRefundedToTenant() public {
        uint256 id = _create();
        _withdrawAndFund(id, TOTAL + 55e6);
        assertEq(escrow.escrowBalance(id), TOTAL);
        assertEq(musd.balanceOf(tenant), 55e6);
    }

    // ------------------------------------------------------- front-running (signature copy)

    /// @dev BorrowerOperationsSignatures has no msg.sender restriction: a watcher can copy the
    ///      tenant's pending signature and relay it to Mezo directly, recipient = the escrow. The
    ///      tenant's nonce is spent and their debt grows, but no lease is booked; the MUSD sits in
    ///      the unbooked pot until the arbiter returns it. The tenant loses nothing: they can
    ///      always fall back to fundLease.
    function test_FrontRun_CopiedWithdrawSignatureIsRecoverable() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(TOTAL, deadline);

        // The watcher (an EOA that can take Mezo's zero-value BTC touch) relays the copied
        // signature straight to Mezo, not through the escrow.
        vm.prank(stranger);
        mezo.withdrawMUSDWithSignature(TOTAL, address(0), address(0), tenant, address(escrow), sig, deadline);
        assertEq(mezo.lastCaller(), stranger, "the watcher, not the escrow, called the relay");
        assertEq(musd.balanceOf(address(escrow)), TOTAL, "the mint landed on the escrow");
        assertEq(escrow.unbookedBalance(), TOTAL, "but it is booked to no lease");
        assertEq(escrow.escrowBalance(id), 0);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CREATED), "lease untouched");

        // The tenant's own withdrawAndFund now reverts: the nonce is spent.
        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.withdrawAndFund(id, TOTAL, address(0), address(0), sig, deadline);

        // Fall back: the tenant funds the lease the ordinary way; the stray MUSD stays apart.
        _fund(id);
        assertEq(escrow.escrowBalance(id), TOTAL);
        assertEq(escrow.totalEscrowed(), TOTAL);
        assertEq(escrow.unbookedBalance(), TOTAL, "funding never touches the unbooked pot");

        // The arbiter returns the stray MUSD to the tenant (the Mezo event logs name them).
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.UnbookedReturned(tenant, TOTAL);
        vm.prank(arbiter);
        escrow.returnUnbooked(tenant, TOTAL);
        assertEq(musd.balanceOf(tenant), TOTAL);
        assertEq(escrow.unbookedBalance(), 0);
        assertEq(escrow.escrowBalance(id), TOTAL, "the lease's own escrow was never touched");
    }

    /// @dev Same with a copied OpenTrove signature: the watcher even has to pay the BTC collateral
    ///      themselves, and the minted MUSD is still recoverable the same way.
    function test_FrontRun_CopiedOpenTroveSignatureIsRecoverable() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _openSig(TOTAL, COLLATERAL, deadline);
        vm.deal(stranger, COLLATERAL); // the watcher pays the collateral themselves

        vm.prank(stranger);
        mezo.openTroveWithSignature{value: COLLATERAL}(
            TOTAL, address(0), address(0), tenant, address(escrow), sig, deadline
        );
        assertTrue(mezo.troveOpened());
        assertEq(mezo.lastCaller(), stranger, "the watcher, not the escrow, called the relay");
        assertEq(escrow.unbookedBalance(), TOTAL);

        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.borrowAndFund{value: COLLATERAL}(id, TOTAL, address(0), address(0), sig, deadline);

        vm.prank(arbiter);
        escrow.returnUnbooked(tenant, TOTAL);
        assertEq(musd.balanceOf(tenant), TOTAL);
        assertEq(escrow.unbookedBalance(), 0);
    }

    function test_ReturnUnbooked_IsArbiterOnly() public {
        vm.prank(stranger);
        vm.expectRevert(IRentEscrowV2.NotArbiter.selector);
        escrow.returnUnbooked(tenant, 1);
        vm.prank(tenant);
        vm.expectRevert(IRentEscrowV2.NotArbiter.selector);
        escrow.returnUnbooked(tenant, 1);
        vm.prank(landlord);
        vm.expectRevert(IRentEscrowV2.NotArbiter.selector);
        escrow.returnUnbooked(tenant, 1);
    }

    /// @dev The arbiter can hand back the unbooked pot and nothing else: never more than it holds,
    ///      and never a wei of a lease's escrow.
    function test_ReturnUnbooked_NeverTouchesALeaseEscrow() public {
        uint256 id = _createAndFund();
        assertEq(escrow.unbookedBalance(), 0, "a funded lease leaves nothing unbooked");

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InsufficientUnbooked.selector, 1, 0));
        escrow.returnUnbooked(tenant, 1);

        vm.prank(arbiter);
        vm.expectRevert(RentEscrowV2.ZeroAddress.selector);
        escrow.returnUnbooked(address(0), 0);

        // A stray transfer of 40 MUSD: returnable in full, never beyond it.
        musd.mint(stranger, 40e6);
        vm.prank(stranger);
        musd.transfer(address(escrow), 40e6);
        assertEq(escrow.unbookedBalance(), 40e6);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InsufficientUnbooked.selector, 40e6 + 1, 40e6));
        escrow.returnUnbooked(tenant, 40e6 + 1);

        vm.prank(arbiter);
        escrow.returnUnbooked(stranger, 40e6);
        assertEq(musd.balanceOf(stranger), 40e6);
        assertEq(escrow.unbookedBalance(), 0);
        assertEq(escrow.escrowBalance(id), TOTAL, "the lease's escrow was never reachable");
        assertEq(escrow.totalEscrowed(), TOTAL);
    }

    function test_WithdrawAndFund_RevertsWhenAmountBelowOwed() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(TOTAL / 2, deadline);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InsufficientBorrowed.selector, id, TOTAL / 2, TOTAL));
        vm.prank(tenant);
        escrow.withdrawAndFund(id, TOTAL / 2, address(0), address(0), sig, deadline);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CREATED));
    }

    function test_WithdrawAndFund_RevertsOnWrongSignerAndReplay() public {
        uint256 a = _create();
        uint256 b = _create();
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory badSig = MezoSignatures.sign(
            0xBAD,
            MezoSignatures.withdrawMUSDDigest(
                address(mezo), TOTAL, tenant, address(escrow), mezo.getNonce(tenant), deadline
            )
        );
        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.withdrawAndFund(a, TOTAL, address(0), address(0), badSig, deadline);

        bytes memory sig = _withdrawSig(TOTAL, deadline);
        vm.prank(tenant);
        escrow.withdrawAndFund(a, TOTAL, address(0), address(0), sig, deadline);
        vm.prank(tenant);
        vm.expectRevert(bytes("BorrowerOperationsSignatures: Invalid signature"));
        escrow.withdrawAndFund(b, TOTAL, address(0), address(0), sig, deadline); // replayed
    }

    function test_WithdrawAndFund_RevertsForNonTenantAndWrongState() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(TOTAL, deadline);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotTenant.selector, id));
        escrow.withdrawAndFund(id, TOTAL, address(0), address(0), sig, deadline);

        uint256 funded = _createAndFund();
        bytes memory sig2 = _withdrawSig(TOTAL, deadline);
        vm.prank(tenant);
        vm.expectRevert(_invalidState(funded, IRentEscrowV2.State.ACTIVE));
        escrow.withdrawAndFund(funded, TOTAL, address(0), address(0), sig2, deadline);
    }

    function test_WithdrawAndFund_IsNotPayable() public {
        uint256 id = _create();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(TOTAL, deadline);
        vm.deal(tenant, 1 ether);
        vm.prank(tenant);
        (bool ok,) = address(escrow).call{value: 1}(
            abi.encodeCall(IRentEscrowV2.withdrawAndFund, (id, TOTAL, address(0), address(0), sig, deadline))
        );
        assertFalse(ok, "withdrawAndFund accepted BTC");
        assertEq(address(escrow).balance, 0);
    }

    // ------------------------------------------------------------------ V1 behaviour parity

    function test_V1Paths_FundClaimCloseUnchanged() public {
        uint256 id = _createAndFund();
        vm.warp(escrow.endTime(id));
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseClosed(id, tenant, DEPOSIT, uint256(RENT) * PERIODS);
        vm.prank(landlord);
        escrow.closeLease(id);

        assertEq(musd.balanceOf(landlord), uint256(RENT) * PERIODS);
        assertEq(musd.balanceOf(tenant), DEPOSIT);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesFunded, 1);
        assertEq(s.leasesCompleted, 1);
        assertEq(s.leasesDisputed, 0);
        assertEq(s.leasesTerminatedEarly, 0);
        assertEq(s.depositsPosted, DEPOSIT);
        assertEq(s.depositsReturned, DEPOSIT);
    }

    function test_V1Paths_FundLeaseStillPullsAndChecks() public {
        uint256 id = _create();
        musd.mint(tenant, TOTAL);
        vm.prank(tenant);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(escrow), 0, TOTAL)
        );
        escrow.fundLease(id);
        _fund(id);
        assertEq(escrow.escrowBalance(id), TOTAL);
    }

    function test_V1Paths_ArbiterStillRulesDisputes() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + PERIOD); // one period earned, none claimed: the whole pot splits
        _dispute(id);
        vm.prank(arbiter);
        escrow.resolveDispute(id, 5_000);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
        assertEq(musd.balanceOf(tenant), TOTAL / 2);
        assertEq(musd.balanceOf(landlord), TOTAL / 2);
        assertEq(escrow.tenantStats(tenant).leasesDisputed, 1);
        assertEq(escrow.tenantStats(tenant).leasesTerminatedEarly, 0);
    }

    // ------------------------------------------------------------------ mutual early termination

    function test_Termination_TenantProposesLandlordAccepts() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + PERIOD + PERIOD / 2); // 1.5 periods: one earned, two unearned

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.TerminationProposed(id, tenant, 50e6, uint64(block.timestamp + 1 hours));
        vm.prank(tenant);
        escrow.proposeTermination(id, 50e6, uint64(block.timestamp + 1 hours));

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.TerminationAccepted(id, landlord, TOTAL - RENT - 50e6, RENT + 50e6);
        vm.prank(landlord);
        escrow.acceptTermination(id, _termsHash(id, tenant, 50e6, uint64(block.timestamp + 1 hours)));

        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(uint8(l.state), uint8(IRentEscrowV2.State.CLOSED));
        assertEq(l.periodsClaimed, 1, "the earned period leaves as if claimed");
        assertEq(escrow.escrowBalance(id), 0);
        assertEq(musd.balanceOf(landlord), RENT + 50e6, "earned rent + penalty");
        assertEq(musd.balanceOf(tenant), TOTAL - RENT - 50e6, "unearned rent + deposit - penalty");
        assertEq(musd.balanceOf(address(escrow)), 0);

        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesTerminatedEarly, 1);
        assertEq(s.leasesCompleted, 0);
        assertEq(s.leasesDisputed, 0);
        assertEq(s.periodsPaid, 1);
        assertEq(s.rentPaid, RENT);
        assertEq(s.depositsPosted, DEPOSIT);
        assertEq(s.depositsReturned, DEPOSIT - 50e6);
        IRentEscrowV2.Termination memory noneLeft = escrow.termination(id);
        assertEq(noneLeft.proposer, address(0), "the proposal is consumed");
    }

    function test_Termination_LandlordProposesTenantAccepts() public {
        uint256 id = _createAndFund();
        vm.prank(landlord);
        escrow.proposeTermination(id, 0, uint64(block.timestamp + 1 hours));

        vm.prank(tenant);
        escrow.acceptTermination(id, _termsHash(id, landlord, 0, uint64(block.timestamp + 1 hours)));

        // At move-in with no penalty: the tenant gets everything back.
        assertEq(musd.balanceOf(tenant), TOTAL);
        assertEq(musd.balanceOf(landlord), 0);
        assertEq(escrow.tenantStats(tenant).leasesTerminatedEarly, 1);
        assertEq(escrow.tenantStats(tenant).depositsReturned, DEPOSIT);
    }

    function test_Termination_ClaimedRentStaysWithTheLandlord() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + 2 * uint256(PERIOD));
        escrow.claimRent(id); // two periods released before anyone proposes
        assertEq(musd.balanceOf(landlord), 2 * uint256(RENT));

        uint64 expiry = uint64(block.timestamp + 2 days); // survives the half-period warp below
        vm.prank(landlord);
        escrow.proposeTermination(id, 25e6, expiry);
        vm.warp(block.timestamp + PERIOD / 2); // no new period elapses
        vm.prank(tenant);
        escrow.acceptTermination(id, _termsHash(id, landlord, 25e6, expiry));

        assertEq(musd.balanceOf(landlord), 2 * uint256(RENT) + 25e6, "no earned-but-unclaimed rent left");
        assertEq(musd.balanceOf(tenant), DEPOSIT + RENT - 25e6, "last period unearned + deposit - penalty");
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.periodsPaid, 2);
        assertEq(s.rentPaid, 2 * uint256(RENT));
        assertEq(s.depositsReturned, DEPOSIT - 25e6);
    }

    function test_Termination_ProposeRevertsAboveTheTenantSide() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + PERIOD); // elapsed 1: tenant side = 2 unearned + deposit = 500

        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.PenaltyTooHigh.selector, id, 500e6 + 1, 500e6));
        escrow.proposeTermination(id, 500e6 + 1, uint64(block.timestamp + 1 hours));
        vm.prank(tenant);
        escrow.proposeTermination(id, 500e6, uint64(block.timestamp + 1 hours)); // the bound itself passes
        assertEq(escrow.termination(id).penaltyToLandlord, 500e6);
    }

    function test_Termination_AcceptReChecksThePenalty() public {
        uint256 id = _createAndFund();
        // At move-in the tenant side is the whole escrow (600); by the end of the term only the deposit (300).
        vm.prank(tenant);
        escrow.proposeTermination(id, 600e6, uint64(block.timestamp + 10 days));

        vm.warp(escrow.endTime(id));
        bytes32 hash = _termsHash(id, tenant, 600e6, uint64(block.timestamp - 3 days + 10 days));
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.PenaltyTooHigh.selector, id, 600e6, DEPOSIT));
        escrow.acceptTermination(id, hash);

        // A fresh proposal within the shrunken tenant side settles.
        vm.prank(landlord);
        escrow.proposeTermination(id, DEPOSIT, uint64(block.timestamp + 1 hours));
        vm.prank(tenant);
        escrow.acceptTermination(id, _termsHash(id, landlord, DEPOSIT, uint64(block.timestamp + 1 hours)));
        assertEq(musd.balanceOf(landlord), uint256(RENT) * PERIODS + DEPOSIT); // all rent earned by then
        assertEq(musd.balanceOf(tenant), 0);
    }

    function test_Termination_RevertsOnExpiry() public {
        uint256 id = _createAndFund();
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InvalidExpiry.selector, id, uint64(block.timestamp)));
        escrow.proposeTermination(id, 0, uint64(block.timestamp)); // not in the future

        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(tenant);
        escrow.proposeTermination(id, 10e6, expiry);

        vm.warp(expiry - 1);
        vm.prank(landlord);
        escrow.acceptTermination(id, _termsHash(id, tenant, 10e6, expiry)); // still in time

        uint256 id2 = _createAndFund();
        vm.prank(tenant);
        escrow.proposeTermination(id2, 10e6, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours); // exactly at expiry
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.ProposalExpired.selector, id2));
        escrow.acceptTermination(id2, _termsHash(id2, tenant, 10e6, uint64(block.timestamp - 1 hours)));
    }

    function test_Termination_RevertsOnWrongHash() public {
        uint256 id = _createAndFund();
        vm.prank(tenant);
        escrow.proposeTermination(id, 10e6, uint64(block.timestamp + 1 hours));
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.WrongTermsHash.selector, id));
        escrow.acceptTermination(id, _termsHash(id, tenant, 20e6, uint64(block.timestamp + 1 hours)));
        vm.prank(landlord);
        escrow.acceptTermination(id, _termsHash(id, tenant, 10e6, uint64(block.timestamp + 1 hours)));
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
    }

    function test_Termination_OnlyTheOtherPartyMayAccept() public {
        uint256 id = _createAndFund();
        vm.prank(tenant);
        escrow.proposeTermination(id, 10e6, uint64(block.timestamp + 1 hours));
        bytes32 hash = _termsHash(id, tenant, 10e6, uint64(block.timestamp + 1 hours));

        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.ProposerCannotAccept.selector, id));
        escrow.acceptTermination(id, hash);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotParty.selector, id));
        escrow.acceptTermination(id, hash);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotParty.selector, id));
        escrow.acceptTermination(id, hash);

        vm.prank(landlord);
        escrow.acceptTermination(id, hash); // the counterparty settles
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
    }

    function test_Termination_NewProposalReplacesTheOpenOne() public {
        uint256 id = _createAndFund();
        vm.prank(tenant);
        escrow.proposeTermination(id, 10e6, uint64(block.timestamp + 1 hours));
        // Either party replaces: the landlord's offer supersedes the tenant's.
        vm.prank(landlord);
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.TerminationProposed(id, landlord, 20e6, uint64(block.timestamp + 2 hours));
        escrow.proposeTermination(id, 20e6, uint64(block.timestamp + 2 hours));

        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.WrongTermsHash.selector, id));
        escrow.acceptTermination(id, _termsHash(id, tenant, 10e6, uint64(block.timestamp + 1 hours)));
        vm.prank(tenant);
        escrow.acceptTermination(id, _termsHash(id, landlord, 20e6, uint64(block.timestamp + 2 hours)));
        assertEq(musd.balanceOf(landlord), 20e6);
        assertEq(musd.balanceOf(tenant), TOTAL - 20e6);
    }

    function test_Termination_WithdrawnProposalCannotBeAccepted() public {
        uint256 id = _createAndFund();
        vm.prank(tenant);
        escrow.proposeTermination(id, 10e6, uint64(block.timestamp + 1 hours));

        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotProposer.selector, id));
        escrow.withdrawTermination(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotProposer.selector, id));
        escrow.withdrawTermination(id);

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.TerminationWithdrawn(id, tenant);
        vm.prank(tenant);
        escrow.withdrawTermination(id);

        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NoProposal.selector, id));
        escrow.acceptTermination(id, _termsHash(id, tenant, 10e6, uint64(block.timestamp + 1 hours)));
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NoProposal.selector, id));
        escrow.withdrawTermination(id); // double-withdraw
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.ACTIVE), "the lease runs on");
    }

    function test_Termination_RequiresActiveLease() public {
        uint256 id = _create();
        vm.prank(tenant);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.CREATED));
        escrow.proposeTermination(id, 0, uint64(block.timestamp + 1 hours));

        _fund(id);
        vm.prank(tenant);
        escrow.proposeTermination(id, 0, uint64(block.timestamp + 1 hours));
        _dispute(id); // a dispute kills the open proposal's reachability
        vm.prank(landlord);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.DISPUTED));
        escrow.acceptTermination(id, _termsHash(id, tenant, 0, uint64(block.timestamp + 1 hours)));
        vm.prank(landlord);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.DISPUTED));
        escrow.proposeTermination(id, 0, uint64(block.timestamp + 1 hours));
    }

    function test_Termination_NonPartyCannotPropose() public {
        uint256 id = _createAndFund();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotParty.selector, id));
        escrow.proposeTermination(id, 0, uint64(block.timestamp + 1 hours));
    }

    function test_Termination_DepositOnlyLease() public {
        vm.prank(landlord);
        uint256 id = escrow.createLease(tenant, DEPOSIT, 0, PERIOD, PERIODS); // no rent at all
        musd.mint(tenant, DEPOSIT);
        vm.startPrank(tenant);
        musd.approve(address(escrow), DEPOSIT);
        escrow.fundLease(id);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 * uint256(PERIOD)); // 2 of 3 zero-rent periods "earned"

        vm.prank(tenant);
        escrow.proposeTermination(id, 30e6, uint64(block.timestamp + 1 hours));
        vm.prank(landlord);
        escrow.acceptTermination(id, _termsHash(id, tenant, 30e6, uint64(block.timestamp + 1 hours)));

        assertEq(musd.balanceOf(landlord), 30e6, "only the penalty");
        assertEq(musd.balanceOf(tenant), DEPOSIT - 30e6);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.periodsPaid, 2, "earned periods count even at zero rent, like a ruling");
        assertEq(s.rentPaid, 0);
        assertEq(s.depositsReturned, DEPOSIT - 30e6);
    }

    // ------------------------------------------------------------------ dispute timeout

    function test_ResolveByTimeout_BeforeTheTimeoutReverts() public {
        uint256 id = _createAndFund();
        _dispute(id);
        assertEq(escrow.disputeOpenedAt(id), block.timestamp);

        vm.warp(block.timestamp + TIMEOUT - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.DisputeNotTimedOut.selector, id));
        escrow.resolveByTimeout(id);

        vm.warp(block.timestamp + 1); // exactly disputeOpenedAt + disputeTimeout
        vm.prank(stranger);
        escrow.resolveByTimeout(id);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
    }

    function test_ResolveByTimeout_SplitsEarnedRentFromTheRest() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + PERIOD + PERIOD / 2); // one period earned when disputed
        _dispute(id);
        vm.warp(block.timestamp + TIMEOUT + 90 days); // two more would have elapsed; rent is frozen

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.DisputeTimedOut(id, stranger, TOTAL - RENT, RENT);
        vm.prank(stranger);
        escrow.resolveByTimeout(id);

        assertEq(musd.balanceOf(landlord), RENT, "rent earned at dispute time, unclaimed");
        assertEq(musd.balanceOf(tenant), TOTAL - RENT, "unearned rent + deposit");
        assertEq(musd.balanceOf(address(escrow)), 0);
        assertEq(escrow.escrowBalance(id), 0);

        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesDisputed, 1);
        assertEq(s.leasesTerminatedEarly, 0, "a timeout is a dispute outcome, not a mutual termination");
        assertEq(s.leasesCompleted, 0);
        assertEq(s.periodsPaid, 1);
        assertEq(s.rentPaid, RENT);
        assertEq(s.depositsPosted, DEPOSIT);
        assertEq(s.depositsReturned, DEPOSIT);
    }

    function test_ResolveByTimeout_AfterPartialClaim() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + 2 * uint256(PERIOD));
        escrow.claimRent(id); // one period claimed
        _dispute(id); // second period earned, unclaimed
        vm.warp(block.timestamp + TIMEOUT);

        vm.prank(tenant); // anyone, including a party
        escrow.resolveByTimeout(id);
        assertEq(musd.balanceOf(landlord), 2 * uint256(RENT), "claimed + earned-unclaimed");
        assertEq(musd.balanceOf(tenant), DEPOSIT + RENT);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.periodsPaid, 2);
        assertEq(s.rentPaid, 2 * uint256(RENT));
    }

    function test_ResolveByTimeout_FirstPathToCloseWins() public {
        uint256 id = _createAndFund();
        _dispute(id);

        // The arbiter rules before the timeout...
        vm.warp(block.timestamp + TIMEOUT / 2);
        vm.prank(arbiter);
        escrow.resolveDispute(id, 5_000);
        vm.prank(stranger);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.CLOSED));
        escrow.resolveByTimeout(id);

        // ...and the other way round, the timeout pre-empts a late ruling.
        uint256 id2 = _createAndFund();
        _dispute(id2);
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(stranger);
        escrow.resolveByTimeout(id2);
        vm.prank(arbiter);
        vm.expectRevert(_invalidState(id2, IRentEscrowV2.State.CLOSED));
        escrow.resolveDispute(id2, 5_000);
    }

    function test_ResolveByTimeout_RevertsUnlessDisputed() public {
        uint256 id = _createAndFund();
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(stranger);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.ACTIVE));
        escrow.resolveByTimeout(id);
        vm.warp(block.timestamp + 10 * uint256(PERIOD));
        escrow.closeLease(id);
        vm.prank(stranger);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.CLOSED));
        escrow.resolveByTimeout(id);
    }

    // ------------------------------------------------------------------ monthly leases

    /// @dev deposit + the first period's rent: what funding a monthly lease costs.
    uint256 internal constant FIRST = uint256(DEPOSIT) + RENT;

    function _createMonthly() internal returns (uint256 id) {
        vm.prank(landlord);
        id = escrow.createLeaseMonthly(tenant, DEPOSIT, RENT, PERIOD, PERIODS);
    }

    function _fundMonthly(uint256 id) internal {
        musd.mint(tenant, FIRST);
        vm.startPrank(tenant);
        musd.approve(address(escrow), FIRST);
        escrow.fundLease(id);
        vm.stopPrank();
    }

    function _payRent(uint256 id, uint16 count) internal {
        uint256 amount = uint256(RENT) * count;
        musd.mint(tenant, amount);
        vm.startPrank(tenant);
        musd.approve(address(escrow), amount);
        escrow.payRent(id, count);
        vm.stopPrank();
    }

    function test_Monthly_CreateAndFund_BookDepositPlusOnePeriod() public {
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseCreatedMonthly(1, landlord, tenant, DEPOSIT, RENT, PERIOD, PERIODS);
        uint256 id = _createMonthly();

        IRentEscrowV2.Lease memory c = escrow.getLease(id);
        assertTrue(c.monthly, "the monthly flag is set at creation");
        assertEq(c.periods, PERIODS, "the term is unchanged");
        assertEq(c.periodsFunded, 0, "nothing funded yet");
        assertEq(shares.balanceOf(landlord, id), escrow.SHARES_PER_LEASE(), "shares mint as for prepaid");

        musd.mint(tenant, FIRST);
        vm.startPrank(tenant);
        musd.approve(address(escrow), FIRST);
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseFunded(id, tenant, FIRST, uint64(block.timestamp));
        escrow.fundLease(id);
        vm.stopPrank();

        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(uint8(l.state), uint8(IRentEscrowV2.State.ACTIVE));
        assertEq(l.periodsFunded, 1);
        assertEq(escrow.escrowBalance(id), FIRST);
        assertEq(escrow.totalEscrowed(), FIRST);
        assertEq(musd.balanceOf(address(escrow)), FIRST);
        assertEq(escrow.tenantStats(tenant).leasesFunded, 1);
        // The clock is the prepaid lease's: the term still ends after all periods.
        assertEq(escrow.endTime(id), block.timestamp + uint256(PERIOD) * PERIODS);
    }

    function test_Monthly_BorrowAndWithdrawFunding_BookOnePeriod() public {
        uint256 a = _createMonthly();
        _borrowAndFund(a, TOTAL); // TOTAL >> FIRST: the surplus comes back
        assertEq(escrow.escrowBalance(a), FIRST, "only deposit + one period is booked");
        assertEq(escrow.getLease(a).periodsFunded, 1);
        assertEq(musd.balanceOf(tenant), TOTAL - FIRST, "the surplus was refunded");

        uint256 b = _createMonthly();
        _withdrawAndFund(b, TOTAL);
        assertEq(escrow.escrowBalance(b), FIRST);
        assertEq(escrow.getLease(b).periodsFunded, 1);
        assertEq(escrow.totalEscrowed(), 2 * FIRST);
    }

    function test_Monthly_PayRent_PullsExactlyCountPeriods() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);

        uint256 amount = 2 * uint256(RENT);
        musd.mint(tenant, amount);
        vm.startPrank(tenant);
        musd.approve(address(escrow), amount);
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.RentPaid(id, tenant, 2, amount);
        escrow.payRent(id, 2);
        vm.stopPrank();

        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(l.periodsFunded, 3, "one period at funding plus two paid");
        assertEq(l.periodsClaimed, 0, "paid is not the same as released");
        assertEq(escrow.escrowBalance(id), uint256(DEPOSIT) + uint256(RENT) * 3);
        assertEq(escrow.totalEscrowed(), uint256(DEPOSIT) + uint256(RENT) * 3);
        assertEq(musd.balanceOf(address(escrow)), uint256(DEPOSIT) + uint256(RENT) * 3);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.periodsPaid, 0, "nothing released to the landlord yet");
        assertEq(s.rentPaid, 0);
    }

    function test_Monthly_PayRent_CapsAtTheUnfundedRemainder() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);

        _payRent(id, 9); // only 2 periods remain: 9 is capped to 2
        assertEq(escrow.getLease(id).periodsFunded, 3);
        assertEq(escrow.escrowBalance(id), uint256(DEPOSIT) + uint256(RENT) * 3);
        assertEq(musd.balanceOf(tenant), 7 * uint256(RENT), "only the capped amount was pulled");

        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.RentFullyFunded.selector, id));
        escrow.payRent(id, 1);
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.RentFullyFunded.selector, id));
        escrow.payRent(id, 0);
        assertEq(escrow.escrowBalance(id), uint256(DEPOSIT) + uint256(RENT) * 3, "a refused pay moves nothing");
    }

    function test_Monthly_PayRent_RevertsForPrepaidNonTenantOrDisputed() public {
        uint256 prepaid = _createAndFund();
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotMonthly.selector, prepaid));
        escrow.payRent(prepaid, 1); // a prepaid lease is fully funded from the start

        uint256 id = _createMonthly();
        vm.prank(tenant);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.CREATED));
        escrow.payRent(id, 1);

        _fundMonthly(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotTenant.selector, id));
        escrow.payRent(id, 1);
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotTenant.selector, id));
        escrow.payRent(id, 1);

        _dispute(id);
        vm.prank(tenant);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.DISPUTED));
        escrow.payRent(id, 1);
    }

    function test_Monthly_PayAndWithdrawAndPayRent_RespectTheHumanGate() public {
        MockHumanVerifier verifier = new MockHumanVerifier();
        HumanGate gate = new HumanGate(address(this), address(verifier));
        RentEscrowV2 gated =
            new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(gate), address(mezo), TIMEOUT);
        verifier.setVerified(tenant, true);
        vm.prank(landlord);
        uint256 id = gated.createLeaseMonthly(tenant, DEPOSIT, RENT, PERIOD, PERIODS);

        musd.mint(tenant, FIRST);
        vm.startPrank(tenant);
        musd.approve(address(gated), FIRST);
        gated.fundLease(id);
        vm.stopPrank();

        verifier.setVerified(tenant, false); // the gate can refuse NEW funding
        musd.mint(tenant, RENT);
        vm.startPrank(tenant);
        musd.approve(address(gated), RENT);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotVerifiedHuman.selector, tenant));
        gated.payRent(id, 1);
        vm.stopPrank();

        uint256 deadline = block.timestamp + 1 hours;
        // The digest names the gated escrow as recipient.
        bytes memory sig = MezoSignatures.sign(
            TENANT_KEY,
            MezoSignatures.withdrawMUSDDigest(
                address(mezo), RENT, tenant, address(gated), mezo.getNonce(tenant), deadline
            )
        );
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotVerifiedHuman.selector, tenant));
        gated.withdrawAndPayRent(id, 1, RENT, address(0), address(0), sig, deadline);
        assertEq(mezo.getNonce(tenant), 0, "the trove was never touched");

        verifier.setVerified(tenant, true);
        vm.prank(tenant);
        gated.payRent(id, 1); // the approval from above is still in place
        assertEq(gated.getLease(id).periodsFunded, 2);
    }

    function test_Monthly_WithdrawAndPayRent_DrawsTheRentFromTheTrove() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        vm.warp(block.timestamp + PERIOD); // the next period comes due

        // Sign before the expectEmit: _withdrawSig reads the mock's nonce (a call in between).
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(2 * uint256(RENT), deadline);
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.RentPaid(id, tenant, 1, RENT);
        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseBorrowFunded(id, tenant, 2 * uint256(RENT), 2 * uint256(RENT), RENT);
        vm.prank(tenant);
        escrow.withdrawAndPayRent(id, 1, 2 * uint256(RENT), address(0), address(0), sig, deadline);

        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(l.periodsFunded, 2);
        assertEq(escrow.escrowBalance(id), uint256(DEPOSIT) + 2 * uint256(RENT));
        assertEq(musd.balanceOf(tenant), RENT, "the surplus came back");
        assertEq(mezo.lastBorrower(), tenant, "the tenant's trove was drawn on");
        assertEq(mezo.lastRecipient(), address(escrow));
        assertTrue(mezo.musdWithdrawn());
        assertEq(mezo.getNonce(tenant), 1, "the signature was consumed");
        assertEq(address(escrow).balance, 0, "the zero-value BTC touch left nothing");
    }

    function test_Monthly_WithdrawAndPayRent_RevertsWhenTheMintCoversNoPeriod() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(RENT - 1, deadline);

        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.InsufficientBorrowed.selector, id, RENT - 1, RENT));
        escrow.withdrawAndPayRent(id, 1, RENT - 1, address(0), address(0), sig, deadline);

        assertEq(mezo.getNonce(tenant), 0, "the revert unwound the nonce");
        assertEq(escrow.getLease(id).periodsFunded, 1);
        assertEq(escrow.escrowBalance(id), FIRST);
    }

    function test_Monthly_WithdrawAndPayRent_DisabledReverts() public {
        RentEscrowV2 disabled =
            new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(0), address(0), TIMEOUT);
        vm.prank(tenant);
        vm.expectRevert(IRentEscrowV2.MezoDisabled.selector);
        disabled.withdrawAndPayRent(1, 1, RENT, address(0), address(0), "", 0);
    }

    function test_Monthly_ClaimRent_ReleasesOnlyFundedPeriods() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        vm.warp(block.timestamp + 3 * uint256(PERIOD)); // all periods elapsed, one funded

        (uint16 periods, uint256 amount) = escrow.claimable(id);
        assertEq(periods, 1, "elapsed-but-unfunded periods are not claimable");
        assertEq(amount, RENT);

        escrow.claimRent(id); // anyone may release; it only goes to the landlord
        assertEq(musd.balanceOf(landlord), RENT);

        (periods, amount) = escrow.claimable(id);
        assertEq(periods, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NothingToClaim.selector, id));
        escrow.claimRent(id);

        _payRent(id, 1); // the escrow only ever releases what was paid in
        (periods,) = escrow.claimable(id);
        assertEq(periods, 1);
    }

    function test_Monthly_ClaimDefault_BeforeTheGraceBoundaryReverts() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        // Period 1 (0-based) is due at start + PERIOD; one full period of grace past that:
        uint256 dueAt = escrow.getLease(id).startTime + 2 * uint256(PERIOD);

        vm.warp(dueAt - 1);
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotDefaulted.selector, id, dueAt));
        escrow.claimDefault(id);

        vm.warp(dueAt); // elapsed 2 > funded 1: the default is due
        vm.prank(landlord);
        escrow.claimDefault(id);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
    }

    function test_Monthly_ClaimDefault_SplitsRentForfeitAndDeposit() public {
        uint256 id = _createMonthly();
        _fundMonthly(id); // escrow holds deposit + one funded period = 400
        vm.warp(block.timestamp + 2 * uint256(PERIOD)); // past the grace

        vm.expectEmit(address(escrow));
        emit IRentEscrowV2.LeaseDefaulted(id, landlord, RENT, RENT, DEPOSIT - RENT);
        vm.prank(landlord);
        escrow.claimDefault(id);

        IRentEscrowV2.Lease memory l = escrow.getLease(id);
        assertEq(uint8(l.state), uint8(IRentEscrowV2.State.CLOSED));
        assertEq(l.periodsClaimed, 1, "the funded period leaves as if claimed");
        assertEq(escrow.escrowBalance(id), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(musd.balanceOf(landlord), 2 * uint256(RENT), "unclaimed funded rent + one period's forfeit");
        assertEq(musd.balanceOf(tenant), DEPOSIT - RENT, "the rest of the deposit");
        assertEq(musd.balanceOf(address(escrow)), 0);

        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesDefaulted, 1);
        assertEq(s.leasesCompleted, 0, "a default is not a completion");
        assertEq(s.leasesDisputed, 0);
        assertEq(s.periodsPaid, 1);
        assertEq(s.rentPaid, RENT);
        assertEq(s.depositsPosted, DEPOSIT);
        assertEq(s.depositsReturned, DEPOSIT - RENT);
    }

    function test_Monthly_ClaimDefault_AfterTheFundedRentWasClaimed() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        vm.warp(block.timestamp + uint256(PERIOD)); // period 0 earned
        escrow.claimRent(id); // the landlord takes the one funded period
        assertEq(musd.balanceOf(landlord), RENT);

        vm.warp(block.timestamp + 2 * uint256(PERIOD)); // past the grace
        vm.prank(landlord);
        escrow.claimDefault(id);

        assertEq(musd.balanceOf(landlord), 2 * uint256(RENT), "claimed rent + the deposit forfeit");
        assertEq(musd.balanceOf(tenant), DEPOSIT - RENT);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesDefaulted, 1);
        assertEq(s.periodsPaid, 1);
        assertEq(s.depositsReturned, DEPOSIT - RENT);
    }

    function test_Monthly_ClaimDefault_ForfeitIsCappedAtTheDeposit() public {
        vm.prank(landlord);
        uint256 id = escrow.createLeaseMonthly(tenant, 50e6, RENT, PERIOD, PERIODS); // deposit < rent
        musd.mint(tenant, 50e6 + RENT);
        vm.startPrank(tenant);
        musd.approve(address(escrow), 50e6 + RENT);
        escrow.fundLease(id);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 * uint256(PERIOD));

        vm.prank(landlord);
        escrow.claimDefault(id);
        assertEq(musd.balanceOf(landlord), RENT + 50e6, "funded rent + the whole (small) deposit");
        assertEq(musd.balanceOf(tenant), 0);
        assertEq(escrow.tenantStats(tenant).depositsReturned, 0);
    }

    function test_Monthly_ClaimDefault_OnlyTheLandlordOnADefaultedMonthlyLease() public {
        uint256 prepaid = _createAndFund();
        vm.warp(block.timestamp + 5 * uint256(PERIOD));
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotMonthly.selector, prepaid));
        escrow.claimDefault(prepaid); // a prepaid lease is always fully funded

        uint256 id = _createMonthly();
        _fundMonthly(id);
        vm.warp(block.timestamp + 2 * uint256(PERIOD)); // due
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotLandlord.selector, id));
        escrow.claimDefault(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotLandlord.selector, id));
        escrow.claimDefault(id);

        vm.prank(landlord);
        escrow.claimDefault(id); // the landlord settles
        vm.prank(landlord);
        vm.expectRevert(_invalidState(id, IRentEscrowV2.State.CLOSED));
        escrow.claimDefault(id);
    }

    function test_Monthly_FullyFunded_NeverDefaultsAndClosesNormally() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        _payRent(id, 2); // every period paid in
        vm.warp(escrow.endTime(id) + 2 * uint256(PERIOD)); // past the end, the close grace and beyond

        uint256 dueAt = escrow.getLease(id).startTime + uint256(PERIOD) * PERIODS + PERIOD;
        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.NotDefaulted.selector, id, dueAt));
        escrow.claimDefault(id); // nothing is unpaid: there is no default

        vm.prank(landlord);
        escrow.closeLease(id);
        assertEq(musd.balanceOf(landlord), uint256(RENT) * PERIODS);
        assertEq(musd.balanceOf(tenant), DEPOSIT);
        assertEq(escrow.tenantStats(tenant).leasesCompleted, 1);
    }

    function test_Monthly_CloseLease_RequiresFullFunding() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        vm.warp(escrow.endTime(id) + 2 * uint256(PERIOD)); // term and grace over

        vm.prank(landlord);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.RentNotFullyFunded.selector, id, 1, PERIODS));
        escrow.closeLease(id);
        vm.prank(tenant); // anyone past the grace window
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.RentNotFullyFunded.selector, id, 1, PERIODS));
        escrow.closeLease(id);

        _payRent(id, 2); // top the lease up to full, then close
        vm.prank(tenant);
        escrow.closeLease(id);
        assertEq(musd.balanceOf(landlord), uint256(RENT) * PERIODS);
        assertEq(musd.balanceOf(tenant), DEPOSIT);
    }

    function test_Monthly_ResolveByTimeout_SplitsOnlyFundedRentFromTheDeposit() public {
        uint256 id = _createMonthly();
        _fundMonthly(id);
        _payRent(id, 1); // funded 2, escrow = deposit + 2 rent = 500
        vm.warp(block.timestamp + uint256(PERIOD) + uint256(PERIOD) / 2); // one period earned
        _dispute(id);
        vm.warp(block.timestamp + TIMEOUT);

        vm.prank(stranger);
        escrow.resolveByTimeout(id);

        assertEq(musd.balanceOf(landlord), RENT, "rent earned at dispute time, unclaimed");
        assertEq(musd.balanceOf(tenant), DEPOSIT + RENT, "unearned funded rent + the whole deposit");
        assertEq(musd.balanceOf(address(escrow)), 0);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        assertEq(s.leasesDisputed, 1);
        assertEq(s.periodsPaid, 1);
        assertEq(s.rentPaid, RENT);
        assertEq(s.depositsPosted, DEPOSIT);
        assertEq(s.depositsReturned, DEPOSIT, "unfunded periods never dilute the deposit accounting");
    }

    function test_Monthly_ResolveDispute_SplitsTheActualEscrowBalance() public {
        uint256 id = _createMonthly();
        _fundMonthly(id); // 400 in escrow, not the prepaid 600
        _dispute(id);
        vm.prank(arbiter);
        escrow.resolveDispute(id, 5_000);

        assertEq(musd.balanceOf(tenant), FIRST / 2, "half of what the lease actually holds");
        assertEq(musd.balanceOf(landlord), FIRST / 2);
        IRentEscrowV2.TenantStats memory s = escrow.tenantStats(tenant);
        // The tenant's 200 reads as its 100 unearned funded rent plus 100 of the deposit.
        assertEq(s.depositsReturned, FIRST / 2 - RENT);
    }

    function test_Monthly_Termination_SettlesOnlyWhatIsInTheEscrow() public {
        uint256 id = _createMonthly();
        _fundMonthly(id); // escrow = deposit + one funded period = 400
        vm.warp(block.timestamp + uint256(PERIOD) / 2); // nothing earned yet

        // The penalty bound is the FUNDED tenant side (400), not the prepaid one (600).
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(IRentEscrowV2.PenaltyTooHigh.selector, id, 400e6 + 1, 400e6));
        escrow.proposeTermination(id, 400e6 + 1, uint64(block.timestamp + 1 hours));

        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(tenant);
        escrow.proposeTermination(id, 50e6, expiry);
        vm.prank(landlord);
        escrow.acceptTermination(id, _termsHash(id, tenant, 50e6, expiry));

        assertEq(musd.balanceOf(landlord), 50e6, "no rent earned yet: only the penalty");
        assertEq(musd.balanceOf(tenant), DEPOSIT + RENT - 50e6);
        assertEq(escrow.tenantStats(tenant).depositsReturned, DEPOSIT - 50e6);
    }
}
