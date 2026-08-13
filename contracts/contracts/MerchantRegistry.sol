// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

/**
 * @title MerchantRegistry
 * @notice On-chain merchant directory. Owners/managers register merchants; the
 *         authorized PaymentExecutor accrues per-merchant volume as payments
 *         settle. Powers merchant management + analytics in the dashboard.
 *
 * @custom:security-property INVARIANT-MR-1: Live-Checked, Least-Privilege Registration
 *   `registerMerchant` requires `isManager[msg.sender] || isRegistrar[msg.sender]`;
 *   `setActive` requires the strictly stronger `isManager[msg.sender]`. Both are
 *   ordinary storage reads evaluated at call time, on every call -- there is no
 *   cached or snapshotted authorization state to fall out of sync with a role
 *   revocation. `isRegistrar` exists because `registerMerchant` is purely additive
 *   (it can only create a NEW merchant record -- see INVARIANT-MR-3 -- never modify
 *   or deactivate an existing one), so it is safe to grant to a hot wallet that
 *   must NOT hold `setActive` power. Added 2026-08 after Ultrafuzz L-02: a prior
 *   fix correctly revoked the hot agent's full manager role (a compromised hot key
 *   must never be able to deactivate merchants or self-register for
 *   `executePaymentFrom` abuse), which left the agent unable to register new
 *   merchants at all through the app. `isRegistrar` restores that one narrow
 *   ability without restoring the rest of `isManager`.
 *
 * @custom:security-property INVARIANT-MR-2: Recorder-Only Volume Accrual
 *   `recordVolume` can ONLY be called by accounts with `isRecorder == true` (e.g. PaymentExecutor).
 *   Direct volume tampering by non-recorders MUST revert.
 *
 * @custom:security-property INVARIANT-MR-3: Unique Merchant Registration
 *   A merchant wallet can only be registered once. Registering an existing wallet MUST revert.
 *
 * @custom:security-property INVARIANT-MR-4: Migration Path Cannot Outlive Its Purpose
 *   `registerMerchantWithHistory` -- the only function able to set a merchant's
 *   `volume`/`paymentCount`/`registeredAt` to anything other than 0/0/now -- is
 *   `onlyOwner` (the cold wallet, never the agent) AND gated by `migrationOpen`,
 *   which starts true and can only ever be set false, permanently, by
 *   `closeMigration()`. Once closed, no path exists to reopen it. This exists
 *   solely so a MerchantRegistry replacement can carry over historical
 *   volume/paymentCount from a prior registry (see
 *   contracts/MERCHANT_REGISTRY_MIGRATION.md) without giving the owner a
 *   standing, permanent ability to fabricate any merchant's historical figures.
 */
contract MerchantRegistry is IMerchantRegistry {
    /// @notice Admin owner with manager/recorder permission grant authority.
    address public owner;

    /// @notice True until the owner permanently closes the one-time migration
    ///         path via closeMigration() -- see INVARIANT-MR-4.
    bool public migrationOpen = true;

    /// @notice Accounts authorized to register merchants AND toggle active status
    ///         (full trust — includes the ability to deactivate any merchant).
    mapping(address => bool) public isManager;

    /// @notice Accounts authorized to register NEW merchants only -- cannot call
    ///         setActive. Narrower than isManager; safe to grant a hot wallet.
    mapping(address => bool) public isRegistrar;

    /// @notice Accounts authorized to accrue settlement volume (e.g., PaymentExecutor).
    mapping(address => bool) public isRecorder;

    /// @dev Internal merchant store.
    mapping(address => Merchant) private _merchants;

    /// @dev Array of registered merchant wallet addresses for iteration.
    address[] private _all;

    /* ── Events ─────────────────────────────────────────────────────────── */
    event ManagerSet(address indexed account, bool allowed);
    event RegistrarSet(address indexed account, bool allowed);
    event RecorderSet(address indexed account, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);
    event MigrationClosed();

    /* ── Modifiers ──────────────────────────────────────────────────────── */
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyManager() {
        require(isManager[msg.sender], "not manager");
        _;
    }

    /// @dev Live-checked at every call -- see INVARIANT-MR-1. A manager is
    ///      implicitly also a registrar (full trust supersedes the narrower grant).
    modifier onlyRegistrar() {
        require(isManager[msg.sender] || isRegistrar[msg.sender], "not authorized to register");
        _;
    }

    constructor() {
        owner = msg.sender;
        isManager[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ManagerSet(msg.sender, true);
    }

    /* ── Admin ──────────────────────────────────────────────────────────── */

    /// @notice Grant or revoke manager privileges (registration + setActive).
    function setManager(address account, bool allowed) external onlyOwner {
        isManager[account] = allowed;
        emit ManagerSet(account, allowed);
    }

    /// @notice Grant or revoke registrar privileges (registration only, no
    ///         setActive). Intended for a hot agent wallet that must be able
    ///         to onboard new merchants but must never deactivate one.
    function setRegistrar(address account, bool allowed) external onlyOwner {
        isRegistrar[account] = allowed;
        emit RegistrarSet(account, allowed);
    }

    /// @notice Grant or revoke recorder privileges (e.g. PaymentExecutor address).
    function setRecorder(address account, bool allowed) external onlyOwner {
        isRecorder[account] = allowed;
        emit RecorderSet(account, allowed);
    }

    /// @notice Transfer contract admin ownership.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    /* ── Registry ───────────────────────────────────────────────────────── */

    /// @notice Register a new merchant wallet in the directory.
    function registerMerchant(address wallet, string calldata name) external onlyRegistrar {
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

    /// @notice Migration-only: register a merchant carrying over its
    ///         historical volume/paymentCount/registeredAt from a prior
    ///         MerchantRegistry, instead of starting at 0/0/now like
    ///         registerMerchant(). Owner-only (never the agent/registrar) and
    ///         permanently disabled once closeMigration() is called -- see
    ///         INVARIANT-MR-4. Does not touch or weaken registerMerchant()'s
    ///         own isRegistrar/isManager gating (L-02) in any way.
    function registerMerchantWithHistory(
        address wallet,
        string calldata name,
        bool active,
        uint256 volume,
        uint256 paymentCount,
        uint64 registeredAt
    ) external onlyOwner {
        require(migrationOpen, "migration closed");
        require(wallet != address(0), "zero wallet");
        require(_merchants[wallet].registeredAt == 0, "already registered");
        require(registeredAt != 0, "zero registeredAt");
        _merchants[wallet] = Merchant({
            wallet: wallet,
            name: name,
            active: active,
            volume: volume,
            paymentCount: paymentCount,
            registeredAt: registeredAt
        });
        _all.push(wallet);
        emit MerchantRegistered(wallet, name);
    }

    /// @notice Permanently disable registerMerchantWithHistory(). One-way --
    ///         there is no function to set migrationOpen back to true.
    function closeMigration() external onlyOwner {
        migrationOpen = false;
        emit MigrationClosed();
    }

    /// @notice Toggle active status for an onboarded merchant.
    function setActive(address wallet, bool active) external onlyManager {
        require(_merchants[wallet].registeredAt != 0, "unknown merchant");
        _merchants[wallet].active = active;
        emit MerchantStatusChanged(wallet, active);
    }

    /// @notice Accrue settled volume for a merchant. Restricted to authorized recorder.
    function recordVolume(address wallet, uint256 amount) external {
        require(isRecorder[msg.sender], "not recorder");
        Merchant storage m = _merchants[wallet];
        if (m.registeredAt == 0) return; // Unregistered payee — skip silently
        m.volume += amount;
        m.paymentCount += 1;
        emit MerchantVolumeUpdated(wallet, amount, m.volume);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */

    /// @notice Check if a wallet is registered in the directory.
    function isRegistered(address wallet) external view returns (bool) {
        return _merchants[wallet].registeredAt != 0;
    }

    /// @notice Check if a merchant wallet is active.
    function isActive(address wallet) external view returns (bool) {
        return _merchants[wallet].active;
    }

    /// @notice Fetch complete Merchant record for a wallet.
    function getMerchant(address wallet) external view returns (Merchant memory) {
        return _merchants[wallet];
    }

    /// @notice Total count of registered merchants.
    function merchantCount() external view returns (uint256) {
        return _all.length;
    }

    /// @notice Get registered merchant address by index.
    function merchantAt(uint256 i) external view returns (address) {
        return _all[i];
    }

    /// @notice Returns array of all registered merchant addresses.
    function allMerchants() external view returns (address[] memory) {
        return _all;
    }
}
