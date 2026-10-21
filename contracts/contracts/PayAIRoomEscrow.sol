// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20RoomEscrow {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PayAIRoomEscrow
 * @notice Holds PayAI Room contributions until the room's own, immutable
 *         conditions decide where they go: to the room's beneficiary when the
 *         room completes in time, or back to each contributor when it doesn't.
 *
 *         Two room kinds:
 *           FixedShare — `slots` people each pay exactly `share`; target is
 *                        share * slots; one contribution per address.
 *           Target     — anyone contributes >= `minContribution` (or exactly
 *                        the remainder, when that is smaller), never more than
 *                        the remainder; completes when raised == target.
 *
 *         Platform minimum contribution (PA-05): the owner sets a per-token
 *         floor (`minContributionFloor`, > 0; native MON's is set in the
 *         constructor). createRoom refuses a token with no floor, a FixedShare
 *         `share` below it, and a Target `minContribution` below it. The floor
 *         is therefore baked into each room's own immutable `share` /
 *         `minContribution`, and `contribute` is unchanged: the exact
 *         remainder is still always accepted, so a valid room can always
 *         complete. Changing a floor affects only rooms created afterwards.
 *
 *         Fee: PayAI's Rooms platform fee is 0.5% (50 bps) of a SUCCESSFUL
 *         room's proceeds, deducted from the payout — never added to a
 *         contribution, never taken from a refund. MAX_FEE_BPS caps it at 50
 *         on-chain; each room snapshots the rate and treasury when created.
 *         The fee is ACCRUED to that treasury on claim and withdrawn
 *         separately (withdrawFees), so a treasury that can't receive can
 *         never block a beneficiary's payout.
 *
 *         Lifecycle (derived, never set directly):
 *           Open       — before the deadline, not cancelled, not complete;
 *           Completed  — raised reached target before the deadline (claimable);
 *           Claimed    — the beneficiary was paid;
 *           Expired    — deadline passed without completion (refundable);
 *           Cancelled  — creator cancelled before completion (refundable).
 *
 * ── What this contract is NOT ────────────────────────────────────────────────
 *   - NOT upgradeable: no proxy, no delegatecall, no arbitrary call surface.
 *   - NOT owner-custodied: the owner can never move, redirect or freeze funds
 *     held for a room (principal, payouts, refunds). Its powers (pause new
 *     rooms and contributions, fee <= 0.5%, treasury, token allowlist,
 *     minimum-contribution floors, two-step ownership) only shape FUTURE rooms; every value a room depends
 *     on is snapshotted into the room at creation. The one power over
 *     existing balances is recoverFees(): re-assigning PayAI's OWN accrued
 *     platform fees from an old treasury to the current treasury (accounting
 *     only; never room money).
 *
 * @custom:security-property INVARIANT-RE-1: Immutable Terms
 *   No function writes a room's kind, token, beneficiary, share, slots,
 *   target, minContribution, deadline, feeBps, treasury or termsHash after
 *   createRoom. Only progress fields (raised, refunded, contributors,
 *   completedAt, claimed, cancelled) move.
 * @custom:security-property INVARIANT-RE-2: Funds Leave Only Three Ways
 *   Room funds leave this contract only via claim()/claimTo() (net to the
 *   beneficiary — or where the beneficiary itself directs — once, after
 *   completion; the fee is accrued to the room's snapshotted treasury),
 *   refund()/refundTo() (a contributor's own amount, once, after
 *   cancellation or expiry without completion), or withdrawFees() (accrued
 *   fees, only ever to the treasury that holds them in feesOwed — the room's
 *   snapshotted treasury, or the current treasury after an owner
 *   recoverFees()). A room is either claimed or refundable, never both.
 * @custom:security-property INVARIANT-RE-8: Fee Recovery Is Accounting Only
 *   recoverFees() (owner) moves an accrued fee balance from an old treasury
 *   to the current one. It transfers nothing and never reads or writes room
 *   state, so sum(feesOwed) and every room's principal are unchanged.
 * @custom:security-property INVARIANT-RE-9: Permissionless Claim, Fixed Payee
 *   claim() may be called by anyone once a room is complete; the net always
 *   goes to the room's beneficiary and the fee to its snapshotted treasury.
 *   Only the beneficiary itself can redirect its payout (claimTo).
 * @custom:security-property INVARIANT-RE-10: Platform Minimum, Always Completable
 *   Every accepted contribution is >= the room's minimum (FixedShare: share;
 *   Target: minContribution), both >= the token's floor at creation — except
 *   the exact remainder, which is always accepted, so any positive remaining
 *   amount can be paid and a room can always complete before its deadline.
 * @custom:security-property INVARIANT-RE-11: No Blocklist Bypass
 *   claimTo/refundTo refuse a caller the token reports as blocklisted
 *   (isBlacklisted), so funds frozen by the issuer stay in escrow until the
 *   issuer lifts the block. claim/refund to the owner's own address are
 *   unchanged (the token itself refuses a blocklisted recipient).
 * @custom:security-property INVARIANT-RE-7: Solvency
 *   For every token: balance >= sum over unclaimed rooms of (raised -
 *   refunded) + sum of feesOwed. Equality holds unless someone force-sends
 *   native MON (selfdestruct), which only adds an unowned surplus.
 * @custom:security-property INVARIANT-RE-3: Claims And Refunds Are Never Paused
 *   `paused` blocks createRoom and contribute only.
 * @custom:security-property INVARIANT-RE-4: Exact Delivery
 *   ERC-20 contributions must raise this contract's balance by exactly the
 *   amount recorded (fee-on-transfer and short tokens revert); native
 *   contributions require msg.value == amount.
 * @custom:security-property INVARIANT-RE-5: Deadline Boundary
 *   contribute requires block.timestamp < deadline; expiry (and therefore a
 *   non-cancel refund) requires block.timestamp >= deadline. There is no
 *   timestamp at which both or neither apply.
 * @custom:security-property INVARIANT-RE-6: Reentrancy & CEI
 *   Every state-changing external function is nonReentrant and updates state
 *   before any external call.
 */
contract PayAIRoomEscrow {
    /* ── Types ──────────────────────────────────────────────────────────── */

    enum Kind { FixedShare, Target }
    enum Status { None, Open, Completed, Claimed, Expired, Cancelled }

    struct Room {
        // Terms — written once in createRoom, never again (INVARIANT-RE-1).
        address creator;
        address beneficiary;
        address token;          // address(0) = native MON
        address treasury;       // fee recipient, snapshotted
        Kind kind;
        uint16 feeBps;          // snapshotted, <= MAX_FEE_BPS
        uint64 deadline;        // unix seconds; contributions strictly before
        uint32 slots;           // FixedShare only; 0 for Target
        uint256 share;          // FixedShare only; 0 for Target
        uint256 target;         // FixedShare: share * slots
        uint256 minContribution;// Target only; 0 for FixedShare
        bytes32 termsHash;      // binds off-chain metadata (title, description)
        // Progress.
        uint256 raised;         // total ever contributed (never decreases)
        uint256 refunded;       // total refunded
        uint32 contributors;    // distinct contributing addresses
        uint64 completedAt;     // 0 = not complete
        bool claimed;
        bool cancelled;
    }

    /* ── Constants ──────────────────────────────────────────────────────── */

    /// @notice PayAI Rooms platform fee ceiling: 0.5%. No room can ever be created with more.
    uint16 public constant MAX_FEE_BPS = 50;
    /// @notice Largest target: keeps raised * feeBps far from uint256 overflow, so a claim can never revert on arithmetic.
    uint256 public constant MAX_TARGET = type(uint256).max / 10000;
    uint32 public constant MIN_SLOTS = 2;
    uint32 public constant MAX_SLOTS = 1000;
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 90 days;

    /* ── State ──────────────────────────────────────────────────────────── */

    address public owner;
    address public pendingOwner;
    bool public paused;
    address public treasury;
    uint16 public feeBps;
    uint256 public roomCount;
    mapping(address => bool) public tokenSupported;    // ERC-20 allowlist; native is always supported
    /// @notice Platform minimum contribution per token (address(0) = native MON), in base units.
    ///         0 means "not set": createRoom refuses the token (fail closed).
    mapping(address => uint256) public minContributionFloor;
    mapping(uint256 => Room) private _rooms;
    mapping(uint256 => mapping(address => uint256)) public contributionOf;
    /// @notice Fees accrued by successful claims, per treasury and token, awaiting withdrawFees.
    mapping(address => mapping(address => uint256)) public feesOwed;
    bool private _locked;

    /* ── Events ─────────────────────────────────────────────────────────── */

    event RoomCreated(
        uint256 indexed roomId,
        address indexed creator,
        address indexed beneficiary,
        address token,
        Kind kind,
        uint256 share,
        uint32 slots,
        uint256 target,
        uint256 minContribution,
        uint64 deadline,
        uint16 feeBps,
        address treasury,
        bytes32 termsHash
    );
    event Contributed(uint256 indexed roomId, address indexed contributor, uint256 amount, uint256 raised);
    event RoomCompleted(uint256 indexed roomId, uint256 raised);
    /// @dev `to` is where the net payout went: the beneficiary, unless the beneficiary used claimTo.
    event Claimed(uint256 indexed roomId, address indexed to, uint256 net, uint256 fee, address treasury);
    /// @dev `to` received the refund: the contributor, unless they used refundTo.
    event Refunded(uint256 indexed roomId, address indexed contributor, uint256 amount);
    event RefundSent(uint256 indexed roomId, address indexed contributor, address indexed to, uint256 amount);
    event FeesWithdrawn(address indexed treasury, address indexed token, uint256 amount);
    event FeesRecovered(address indexed fromTreasury, address indexed toTreasury, address indexed token, uint256 amount);
    event RoomCancelled(uint256 indexed roomId);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed from, address indexed to);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event TreasurySet(address treasury);
    event FeeBpsSet(uint16 feeBps);
    event TokenSupportSet(address indexed token, bool supported);
    event MinContributionFloorSet(address indexed token, uint256 amount);

    /* ── Modifiers ──────────────────────────────────────────────────────── */

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    /* ── Admin (future rooms only) ──────────────────────────────────────── */

    constructor(address initialOwner, address treasury_, uint16 feeBps_, uint256 nativeMinContribution_) {
        require(initialOwner != address(0), "owner zero");
        require(treasury_ != address(0), "bad treasury");
        require(feeBps_ <= MAX_FEE_BPS, "fee too high");
        owner = initialOwner;
        treasury = treasury_;
        feeBps = feeBps_;
        emit OwnershipTransferred(address(0), initialOwner);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
        _setMinContributionFloor(address(0), nativeMinContribution_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setTreasury(address t) external onlyOwner {
        require(t != address(0) && t != address(this), "bad treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    function setFeeBps(uint16 b) external onlyOwner {
        require(b <= MAX_FEE_BPS, "fee too high");
        feeBps = b;
        emit FeeBpsSet(b);
    }

    function setTokenSupported(address token, bool supported) external onlyOwner {
        require(token != address(0), "native always supported");
        tokenSupported[token] = supported;
        emit TokenSupportSet(token, supported);
    }

    /// @notice Set the platform minimum contribution for `token` (address(0) =
    ///         native MON). Must be > 0. Applies only to rooms created afterwards
    ///         (each room bakes it into its own share / minContribution).
    function setMinContributionFloor(address token, uint256 amount) external onlyOwner {
        _setMinContributionFloor(token, amount);
    }

    function _setMinContributionFloor(address token, uint256 amount) private {
        require(amount > 0, "floor zero");
        minContributionFloor[token] = amount;
        emit MinContributionFloorSet(token, amount);
    }

    /// @notice Two-step: the new owner must accept, so a typo can't brick administration.
    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "owner zero");
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /* ── Rooms ──────────────────────────────────────────────────────────── */

    /**
     * @notice Create a room. Its terms can never change afterwards.
     * @param kind            FixedShare or Target.
     * @param token           address(0) for native MON, or an allowlisted ERC-20.
     * @param beneficiary     Who receives the funds on a successful claim.
     * @param share           FixedShare: each person's exact amount. Target: must be 0.
     * @param slots           FixedShare: number of people (MIN_SLOTS..MAX_SLOTS). Target: must be 0.
     * @param target          Target: the amount to raise. FixedShare: must be share * slots.
     * @param minContribution Target: smallest contribution (except the final remainder); must be
     *                        >= minContributionFloor[token]. FixedShare: must be 0 (share must be >= the floor).
     * @param deadline        Unix seconds; between now + MIN_DURATION and now + MAX_DURATION.
     * @param termsHash       Hash of the off-chain metadata the creator agreed to.
     */
    function createRoom(
        Kind kind,
        address token,
        address beneficiary,
        uint256 share,
        uint32 slots,
        uint256 target,
        uint256 minContribution,
        uint64 deadline,
        bytes32 termsHash
    ) external nonReentrant returns (uint256 roomId) {
        require(!paused, "paused");
        require(token == address(0) || tokenSupported[token], "token not supported");
        require(beneficiary != address(0) && beneficiary != address(this), "bad beneficiary");
        require(deadline >= block.timestamp + MIN_DURATION, "deadline too soon");
        require(deadline <= block.timestamp + MAX_DURATION, "deadline too far");
        require(target > 0, "target zero");
        require(target <= MAX_TARGET, "target too large");
        if (kind == Kind.FixedShare) {
            require(share > 0, "share zero");
            require(slots >= MIN_SLOTS && slots <= MAX_SLOTS, "bad slots");
            require(target == share * slots, "target != share * slots");
            require(minContribution == 0, "min not allowed");
        } else {
            require(share == 0 && slots == 0, "share/slots not allowed");
            require(minContribution <= target, "min > target");
        }
        _checkPlatformMinimum(kind, token, share, target, minContribution);

        roomId = roomCount++;
        Room storage r = _rooms[roomId];
        r.creator = msg.sender;
        r.beneficiary = beneficiary;
        r.token = token;
        r.treasury = treasury;
        r.kind = kind;
        r.feeBps = feeBps;
        r.deadline = deadline;
        r.slots = slots;
        r.share = share;
        r.target = target;
        r.minContribution = minContribution;
        r.termsHash = termsHash;

        emit RoomCreated(roomId, msg.sender, beneficiary, token, kind, share, slots, target, minContribution, deadline, r.feeBps, r.treasury, termsHash);
    }

    /// @notice Contribute `amount` to an open room. Native: send msg.value == amount.
    ///         ERC-20: approve this contract for exactly `amount` first.
    /// @dev PA-05: the token's platform floor must be set, and each room's own
    ///      minimum (FixedShare: share; Target: minContribution, hence also
    ///      target) must be at least that floor.
    function _checkPlatformMinimum(Kind kind, address token, uint256 share, uint256 target, uint256 minContribution) private view {
        uint256 floor = minContributionFloor[token];
        require(floor > 0, "no minimum set");
        if (kind == Kind.FixedShare) {
            require(share >= floor, "share below minimum");
        } else {
            require(target >= floor, "target below minimum");
            require(minContribution >= floor, "min below minimum");
        }
    }

    function contribute(uint256 roomId, uint256 amount) external payable nonReentrant {
        require(!paused, "paused");
        Room storage r = _rooms[roomId];
        require(r.creator != address(0), "no room");
        require(!r.cancelled, "cancelled");
        require(r.completedAt == 0, "complete");
        require(block.timestamp < r.deadline, "deadline passed");
        require(amount > 0, "amount zero");

        uint256 remaining = r.target - r.raised;
        if (r.kind == Kind.FixedShare) {
            require(amount == r.share, "amount != share");
            require(contributionOf[roomId][msg.sender] == 0, "already contributed");
        } else {
            require(amount <= remaining, "exceeds remaining");
            require(amount >= r.minContribution || amount == remaining, "below minimum");
        }

        // Effects.
        if (contributionOf[roomId][msg.sender] == 0) r.contributors += 1;
        contributionOf[roomId][msg.sender] += amount;
        r.raised += amount;
        bool completes = r.raised == r.target;
        if (completes) r.completedAt = uint64(block.timestamp);

        // Interactions.
        if (r.token == address(0)) {
            require(msg.value == amount, "value != amount");
        } else {
            require(msg.value == 0, "native not accepted");
            IERC20RoomEscrow t = IERC20RoomEscrow(r.token);
            uint256 before = t.balanceOf(address(this));
            require(t.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
            require(t.balanceOf(address(this)) - before == amount, "short delivery");
        }

        emit Contributed(roomId, msg.sender, amount, r.raised);
        if (completes) emit RoomCompleted(roomId, r.raised);
    }

    /// @notice Pay a completed room's net proceeds to its beneficiary, once.
    ///         ANYONE may trigger it (PA-11): the caller chooses nothing — the
    ///         payout always goes to the beneficiary fixed at creation, the fee
    ///         (room's snapshotted rate) is accrued to the room's snapshotted
    ///         treasury, and the caller receives nothing. This keeps a
    ///         completed room from sitting in escrow because its creator and
    ///         beneficiary never act.
    function claim(uint256 roomId) external nonReentrant {
        Room storage r = _rooms[roomId];
        require(r.creator != address(0), "no room");
        _claim(roomId, r, r.beneficiary);
    }

    /// @notice The beneficiary directs its own payout elsewhere — e.g. when it
    ///         can't receive (a contract rejecting MON, a token-blocklisted
    ///         address). Only the beneficiary can call it.
    function claimTo(uint256 roomId, address to) external nonReentrant {
        Room storage r = _rooms[roomId];
        require(r.creator != address(0), "no room");
        require(msg.sender == r.beneficiary, "not beneficiary");
        require(to != address(0) && to != address(this), "bad recipient");
        _requireNotBlocklisted(r.token, msg.sender);
        _claim(roomId, r, to);
    }

    function _claim(uint256 roomId, Room storage r, address to) private {
        require(r.completedAt != 0, "not complete");
        require(!r.claimed, "already claimed");

        r.claimed = true;
        uint256 fee = (r.raised * r.feeBps) / 10000;
        uint256 net = r.raised - fee;
        if (fee > 0) feesOwed[r.treasury][r.token] += fee;

        _send(r.token, to, net);
        emit Claimed(roomId, to, net, fee, r.treasury);
    }

    /// @notice Take back your own contribution from a cancelled room, or one whose
    ///         deadline passed without completing. Once. No fee.
    function refund(uint256 roomId) external nonReentrant {
        _refund(roomId, msg.sender);
    }

    /// @notice As refund(), but sent where the contributor directs (for a
    ///         contributor that can't receive at its own address).
    function refundTo(uint256 roomId, address to) external nonReentrant {
        require(to != address(0) && to != address(this), "bad recipient");
        _requireNotBlocklisted(_rooms[roomId].token, msg.sender);
        _refund(roomId, to);
    }

    function _refund(uint256 roomId, address to) private {
        Room storage r = _rooms[roomId];
        require(r.creator != address(0), "no room");
        require(r.completedAt == 0, "complete");
        require(r.cancelled || block.timestamp >= r.deadline, "not refundable");
        uint256 amount = contributionOf[roomId][msg.sender];
        require(amount > 0, "nothing to refund");

        contributionOf[roomId][msg.sender] = 0;
        r.refunded += amount;

        _send(r.token, to, amount);
        emit Refunded(roomId, msg.sender, amount);
        if (to != msg.sender) emit RefundSent(roomId, msg.sender, to, amount);
    }

    /// @notice Owner-only fee recovery (PA-01): move the fees ACCRUED for an old
    ///         treasury (e.g. one that can no longer receive) onto the CURRENT
    ///         treasury's balance. Pure accounting — it transfers nothing, so it
    ///         can't touch room principal, beneficiaries, refunds or any token
    ///         beyond what is already recorded as owed. The destination is
    ///         never chosen here: it is always the current `treasury`, which
    ///         only setTreasury (validated, evented) can change. Rooms keep
    ///         their snapshotted treasury; later claims still accrue there and
    ///         can be recovered again.
    function recoverFees(address fromTreasury, address token) external onlyOwner nonReentrant {
        address to = treasury;
        require(fromTreasury != to, "already current treasury");
        uint256 amount = feesOwed[fromTreasury][token];
        require(amount > 0, "nothing owed");
        feesOwed[fromTreasury][token] = 0;
        feesOwed[to][token] += amount;
        emit FeesRecovered(fromTreasury, to, token, amount);
    }

    /// @notice Send fees accrued for `treasury_` in `token` to that treasury.
    ///         Anyone may call it; the money can only go to the treasury it
    ///         was accrued for.
    function withdrawFees(address treasury_, address token) external nonReentrant {
        uint256 amount = feesOwed[treasury_][token];
        require(amount > 0, "nothing owed");
        feesOwed[treasury_][token] = 0;
        _send(token, treasury_, amount);
        emit FeesWithdrawn(treasury_, token, amount);
    }

    /// @notice Creator cancels an open room; every contribution becomes refundable.
    function cancel(uint256 roomId) external nonReentrant {
        Room storage r = _rooms[roomId];
        require(r.creator != address(0), "no room");
        require(msg.sender == r.creator, "not creator");
        require(!r.cancelled, "cancelled");
        require(r.completedAt == 0, "complete");
        require(block.timestamp < r.deadline, "deadline passed");
        r.cancelled = true;
        emit RoomCancelled(roomId);
    }

    /* ── Views ──────────────────────────────────────────────────────────── */

    function getRoom(uint256 roomId) external view returns (Room memory) {
        return _rooms[roomId];
    }

    function statusOf(uint256 roomId) public view returns (Status) {
        Room storage r = _rooms[roomId];
        if (r.creator == address(0)) return Status.None;
        if (r.claimed) return Status.Claimed;
        if (r.completedAt != 0) return Status.Completed;
        if (r.cancelled) return Status.Cancelled;
        if (block.timestamp >= r.deadline) return Status.Expired;
        return Status.Open;
    }

    /// @notice What `who` could refund from this room right now (0 if not refundable).
    function refundableOf(uint256 roomId, address who) external view returns (uint256) {
        Status s = statusOf(roomId);
        if (s != Status.Cancelled && s != Status.Expired) return 0;
        return contributionOf[roomId][who];
    }

    /// @notice What a claim would pay right now: (net to the beneficiary, fee accrued to the treasury). Zeros if not claimable.
    function claimableOf(uint256 roomId) external view returns (uint256 net, uint256 fee) {
        if (statusOf(roomId) != Status.Completed) return (0, 0);
        Room storage r = _rooms[roomId];
        fee = (r.raised * r.feeBps) / 10000;
        net = r.raised - fee;
    }

    /* ── Internal ───────────────────────────────────────────────────────── */

    /// @dev M-1 (review 2026-10-21): claimTo/refundTo must not let an owner the
    ///      token issuer has blocklisted move frozen funds to a fresh address.
    ///      Asks the token's isBlacklisted(address) (Circle FiatToken, i.e.
    ///      USDC). A token without that function (or native MON) is treated as
    ///      having no blocklist, so the redirect keeps working for its real
    ///      purpose: a beneficiary or contributor that simply can't receive.
    function _requireNotBlocklisted(address token, address who) private view {
        if (token == address(0)) return;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0xfe575a87, who)); // isBlacklisted(address)
        if (ok && ret.length >= 32) require(abi.decode(ret, (uint256)) == 0, "owner blocklisted");
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "native send failed");
        } else {
            IERC20RoomEscrow t = IERC20RoomEscrow(token);
            uint256 before = t.balanceOf(to);
            require(t.transfer(to, amount), "transfer failed");
            require(t.balanceOf(to) - before == amount, "short transfer");
        }
    }

    /// @dev Reject stray native transfers — every wei held must belong to a room.
    receive() external payable {
        revert("use contribute");
    }
}
