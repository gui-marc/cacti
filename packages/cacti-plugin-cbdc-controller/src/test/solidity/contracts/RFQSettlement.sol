// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract RFQSettlement is EIP712 {
    struct Quote {
        bytes32 id;
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
    mapping(bytes32 => bool) public usedQuotes;

    constructor(address _marketMaker) EIP712("CactiRFQSettlement", "1") {
        require(_marketMaker != address(0), "zero mm");
        marketMaker = _marketMaker;
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

    function settle(Quote calldata q, bytes calldata signature) external {
        require(block.timestamp <= q.expiry, "expired");
        require(!usedQuotes[q.id], "replay");
        require(msg.sender == q.taker, "wrong taker");

        address signer = ECDSA.recover(hashQuote(q), signature);
        require(signer == marketMaker, "bad sig");

        usedQuotes[q.id] = true;

        require(
            IERC20(q.tokenIn).transferFrom(msg.sender, marketMaker, q.amountIn),
            "tokenIn transfer failed"
        );
        require(
            IERC20(q.tokenOut).transferFrom(marketMaker, msg.sender, q.amountOut),
            "tokenOut transfer failed"
        );
    }

    function invalidate(bytes32 quoteId) external {
        require(msg.sender == marketMaker, "only mm");
        usedQuotes[quoteId] = true;
    }
}
