// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IRentEscrowV2} from "./interfaces/IRentEscrowV2.sol";

/// @title DemoLandlordV2
/// @notice A testnet landlord anyone can rent from, so one wallet can try the whole tenant side of
///         RentOuts on the Wave-2 escrow — prepaid or pay-monthly: request a lease, fund it
///         (deposit + all rent, or deposit + the first period), watch rent release period by
///         period, pay the next period from a Mezo trove, and close the lease with the deposit
///         back (or see the default rule fire when the rent stops).
/// @dev    It is an ordinary landlord to the escrow: it calls `createLease` / `createLeaseMonthly`
///         with fixed, small terms and receives the lease shares, so the LeaseShare1155 owner must
///         allowlist it once. It holds no tenant funds (the escrow does) and has no owner. Rent it
///         receives stays here; it is testnet MUSD with no use. A tenant gets at most one unfunded
///         demo lease at a time, per mode: a pending prepaid request never blocks a monthly one
///         and vice versa.
contract DemoLandlordV2 is ERC1155Holder {
    IRentEscrowV2 public immutable escrow;
    uint128 public immutable deposit;
    uint128 public immutable rentPerPeriod;
    uint32 public immutable periodSeconds;
    uint16 public immutable periods;

    /// @notice The last demo PREPAID lease created for each tenant (0 = none yet).
    mapping(address tenant => uint256 leaseId) public lastLeaseOf;
    /// @notice The last demo MONTHLY lease created for each tenant (0 = none yet).
    mapping(address tenant => uint256 leaseId) public lastMonthlyLeaseOf;

    event DemoLeaseCreated(address indexed tenant, uint256 indexed leaseId, bool indexed monthly);

    constructor(
        IRentEscrowV2 escrow_,
        uint128 deposit_,
        uint128 rentPerPeriod_,
        uint32 periodSeconds_,
        uint16 periods_
    ) {
        escrow = escrow_;
        deposit = deposit_;
        rentPerPeriod = rentPerPeriod_;
        periodSeconds = periodSeconds_;
        periods = periods_;
    }

    /// @notice Creates a demo lease with the caller as tenant — prepaid (`monthly == false`) or
    ///         pay-monthly (`monthly == true`) — or returns the caller's lease of that mode that is
    ///         still waiting to be funded.
    function requestLease(bool monthly) external returns (uint256 leaseId) {
        uint256 last = monthly ? lastMonthlyLeaseOf[msg.sender] : lastLeaseOf[msg.sender];
        if (last != 0 && escrow.getLease(last).state == IRentEscrowV2.State.CREATED) return last;

        leaseId = monthly
            ? escrow.createLeaseMonthly(msg.sender, deposit, rentPerPeriod, periodSeconds, periods)
            : escrow.createLease(msg.sender, deposit, rentPerPeriod, periodSeconds, periods);
        if (monthly) lastMonthlyLeaseOf[msg.sender] = leaseId;
        else lastLeaseOf[msg.sender] = leaseId;
        emit DemoLeaseCreated(msg.sender, leaseId, monthly);
    }

    /// @notice Total a tenant prepays for one demo PREPAID lease: deposit plus every period's rent.
    function totalDue() external view returns (uint256) {
        return uint256(deposit) + uint256(rentPerPeriod) * periods;
    }

    /// @notice What funding a demo MONTHLY lease costs: the deposit plus ONE period's rent.
    function firstMonthlyDue() external view returns (uint256) {
        return uint256(deposit) + rentPerPeriod;
    }
}
