// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @dev Minimal ERC-721 with a paid public `mint()` that mints to the caller
 *      via the safe path (calls onERC721Received). Used to test MintRouter.
 */
contract MockMintNFT {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint256 public price;
    uint256 public nextId;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    error WrongPrice();
    error NotAuthorized();
    error NotOwner();
    error UnsafeRecipient();

    constructor(uint256 _price) {
        price = _price;
    }

    /// @dev Mints to msg.sender. Reverts unless exactly `price` is sent.
    function mint() external payable returns (uint256 tokenId) {
        if (msg.value != price) revert WrongPrice();
        tokenId = nextId++;
        _safeMint(msg.sender, tokenId);
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf[tokenId];
        if (msg.sender != o && !isApprovedForAll[o][msg.sender]) revert NotAuthorized();
        getApproved[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        if (ownerOf[tokenId] != from) revert NotOwner();
        if (
            msg.sender != from &&
            getApproved[tokenId] != msg.sender &&
            !isApprovedForAll[from][msg.sender]
        ) revert NotAuthorized();
        delete getApproved[tokenId];
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _safeMint(address to, uint256 tokenId) internal {
        balanceOf[to] += 1;
        ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
        _checkReceiver(address(0), to, tokenId);
    }

    function _checkReceiver(address from, address to, uint256 tokenId) internal {
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, "") returns (bytes4 ret) {
                if (ret != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}
