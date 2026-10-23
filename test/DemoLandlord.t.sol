// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RentEscrow} from "../src/RentEscrow.sol";
import {IRentEscrow} from "../src/interfaces/IRentEscrow.sol";
import {LeaseShare1155} from "../src/LeaseShare1155.sol";
import {DemoLandlord} from "../src/DemoLandlord.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";

contract DemoLandlordTest is Test {
    MockUSDC internal token;
    LeaseShare1155 internal shares;
    RentEscrow internal escrow;
    DemoLandlord internal demo;

    address internal issuer = makeAddr("issuer");
    address internal arbiter = makeAddr("arbiter");
    address internal tenant = makeAddr("tenant");
    address internal other = makeAddr("other");

    uint128 internal constant DEPOSIT = 20e6;
    uint128 internal constant RENT = 10e6;
    uint32 internal constant PERIOD = 60;
    uint16 internal constant PERIODS = 3;
    uint256 internal constant TOTAL = uint256(DEPOSIT) + uint256(RENT) * PERIODS;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockUSDC();
        shares = new LeaseShare1155(issuer, "https://rentouts.co/api/lease-share/{id}.json");
        escrow = new RentEscrow(IERC20(address(token)), arbiter, address(shares), address(0));
        demo = new DemoLandlord(IRentEscrow(address(escrow)), DEPOSIT, RENT, PERIOD, PERIODS);

        vm.startPrank(issuer);
        shares.setMinter(address(escrow));
        shares.setAllowlist(address(demo), true);
        vm.stopPrank();
    }

    function _fund(address who, uint256 id) internal {
        token.mint(who, TOTAL);
        vm.startPrank(who);
        token.approve(address(escrow), TOTAL);
        escrow.fundLease(id);
        vm.stopPrank();
    }

    function test_requestLease_createsLeaseWithCallerAsTenant() public {
        vm.expectEmit(true, true, false, false, address(demo));
        emit DemoLandlord.DemoLeaseCreated(tenant, 1);
        vm.prank(tenant);
        uint256 id = demo.requestLease();

        IRentEscrow.Lease memory l = escrow.getLease(id);
        assertEq(id, 1);
        assertEq(l.landlord, address(demo));
        assertEq(l.tenant, tenant);
        assertEq(l.deposit, DEPOSIT);
        assertEq(l.rentPerPeriod, RENT);
        assertEq(l.periodSeconds, PERIOD);
        assertEq(l.periods, PERIODS);
        assertEq(uint8(l.state), uint8(IRentEscrow.State.CREATED));
        assertEq(demo.lastLeaseOf(tenant), id);
        assertEq(shares.balanceOf(address(demo), id), escrow.SHARES_PER_LEASE());
        assertEq(demo.totalDue(), TOTAL);
    }

    function test_requestLease_returnsTheUnfundedLeaseInsteadOfAnother() public {
        vm.startPrank(tenant);
        uint256 first = demo.requestLease();
        uint256 again = demo.requestLease();
        vm.stopPrank();
        assertEq(again, first);
        assertEq(escrow.nextLeaseId(), first + 1);
    }

    function test_requestLease_afterFundingCreatesANewLease() public {
        vm.prank(tenant);
        uint256 first = demo.requestLease();
        _fund(tenant, first);
        vm.prank(tenant);
        uint256 second = demo.requestLease();
        assertEq(second, first + 1);
        assertEq(demo.lastLeaseOf(tenant), second);
    }

    function test_tenantsGetSeparateLeases() public {
        vm.prank(tenant);
        uint256 a = demo.requestLease();
        vm.prank(other);
        uint256 b = demo.requestLease();
        assertTrue(a != b);
        assertEq(escrow.getLease(b).tenant, other);
    }

    function test_fullTenantFlow_depositReturnedRentToDemoLandlord() public {
        vm.prank(tenant);
        uint256 id = demo.requestLease();
        _fund(tenant, id);

        vm.warp(block.timestamp + PERIOD);
        vm.prank(other); // anyone may release rent; it only goes to the landlord
        escrow.claimRent(id);
        assertEq(token.balanceOf(address(demo)), RENT);

        vm.warp(block.timestamp + uint256(PERIOD) * PERIODS); // past the end and the grace window
        vm.prank(tenant);
        escrow.closeLease(id);

        assertEq(token.balanceOf(tenant), DEPOSIT);
        assertEq(token.balanceOf(address(demo)), uint256(RENT) * PERIODS);
        assertEq(escrow.escrowBalance(id), 0);
        assertEq(uint8(escrow.getLease(id).state), uint8(IRentEscrow.State.CLOSED));
    }

    function test_requestLease_revertsWhenNotAllowlisted() public {
        vm.prank(issuer);
        shares.setAllowlist(address(demo), false);
        vm.prank(tenant);
        vm.expectRevert(abi.encodeWithSelector(LeaseShare1155.NotAllowlisted.selector, address(demo)));
        demo.requestLease();
    }

    function test_requestLease_revertsForTheArbiter() public {
        vm.prank(arbiter);
        vm.expectRevert(IRentEscrow.InvalidTerms.selector);
        demo.requestLease();
    }
}
