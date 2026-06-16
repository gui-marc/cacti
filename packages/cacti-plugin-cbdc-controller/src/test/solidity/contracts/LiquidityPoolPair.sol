// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LiquidityPoolPair is ERC20 {
    address public token0;
    address public token1;

    uint112 public reserve0;
    uint112 public reserve1;

    // Portion of each reserve that has been earmarked by an outstanding
    // lock-and-hold quote and is therefore not available for new quotes or
    // settlements until the corresponding lock is released or settled.
    uint112 public lockedReserve0;
    uint112 public lockedReserve1;

    enum LockState {
        NONE,
        ACTIVE,
        SETTLED,
        RELEASED
    }

    struct Lock {
        LockState state;
        address to;
        address tokenIn;
        uint256 amountIn;
        uint256 amountOut;
    }

    mapping(bytes32 => Lock) public locks;

    constructor(address _token0, address _token1)
        ERC20("LP Token", "LPT")
    {
        token0 = _token0;
        token1 = _token1;
    }

    function _update(uint balance0, uint balance1) private {
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
    }

    function addLiquidity(uint amount0, uint amount1) external returns (uint liquidity) {
        IERC20(token0).transferFrom(msg.sender, address(this), amount0);
        IERC20(token1).transferFrom(msg.sender, address(this), amount1);

        if (totalSupply() == 0) {
            liquidity = sqrt(amount0 * amount1);
        } else {
            liquidity = min(
                (amount0 * totalSupply()) / reserve0,
                (amount1 * totalSupply()) / reserve1
            );
        }

        _mint(msg.sender, liquidity);
        _update(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this))
        );
    }

    // Constant-product output for `amountIn` of `tokenIn`, priced against the
    // liquidity that is actually available (reserves net of outstanding locks).
    function getAmountOut(uint amountIn, address tokenIn)
        public
        view
        returns (uint amountOut)
    {
        require(amountIn > 0, "Insufficient input");
        bool isInToken0 = tokenIn == token0;
        require(isInToken0 || tokenIn == token1, "Unknown tokenIn");

        uint reserveIn = isInToken0
            ? uint(reserve0) - uint(lockedReserve0)
            : uint(reserve1) - uint(lockedReserve1);
        uint reserveOut = isInToken0
            ? uint(reserve1) - uint(lockedReserve1)
            : uint(reserve0) - uint(lockedReserve0);

        require(reserveIn > 0 && reserveOut > 0, "No liquidity");

        amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
        require(amountOut > 0, "Zero output");
        require(amountOut < reserveOut, "Insufficient liquidity");
    }

    // Lock-and-hold: price `amountIn` of `tokenIn` at the current available
    // reserves and earmark the resulting output for `to`. The earmarked output
    // can no longer be quoted or settled against by anyone else until this lock
    // is released or settled, which keeps the held rate deterministic and
    // slippage-free regardless of intervening trades.
    function lock(
        bytes32 id,
        uint amountIn,
        address tokenIn,
        address to,
        uint minAmountOut,
        uint maxAmountOut
    ) external returns (uint amountOut) {
        require(locks[id].state == LockState.NONE, "Lock exists");

        amountOut = getAmountOut(amountIn, tokenIn);
        require(amountOut >= minAmountOut, "Below min output");
        require(maxAmountOut == 0 || amountOut <= maxAmountOut, "Above max output");

        if (tokenIn == token0) {
            // Output is token1.
            lockedReserve1 += uint112(amountOut);
        } else {
            lockedReserve0 += uint112(amountOut);
        }

        locks[id] = Lock({
            state: LockState.ACTIVE,
            to: to,
            tokenIn: tokenIn,
            amountIn: amountIn,
            amountOut: amountOut
        });
    }

    // Release a held quote, returning the earmarked output to the available
    // reserves. Idempotent: releasing an already-released lock, or a lock that
    // was never created, is a no-op so callers can retry safely.
    function release(bytes32 id) external {
        Lock storage lock_ = locks[id];

        if (lock_.state == LockState.RELEASED || lock_.state == LockState.NONE) {
            return;
        }
        // TODO: once the lock state machine is fully enforced, settling an
        // already-settled lock must revert here instead of being tolerated, so
        // a released lock can never be mistaken for an open one.
        if (lock_.state == LockState.SETTLED) {
            return;
        }

        _unlockReserve(lock_);
        lock_.state = LockState.RELEASED;
    }

    // Settle a held quote: pull `amountIn` of the input token from the taker
    // and pay out the pre-locked output at the frozen rate. The constant-product
    // K invariant is intentionally NOT re-checked here — the held rate must be
    // honoured regardless of trades that happened during the hold window.
    // Idempotent: settling an already-settled lock is a no-op.
    function settle(bytes32 id) external {
        Lock storage lock_ = locks[id];

        if (lock_.state == LockState.SETTLED) {
            return;
        }
        // TODO: once the lock state machine is fully enforced, settling a NONE
        // or RELEASED lock must revert here (it currently no-ops / reverts via
        // the require below) to prevent consuming liquidity that was never held
        // or was already returned to the pool.
        require(lock_.state == LockState.ACTIVE, "Lock not active");

        address tokenOut = lock_.tokenIn == token0 ? token1 : token0;

        IERC20(lock_.tokenIn).transferFrom(
            msg.sender,
            address(this),
            lock_.amountIn
        );
        IERC20(tokenOut).transfer(lock_.to, lock_.amountOut);

        _unlockReserve(lock_);
        lock_.state = LockState.SETTLED;

        _update(
            IERC20(token0).balanceOf(address(this)),
            IERC20(token1).balanceOf(address(this))
        );
    }

    function _unlockReserve(Lock storage lock_) private {
        if (lock_.tokenIn == token0) {
            lockedReserve1 -= uint112(lock_.amountOut);
        } else {
            lockedReserve0 -= uint112(lock_.amountOut);
        }
    }

    // TODO: access control — `release` and `settle` are currently permissionless
    // (consistent with the rest of this pair). In a real deployment they should
    // be gated to the lock's taker / market maker so an attacker cannot release
    // someone else's held liquidity.
    // TODO: on-chain expiry — locks are freed only when a caller invokes
    // `release`. A production pair may want a self-expiring TTL so abandoned
    // locks cannot sterilise central-bank liquidity forever.

    function sqrt(uint y) internal pure returns (uint z) {
        if (y > 3) {
            z = y;
            uint x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function min(uint x, uint y) internal pure returns (uint) {
        return x < y ? x : y;
    }
}
