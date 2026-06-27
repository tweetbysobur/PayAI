// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

/**
 * @title MerchantRegistry
 * @notice On-chain merchant directory. Owners/agents register merchants; the
 *         authorized PaymentExecutor accrues per-merchant volume as payments
 *         settle. Powers merchant management + analytics in the dashboard.
 */
contract MerchantRegistry is IMerchantRegistry {
    address public owner;
    /// Accounts allowed to register merchants / toggle status.
    mapping(address => bool) public isManager;
    /// Accounts allowed to accrue volume (the PaymentExecutor).
    mapping(address => bool) public isRecorder;

    mapping(address => Merchant) private _merchants;
    address[] private _all;

    event ManagerSet(address indexed account, bool allowed);
    event RecorderSet(address indexed account, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyManager() {
        require(isManager[msg.sender], "not manager");
        _;
    }

    constructor() {
        owner = msg.sender;
        isManager[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ManagerSet(msg.sender, true);
    }

    /* ── Admin ──────────────────────────────────────────────────────────── */
    function setManager(address account, bool allowed) external onlyOwner {
        isManager[account] = allowed;
        emit ManagerSet(account, allowed);
    }

    function setRecorder(address account, bool allowed) external onlyOwner {
        isRecorder[account] = allowed;
        emit RecorderSet(account, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Registry ───────────────────────────────────────────────────────── */
    function registerMerchant(address wallet, string calldata name) external onlyManager {
        require(wallet != address(0), "zero wallet");
        require(_merchants[wallet].registeredAt == 0, "already registered");
        _merchants[wallet] = Merchant({
            wallet: wallet,
            name: name,
            active: true,
            volume: 0,
            paymentCount: 0,
            registeredAt: uint64(block.timestamp)
        });
        _all.push(wallet);
        emit MerchantRegistered(wallet, name);
    }

    function setActive(address wallet, bool active) external onlyManager {
        require(_merchants[wallet].registeredAt != 0, "unknown merchant");
        _merchants[wallet].active = active;
        emit MerchantStatusChanged(wallet, active);
    }

    function recordVolume(address wallet, uint256 amount) external {
        require(isRecorder[msg.sender], "not recorder");
        Merchant storage m = _merchants[wallet];
        if (m.registeredAt == 0) return; // unregistered payee — skip silently
        m.volume += amount;
        m.paymentCount += 1;
        emit MerchantVolumeUpdated(wallet, amount, m.volume);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */
    function isRegistered(address wallet) external view returns (bool) {
        return _merchants[wallet].registeredAt != 0;
    }

    function isActive(address wallet) external view returns (bool) {
        return _merchants[wallet].active;
    }

    function getMerchant(address wallet) external view returns (Merchant memory) {
        return _merchants[wallet];
    }

    function merchantCount() external view returns (uint256) {
        return _all.length;
    }

    function merchantAt(uint256 i) external view returns (address) {
        return _all[i];
    }

    function allMerchants() external view returns (address[] memory) {
        return _all;
    }
}
