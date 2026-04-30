// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidityPoolPair.sol";

contract LiquidityPoolFactory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "Identical tokens");

        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        require(getPair[token0][token1] == address(0), "Pair exists");

        pair = address(new LiquidityPoolPair(token0, token1));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;

        allPairs.push(pair);
    }
}