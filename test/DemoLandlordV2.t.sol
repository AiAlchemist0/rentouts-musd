// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RentEscrowV2} from "../src/RentEscrowV2.sol";
import {IRentEscrowV2} from "../src/interfaces/IRentEscrowV2.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {DemoLandlordV2} from "../src/DemoLandlordV2.sol";
import {DeployDemoLandlordV2} from "../script/DeployDemoLandlordV2.s.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";
import {MockBorrowerOperationsSignatures, MintableMUSD} from "./helpers/MockBorrowerOperationsSignatures.sol";

/// @notice DemoLandlordV2: the one-wallet demo landlord for the Wave-2 escrow, in both modes —
///         plus the deploy script's checks and its LeaseShare1155 allowlist step.
contract DemoLandlordV2Test is Test {
    MockUSDC internal musd;
    LeaseShare1155 internal shares;
    MockBorrowerOperationsSignatures internal mezo;
    RentEscrowV2 internal escrow;
    DemoLandlordV2 internal demo;

    address internal issuer = makeAddr("issuer"); // LeaseShare1155 owner
    address internal arbiter = makeAddr("arbiter");
    address internal tenant = makeAddr("tenant");
    address internal other = makeAddr("other");

    uint128 internal constant DEPOSIT = 20e6;
    uint128 internal constant RENT = 10e6;
    uint32 internal constant PERIOD = 120; // 2 minutes: a live monthly demo needs a short period
    uint16 internal constant PERIODS = 3;
    uint256 internal constant TOTAL = uint256(DEPOSIT) + uint256(RENT) * PERIODS;
    uint256 internal constant FIRST = uint256(DEPOSIT) + RENT;

    function setUp() public {
        vm.warp(1_700_000_000);
        musd = new MockUSDC();
        shares = new LeaseShare1155(issuer, "https://rentouts.co/api/lease-share/{id}.json");
        mezo = new MockBorrowerOperationsSignatures(MintableMUSD(address(musd)));
        escrow = new RentEscrowV2(IERC20(address(musd)), arbiter, address(shares), address(0), address(mezo), 1 days);
        demo = new DemoLandlordV2(IRentEscrowV2(address(escrow)), DEPOSIT, RENT, PERIOD, PERIODS);

        vm.startPrank(issuer);
        shares.setMinter(address(escrow));
        shares.setAllowlist(address(demo), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address who, uint256 id, uint256 amount) internal {
        musd.mint(who, amount);
        vm.startPrank(who);
        musd.approve(address(escrow), amount);
        escrow.fundLease(id);
        vm.stopPrank();
    }

    function _payRent(address who, uint256 id, uint16 count) internal {
        uint256 amount = uint256(RENT) * count;
        musd.mint(who, amount);
        vm.startPrank(who);
        musd.approve(address(escrow), amount);
        escrow.payRent(id, count);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ requestLease

    function test_requestLease_CreatesBothModesWithFixedTerms() public {
        vm.expectEmit(true, true, true, true, address(demo));
        emit DemoLandlordV2.DemoLeaseCreated(tenant, 1, true);
        vm.prank(tenant);
        uint256 monthly = demo.requestLease(true);

        IRentEscrowV2.Lease memory m = escrow.getLease(monthly);
        assertEq(m.landlord, address(demo));
        assertEq(m.tenant, tenant);
        assertEq(m.deposit, DEPOSIT);
        assertEq(m.rentPerPeriod, RENT);
        assertEq(m.periodSeconds, PERIOD);
        assertEq(m.periods, PERIODS);
        assertTrue(m.monthly);
        assertEq(demo.lastMonthlyLeaseOf(tenant), monthly);
        assertEq(shares.balanceOf(address(demo), monthly), escrow.SHARES_PER_LEASE());

        vm.prank(tenant);
        uint256 prepaid = demo.requestLease(false);
        IRentEscrowV2.Lease memory p = escrow.getLease(prepaid);
        assertFalse(p.monthly, "the prepaid mode is unchanged");
        assertEq(demo.lastLeaseOf(tenant), prepaid);
        assertEq(demo.totalDue(), TOTAL);
        assertEq(demo.firstMonthlyDue(), FIRST);
    }

    function test_requestLease_ReturnsTheUnfundedLeaseOfTheSameMode() public {
        vm.startPrank(tenant);
        uint256 prepaid = demo.requestLease(false);
        assertEq(demo.requestLease(false), prepaid, "same pending prepaid lease");
        uint256 monthly = demo.requestLease(true);
        assertEq(demo.requestLease(true), monthly, "same pending monthly lease");
        assertTrue(prepaid != monthly, "the modes never share a lease");
        vm.stopPrank();
        assertEq(escrow.nextLeaseId(), monthly + 1, "exactly two leases created");
    }

    function test_requestLease_AfterFundingCreatesANewOnePerMode() public {
        vm.startPrank(tenant);
        uint256 first = demo.requestLease(true);
        vm.stopPrank();
        _fund(tenant, first, FIRST);

        vm.prank(tenant);
        uint256 second = demo.requestLease(true);
        assertEq(second, first + 1, "the funded monthly lease does not block a new one");

        vm.prank(tenant);
        uint256 prepaid = demo.requestLease(false);
        assertTrue(prepaid != second, "the modes are independent");
        _fund(tenant, prepaid, TOTAL);
        vm.prank(tenant);
        uint256 next = demo.requestLease(false);
        assertEq(next, prepaid + 1, "the funded prepaid lease does not block a new one either");
        assertEq(demo.lastLeaseOf(tenant), next);
    }

    function test_tenantsGetSeparateLeases() public {
        vm.prank(tenant);
        uint256 a = demo.requestLease(true);
        vm.prank(other);
        uint256 b = demo.requestLease(true);
        assertTrue(a != b);
        assertEq(escrow.getLease(b).tenant, other);
        assertEq(demo.lastMonthlyLeaseOf(other), b);
    }

    function test_requestLease_RevertsWhenNotAllowlisted() public {
        vm.prank(issuer);
        shares.setAllowlist(address(demo), false);
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(LeaseShare1155.NotAllowlisted.selector, address(demo)));
        demo.requestLease(true);
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(LeaseShare1155.NotAllowlisted.selector, address(demo)));
        demo.requestLease(false);
    }

    function test_requestLease_RevertsForTheArbiter() public {
        vm.prank(arbiter);
        vm.expectRevert(IRentEscrowV2.InvalidTerms.selector);
        demo.requestLease(true);
    }

    // ------------------------------------------------------------------ the monthly tenant flow

    function test_monthlyFlow_FundPayClaimClose() public {
        vm.prank(tenant);
        uint256 id = demo.requestLease(true);
        _fund(tenant, id, FIRST);

        // One period passes; the tenant pays the next one and the landlord releases the first.
        vm.warp(block.timestamp + PERIOD);
        _payRent(tenant, id, 1);
        escrow.claimRent(id);
        assertEq(musd.balanceOf(address(demo)), RENT);

        // The term runs to its end fully funded, and the tenant closes with the deposit back.
        vm.warp(escrow.endTime(id) + 2 * uint256(PERIOD));
        _payRent(tenant, id, 1); // the last period, completing the funding
        vm.prank(tenant);
        escrow.closeLease(id);

        assertEq(musd.balanceOf(tenant), DEPOSIT);
        assertEq(musd.balanceOf(address(demo)), uint256(RENT) * PERIODS);
        assertEq(escrow.escrowBalance(id), 0);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrowV2.State.CLOSED));
    }

    function test_monthlyFlow_TheRentStopsAndTheLandlordClaimsDefault() public {
        vm.prank(tenant);
        uint256 id = demo.requestLease(true);
        _fund(tenant, id, FIRST);

        // The tenant pays period 1, then never again: past one full period of grace the demo
        // landlord defaults the lease — funded rent + one period out of the deposit, rest back.
        vm.warp(block.timestamp + 3 * uint256(PERIOD));
        vm.prank(address(demo));
        escrow.claimDefault(id);

        assertEq(musd.balanceOf(address(demo)), 2 * uint256(RENT), "funded rent + the forfeit");
        assertEq(musd.balanceOf(tenant), DEPOSIT - RENT, "the rest of the deposit");
        assertEq(escrow.tenantStats(tenant).leasesDefaulted, 1);
    }

    // ------------------------------------------------------------------ the deploy script

    function test_Deploy_AllowlistsTheDemoWhenTheBroadcasterOwnsTheShares() public {
        DeployDemoLandlordV2 script = new DeployDemoLandlordV2();
        address deployer = issuer; // owns the LeaseShare1155 wired to the escrow

        DemoLandlordV2 deployed = script.deploy(deployer, escrow, DEPOSIT, RENT, PERIOD, PERIODS);

        assertEq(address(deployed.escrow()), address(escrow));
        assertEq(deployed.periodSeconds(), PERIOD);
        assertTrue(shares.allowlisted(address(deployed)), "the demo landlord can receive shares");
        // And the deployed demo really works end to end.
        vm.prank(tenant);
        uint256 id = deployed.requestLease(true);
        assertEq(escrow.getLease(id).landlord, address(deployed));
    }

    function test_Deploy_LeavesTheAllowlistToTheOwnerWhenNotOwned() public {
        DeployDemoLandlordV2 script = new DeployDemoLandlordV2();
        address deployer = makeAddr("not-the-share-owner");

        DemoLandlordV2 deployed = script.deploy(deployer, escrow, DEPOSIT, RENT, PERIOD, PERIODS);
        assertFalse(shares.allowlisted(address(deployed)), "the script cannot allowlist what it does not own");
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(LeaseShare1155.NotAllowlisted.selector, address(deployed)));
        deployed.requestLease(false);
    }

    function test_Deploy_WorksWithoutALeaseShare() public {
        DeployDemoLandlordV2 script = new DeployDemoLandlordV2();
        RentEscrowV2 bare =
            new RentEscrowV2(IERC20(address(musd)), arbiter, address(0), address(0), address(mezo), 1 days);

        DemoLandlordV2 deployed = script.deploy(makeAddr("deployer"), bare, DEPOSIT, RENT, PERIOD, PERIODS);
        vm.prank(tenant);
        uint256 id = deployed.requestLease(true); // no shares to mint: nothing to allowlist
        assertTrue(bare.getLease(id).monthly);
    }

    function test_Deploy_RevertsOnBadConfig() public {
        DeployDemoLandlordV2 script = new DeployDemoLandlordV2();
        // forge-std's DEFAULT_SENDER is internal: derive it the way Base.sol does.
        address defaultSender = address(uint160(uint256(keccak256("foundry default caller"))));
        vm.expectRevert(bytes("DeployDemoLandlordV2: pass --account <keystore> / --sender <address>"));
        script.deploy(defaultSender, escrow, DEPOSIT, RENT, PERIOD, PERIODS);

        vm.expectRevert(bytes("DeployDemoLandlordV2: ESCROW has no code on this chain"));
        script.deploy(makeAddr("deployer"), IRentEscrowV2(makeAddr("no-code")), DEPOSIT, RENT, PERIOD, PERIODS);
    }

    /// @dev run() reads env only: with ESCROW set it lands on the same wiring as deploy().
    function test_Run_PicksUpTheEscrowFromEnv() public {
        DeployDemoLandlordV2 script = new DeployDemoLandlordV2();
        vm.setEnv("ESCROW", vm.toString(address(escrow)));
        vm.setEnv("DEMO_PERIOD", "60");

        DemoLandlordV2 deployed = script.run();
        assertEq(address(deployed.escrow()), address(escrow));
        assertEq(deployed.periodSeconds(), 60, "DEMO_PERIOD was picked up");
    }
}
