// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// On-chain RFQ settlement with escrowed market-maker liquidity and an explicit
// lock-and-hold state machine. The market maker prices each request off-chain
// and signs an EIP-712 Quote (classic RFQ); the chain is the custody and
// settlement authority. Locking, releasing and settling all happen on-chain so
// the held rate is deterministic and slippage-free, and release/settle are
// idempotent (safe to retry).
contract RFQSettlement is EIP712 {
    enum LockState {
        NONE,
        ACTIVE,
        SETTLED,
        RELEASED
    }

    struct Quote {
        bytes32 id;
        address taker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 expiry;
    }

    // Snapshot of a held quote. Everything settle/release needs is captured here
    // at lock time, so those calls are pure functions of on-chain state keyed by
    // `id` and never re-take the signature or re-price.
    struct Lock {
        LockState state;
        address taker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 expiry;
    }

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 id,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 expiry)"
    );

    address public marketMaker;

    // Escrowed MM liquidity per token. `available` backs new quotes; `locked` is
    // earmarked by outstanding ACTIVE locks and cannot back new quotes until the
    // corresponding lock is released or settled.
    mapping(address => uint256) public available;
    mapping(address => uint256) public locked;

    mapping(bytes32 => Lock) public locks;

    constructor(address _marketMaker) EIP712("CactiRFQSettlement", "1") {
        require(_marketMaker != address(0), "zero mm");
        marketMaker = _marketMaker;
    }

    // The MM supplies priceless inventory: pull `amount` of `token` into escrow
    // and credit the available balance that backs future quotes. The MM must
    // have approved this contract for `amount` first.
    function deposit(address token, uint256 amount) external {
        require(amount > 0, "zero amount");
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "deposit transfer failed"
        );
        available[token] += amount;
    }

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.id,
                q.taker,
                q.tokenIn,
                q.tokenOut,
                q.amountIn,
                q.amountOut,
                q.expiry
            )
        );
        return _hashTypedDataV4(structHash);
    }

    // Open an on-chain hold over an MM-signed quote: verify the MM authorised
    // this exact rate, enforce the caller's acceptance bounds, and earmark the
    // quote's amountOut out of available escrow. NOT idempotent: a duplicate id
    // reverts (which also subsumes signature replay protection). Expiry gates
    // quote *acceptance* here only; it is never re-checked at settlement time.
    function lock(
        Quote calldata q,
        bytes calldata signature,
        uint256 minAmountOut,
        uint256 maxAmountOut
    ) external {
        require(locks[q.id].state == LockState.NONE, "lock exists");
        require(block.timestamp <= q.expiry, "expired");
        require(
            ECDSA.recover(hashQuote(q), signature) == marketMaker,
            "bad sig"
        );
        require(q.amountOut >= minAmountOut, "below min output");
        require(
            maxAmountOut == 0 || q.amountOut <= maxAmountOut,
            "above max output"
        );
        require(available[q.tokenOut] >= q.amountOut, "insufficient liquidity");

        available[q.tokenOut] -= q.amountOut;
        locked[q.tokenOut] += q.amountOut;

        locks[q.id] = Lock({
            state: LockState.ACTIVE,
            taker: q.taker,
            tokenIn: q.tokenIn,
            tokenOut: q.tokenOut,
            amountIn: q.amountIn,
            amountOut: q.amountOut,
            expiry: q.expiry
        });
    }

    // Settle a held quote at the frozen rate. Pure function of on-chain state:
    // pulls amountIn from the *stored* taker into escrow and pays the pre-locked
    // amountOut from escrow to that taker, regardless of who submits the tx.
    // Idempotent: a re-settle of a SETTLED lock no-ops. There is intentionally
    // NO expiry check: once a lock is ACTIVE the MM is already committed and
    // settlement is obligatory and retryable forever, because the off-ledger
    // transfer this settlement backs has already happened.
    function settle(bytes32 id) external {
        Lock storage lock_ = locks[id];

        if (lock_.state == LockState.SETTLED) {
            return;
        }
        require(lock_.state == LockState.ACTIVE, "lock not active");

        lock_.state = LockState.SETTLED;
        locked[lock_.tokenOut] -= lock_.amountOut;
        available[lock_.tokenIn] += lock_.amountIn;

        require(
            IERC20(lock_.tokenIn).transferFrom(
                lock_.taker,
                address(this),
                lock_.amountIn
            ),
            "tokenIn transfer failed"
        );
        require(
            IERC20(lock_.tokenOut).transfer(lock_.taker, lock_.amountOut),
            "tokenOut transfer failed"
        );
    }

    // Release a held quote, returning the earmarked output to available escrow.
    // Permissionless and idempotent: any non-ACTIVE lock (unknown, already
    // released, or settled) no-ops, so pre-transfer abort paths can retry
    // safely. No expiry check. Only ever called before the off-ledger transfer.
    function release(bytes32 id) external {
        Lock storage lock_ = locks[id];

        if (lock_.state != LockState.ACTIVE) {
            return;
        }

        lock_.state = LockState.RELEASED;
        locked[lock_.tokenOut] -= lock_.amountOut;
        available[lock_.tokenOut] += lock_.amountOut;
    }
}
