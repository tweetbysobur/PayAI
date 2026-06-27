// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IMerchantRegistry
 * @notice Interface for the merchant directory used by PaymentExecutor to
 *         validate payees and accrue per-merchant volume.
 */
interface IMerchantRegistry {
    struct Merchant {
        address wallet;
        string name;
        bool active;
        uint256 volume;       // cumulative amount received (base units)
        uint256 paymentCount; // number of payments received
        uint64 registeredAt;
    }

    event MerchantRegistered(address indexed wallet, string name);
    event MerchantStatusChanged(address indexed wallet, bool active);
    event MerchantVolumeUpdated(address indexed wallet, uint256 amount, uint256 newVolume);

    function registerMerchant(address wallet, string calldata name) external;

    function setActive(address wallet, bool active) external;

    /// @notice Accrue volume for a merchant. Restricted to authorized recorders.
    function recordVolume(address wallet, uint256 amount) external;

    function isRegistered(address wallet) external view returns (bool);

    function isActive(address wallet) external view returns (bool);

    function getMerchant(address wallet) external view returns (Merchant memory);

    function merchantCount() external view returns (uint256);
}
