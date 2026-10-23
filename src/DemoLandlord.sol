// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IRentEscrow} from "./interfaces/IRentEscrow.sol";

/// @title DemoLandlord
/// @notice A testnet landlord anyone can rent from, so one wallet can try the whole tenant side of
///         RentOuts: request a lease, prepay deposit and rent in MUSD, watch rent release, close the
///         lease and get the deposit back.
/// @dev    It is an ordinary landlord to the escrow: it calls `createLease` with fixed, small terms and
///         receives the lease shares, so the LeaseShare1155 owner must allowlist it once. It holds no
///         tenant funds (the escrow does) and has no owner. Rent it receives stays here; it is testnet
///         MUSD with no use. A tenant gets at most one unfunded demo lease at a time.
contract DemoLandlord is ERC1155Holder {
    IRentEscrow public immutable escrow;
    uint128 public immutable deposit;
    uint128 public immutable rentPerPeriod;
    uint32 public immutable periodSeconds;
    uint16 public immutable periods;

    /// @notice The last demo lease created for each tenant (0 = none yet).
    mapping(address tenant => uint256 leaseId) public lastLeaseOf;

    event DemoLeaseCreated(address indexed tenant, uint256 indexed leaseId);

    constructor(IRentEscrow escrow_, uint128 deposit_, uint128 rentPerPeriod_, uint32 periodSeconds_, uint16 periods_) {
        escrow = escrow_;
        deposit = deposit_;
        rentPerPeriod = rentPerPeriod_;
        periodSeconds = periodSeconds_;
        periods = periods_;
    }

    /// @notice Creates a demo lease with the caller as tenant, or returns the caller's lease that is
    ///         still waiting to be funded.
    function requestLease() external returns (uint256 leaseId) {
        uint256 last = lastLeaseOf[msg.sender];
        if (last != 0 && escrow.getLease(last).state == IRentEscrow.State.CREATED) return last;

        leaseId = escrow.createLease(msg.sender, deposit, rentPerPeriod, periodSeconds, periods);
        lastLeaseOf[msg.sender] = leaseId;
        emit DemoLeaseCreated(msg.sender, leaseId);
    }

    /// @notice Total a tenant prepays for one demo lease: deposit plus every period's rent.
    function totalDue() external view returns (uint256) {
        return uint256(deposit) + uint256(rentPerPeriod) * periods;
    }
}
