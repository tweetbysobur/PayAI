// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MintRouter
 * @notice Routes an NFT mint through a fee-taking intermediary. A user pays the
 *         mint price plus a service fee to this contract; the router mints from
 *         a configured target NFT, forwards the NFT to the buyer, sends the fee
 *         to the fee recipient, and refunds any excess.
 *
 *         Custody: the router only holds funds for the duration of one mint
 *         call. It never keeps user funds. The fee is forwarded immediately.
 *
 *         Compatibility: the target NFT must mint via `_safeMint` (the ERC-721
 *         standard's safe path), which calls `onERC721Received` on this router
 *         so it learns the minted token id and can forward it. A collection that
 *         mints with the non-safe `_mint` does not trigger that callback; point
 *         the router at such a contract only after confirming the token id can
 *         be captured, or the mint will revert on this router's guard.
 *
 * @dev Owner is a cold wallet. It configures the target and price but never
 *      takes user funds. `mintFor` is the only state-changing path for users.
 */
contract MintRouter {
    // ----- roles -----
    address public owner;

    // ----- fee config -----
    /// @notice Fee in basis points (1000 = 10%).
    uint16 public feeBps;
    /// @notice Where the service fee is sent.
    address public feeRecipient;

    // ----- target config -----
    /// @notice The NFT contract to mint from.
    address public targetNFT;
    /// @notice Price the target charges per mint, in wei of native MON.
    uint256 public mintPrice;
    /// @notice The exact calldata to send to the target's mint function.
    ///         Set by the owner once the live contract's mint signature is known
    ///         (e.g. the 4-byte selector of `mint()` for a mint-to-caller drop).
    bytes public mintCalldata;

    // ----- reentrancy guard -----
    uint256 private _lock = 1;

    // ----- transient mint state -----
    // Set during a mintFor call so onERC721Received can record the token id.
    bool private _minting;
    uint256 private _receivedTokenId;
    bool private _gotToken;

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event FeeConfigChanged(uint16 feeBps, address feeRecipient);
    event TargetChanged(address indexed targetNFT, uint256 mintPrice);
    event MintCalldataChanged(bytes mintCalldata);
    event Minted(address indexed buyer, uint256 indexed tokenId, uint256 pricePaid, uint256 fee);

    error NotOwner();
    error Reentrancy();
    error NotConfigured();
    error InsufficientPayment(uint256 required, uint256 sent);
    error MintFailed();
    error TokenNotReceived();
    error FeeTooHigh();
    error ZeroAddress();
    error RefundFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address _feeRecipient, uint16 _feeBps) {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > 5000) revert FeeTooHigh(); // hard cap: 50%
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        emit OwnerChanged(address(0), msg.sender);
        emit FeeConfigChanged(_feeBps, _feeRecipient);
    }

    // ----- admin -----

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setFeeConfig(uint16 _feeBps, address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > 5000) revert FeeTooHigh();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeConfigChanged(_feeBps, _feeRecipient);
    }

    /// @notice Point the router at the live NFT and set its mint price.
    function setTarget(address _targetNFT, uint256 _mintPrice) external onlyOwner {
        if (_targetNFT == address(0)) revert ZeroAddress();
        targetNFT = _targetNFT;
        mintPrice = _mintPrice;
        emit TargetChanged(_targetNFT, _mintPrice);
    }

    /// @notice Set the exact calldata used to call the target's mint function.
    function setMintCalldata(bytes calldata data) external onlyOwner {
        mintCalldata = data;
        emit MintCalldataChanged(data);
    }

    // ----- quote -----

    /// @notice Total a buyer must send: mint price plus the service fee.
    function quote() public view returns (uint256 total, uint256 fee) {
        fee = (mintPrice * feeBps) / 10_000;
        total = mintPrice + fee;
    }

    // ----- mint -----

    /**
     * @notice Mint one NFT and deliver it to `buyer`. Caller sends at least the
     *         quoted total. The mint price funds the target mint, the fee goes
     *         to the fee recipient, and any excess is refunded to the caller.
     */
    function mintFor(address buyer) external payable nonReentrant returns (uint256 tokenId) {
        if (targetNFT == address(0) || mintCalldata.length == 0) revert NotConfigured();
        if (buyer == address(0)) revert ZeroAddress();

        (uint256 total, uint256 fee) = quote();
        if (msg.value < total) revert InsufficientPayment(total, msg.value);

        // Reset transient state, then call the target mint with the mint price.
        _minting = true;
        _gotToken = false;
        _receivedTokenId = 0;

        (bool ok, ) = targetNFT.call{value: mintPrice}(mintCalldata);
        _minting = false;
        if (!ok) revert MintFailed();
        if (!_gotToken) revert TokenNotReceived();

        tokenId = _receivedTokenId;

        // Deliver the NFT to the buyer.
        IERC721(targetNFT).safeTransferFrom(address(this), buyer, tokenId);

        // Pay the service fee.
        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{value: fee}("");
            if (!feeOk) revert RefundFailed();
        }

        // Refund any excess to the caller.
        uint256 excess = msg.value - total;
        if (excess > 0) {
            (bool refundOk, ) = msg.sender.call{value: excess}("");
            if (!refundOk) revert RefundFailed();
        }

        emit Minted(buyer, tokenId, mintPrice, fee);
    }

    // ----- ERC-721 receiver -----

    /// @notice Captures the token id when the target `_safeMint`s to this router.
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        // Only accept during an active mint from the configured target.
        if (_minting && msg.sender == targetNFT) {
            _receivedTokenId = tokenId;
            _gotToken = true;
        }
        return this.onERC721Received.selector;
    }

    /// @notice Owner rescue for funds stuck from a failed forward. Not used in
    ///         normal flow because fees and refunds are pushed each mint.
    function sweep(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    /// @notice Owner rescue for an NFT left in the router (e.g. a buyer transfer
    ///         that reverted on a non-standard receiver).
    function sweepNFT(address nft, uint256 tokenId, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC721(nft).safeTransferFrom(address(this), to, tokenId);
    }

    receive() external payable {}
}

interface IERC721 {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
