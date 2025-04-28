import { ethers } from 'hardhat';
import { Signer, TransactionResponse } from 'ethers';
import {
    Percent,
    Token,
    Currency,
    NativeCurrency,
    CurrencyAmount,
    TradeType
} from '@uniswap/sdk-core';
import { FeeAmount, TICK_SPACINGS, EMPTY_BYTES, NATIVE_NOT_SET, UNIVERSAL_ROUTER, UNIVERSAL_ROUTER_ABI } from './constants';
import {
    V4PositionManager,
    V4Planner,
    Pool,
    Position,
    Actions,
    toHex,
    toAddress,
    Route,
    Trade,
} from '@uniswap/v4-sdk';

const SWAP_ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)',
    'function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 value) returns (bool)',
    'function transferFrom(address from, address to, uint256 value) returns (bool)'
];

interface ValueTracking {
    initialToken0Amount: bigint;
    initialToken1Amount: bigint;
    initialToken0Value: bigint; initialToken1Value: bigint; initialTotalValue: bigint;
    currentToken0Amount: bigint;
    currentToken1Amount: bigint;
    currentToken0Value: bigint;
    currentToken1Value: bigint;
    currentTotalValue: bigint;
    valueChangePercent: number;
    timestamp: number;
}


interface RebalancerConfig {
    swapRouterAddress: string; nftPositionManagerAddress: string; poolManagerAddress: string; slippageTolerance: Percent; deadline: number;
    token0Balance: bigint; token1Balance: bigint; tickRange: number; rebalanceThreshold: number; monitorInterval: number; priceImpactLimit: Percent;
}

interface posInfos {
    poolId: string;
    currencyA: Token;
    currencyB: Token;
    fee: number;
    tickSpacing: number;
    tokenId: number;
    positionId: string;
    tickLower: number;
    tickUpper: number;
}

const pos: posInfos[] = [
    {
        poolId: "0x04b7dd024db64cfbe325191c818266e4776918cd9eaf021c26949a859e654b16",
        currencyA: new Token(130, "0x4200000000000000000000000000000000000006", 18, "ETH"),
        currencyB: new Token(130, "0x9151434b16b9763660705744891fA906F660EcC5", 18, "USD0"),
        // 0.05% feee
        fee: 500,
        tickSpacing: 10,
        tokenId: 1,
        positionId: "1",
        tickLower: 100,
        tickUpper: 200,
    }
]


export class UniswapV4Rebalancer {
    private signer: Signer;
    private config: RebalancerConfig;
    private valueTracking: Map<string, ValueTracking> = new Map(); private monitorTask: NodeJS.Timeout | null = null;

    constructor(
        signer: Signer,
        config: Partial<RebalancerConfig>
    ) {
        this.signer = signer;

        this.config = {
            swapRouterAddress: config.swapRouterAddress || '',
            nftPositionManagerAddress: config.nftPositionManagerAddress || '',
            poolManagerAddress: config.poolManagerAddress || '',
            slippageTolerance: config.slippageTolerance || new Percent(1, 100), deadline: config.deadline || Math.floor(Date.now() / 1000) + 1800, token0Balance: config.token0Balance || 0n,
            token1Balance: config.token1Balance || 0n,
            tickRange: config.tickRange || 60, rebalanceThreshold: config.rebalanceThreshold || 5, monitorInterval: config.monitorInterval || 60000, priceImpactLimit: config.priceImpactLimit || new Percent(1, 100)
        };

        if (!this.config.swapRouterAddress) throw new Error('必须提供Swap Router地址');
        if (!this.config.nftPositionManagerAddress) throw new Error('必须提供NFT Position Manager地址');
        if (!this.config.poolManagerAddress) throw new Error('必须提供Pool Manager地址');
    }

    public calculateOptimalTickRange(
        currentTick: number,
        tickSpacing: number = TICK_SPACINGS[FeeAmount.MEDIUM]
    ): { tickLower: number, tickUpper: number } {
        const halfWidthInTicks = Math.floor(this.config.tickRange / 2);

        let tickLower = Math.floor((currentTick - halfWidthInTicks) / tickSpacing) * tickSpacing;
        let tickUpper = Math.ceil((currentTick + halfWidthInTicks) / tickSpacing) * tickSpacing;

        tickLower = Math.max(-887272, tickLower);
        tickUpper = Math.min(887272, tickUpper);

        return { tickLower, tickUpper };
    }

    public async swapExactInSingle(
        tokenIn: Token | NativeCurrency,
        tokenOut: Token | NativeCurrency,
        pool: Pool,
        fee: FeeAmount,
        amountIn: bigint,
        amountOutMinimum: bigint,
        recipient: string
    ): Promise<TransactionResponse> {
        let planner: V4Planner = new V4Planner();
        const route = new Route([pool], tokenIn, tokenOut);
        planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
            {
                poolKey: pool.poolKey,
                zeroForOne: true,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                hookData: '0x',
            },
        ]);

        const trade = await Trade.fromRoute(
            route,
            CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString()),
            TradeType.EXACT_INPUT
        )
        planner.addTrade(trade);
        const trade_data = planner.finalize();
        // 使用UniversalRouter
        const universalRouter = new ethers.Contract(
            UNIVERSAL_ROUTER,
            UNIVERSAL_ROUTER_ABI,
            this.signer
        );
        const swapMd = 0x10;
        const tx = await universalRouter.execute(swapMd, trade_data, this.config.deadline);
        return tx;
    }

    public async swapExactInput(
        tokenIn: Token | NativeCurrency,
        tokenOut: Token | NativeCurrency,
        fee: FeeAmount,
        amountIn: bigint,
        amountOutMinimum: bigint,
        recipient: string
    ): Promise<TransactionResponse> {
        try {
            const swapRouter = new ethers.Contract(
                this.config.swapRouterAddress,
                SWAP_ROUTER_ABI,
                this.signer
            );

            if (!tokenIn.isNative) {
                await this.approveToken(tokenIn as Token, this.config.swapRouterAddress, amountIn);
            }

            const params = {
                tokenIn: toAddress(tokenIn),
                tokenOut: toAddress(tokenOut),
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0n
            };

            const value = tokenIn.isNative ? amountIn : 0n;
            const tx = await swapRouter.exactInputSingle(params, { value });

            return tx;
        } catch (error) {
            console.error("执行Swap交易时出错:", error);
            throw error;
        }
    }

    private async approveToken(token: Token, spender: string, amount: bigint): Promise<void> {
        try {
            const tokenContract = new ethers.Contract(
                token.address,
                ERC20_ABI,
                this.signer
            );

            const owner = await this.signer.getAddress();
            const currentAllowance = await tokenContract.allowance(owner, spender);

            if (currentAllowance < amount) {
                const tx = await tokenContract.approve(spender, amount);
                await tx.wait();
                console.log(`授权 ${token.symbol} 成功，数量: ${amount}`);
            }
        } catch (error) {
            console.error(`授权代币 ${token.symbol} 时出错:`, error);
            throw error;
        }
    }

    private calculateOptimalTokenRatio(
        pool: Pool,
        targetLower: number,
        targetUpper: number
    ): { token0Ratio: number, token1Ratio: number } {
        const currentTick = pool.tickCurrent;

        let token0Ratio = 0.5;
        let token1Ratio = 0.5;

        if (currentTick < targetLower + (targetUpper - targetLower) * 0.25) {
            token0Ratio = 0.7;
            token1Ratio = 0.3;
        } else if (currentTick > targetUpper - (targetUpper - targetLower) * 0.25) {
            token0Ratio = 0.3;
            token1Ratio = 0.7;
        }

        return { token0Ratio, token1Ratio };
    }

    public async adjustTokenRatio(
        pool: Pool,
        existingToken0: bigint,
        existingToken1: bigint,
        targetRatio: { token0Ratio: number, token1Ratio: number }
    ): Promise<{ adjustedToken0: bigint, adjustedToken1: bigint }> {
        try {
            const currentSqrtRatioX96 = BigInt(pool.sqrtRatioX96.toString());
            const currentPriceBN = (currentSqrtRatioX96 * currentSqrtRatioX96) >> 192n;

            const token0ValueInToken1 = (existingToken0 * currentPriceBN) >> 192n;
            const totalValueInToken1 = token0ValueInToken1 + existingToken1;

            const targetToken1 = (totalValueInToken1 * BigInt(Math.floor(targetRatio.token1Ratio * 1000))) / 1000n;
            const targetToken0 = ((totalValueInToken1 - targetToken1) << 192n) / currentPriceBN;

            let token0Diff = 0n;
            let token1Diff = 0n;

            if (targetToken0 > existingToken0) {
                token1Diff = ((targetToken0 - existingToken0) * currentPriceBN) >> 192n;
                if (token1Diff > existingToken1) token1Diff = existingToken1;

                if (token1Diff > 0n) {
                    const minToken0Out = (token1Diff << 192n) / currentPriceBN *
                        (10000n - BigInt(this.config.slippageTolerance.numerator.toString())) /
                        BigInt(this.config.slippageTolerance.denominator.toString());

                    const recipient = await this.signer.getAddress();
                    await this.swapExactInput(
                        pool.currency1 as Token,
                        pool.currency0 as Token,
                        pool.fee,
                        token1Diff,
                        minToken0Out,
                        recipient
                    );
                }
            } else if (targetToken0 < existingToken0) {
                token0Diff = existingToken0 - targetToken0;

                if (token0Diff > 0n) {
                    const minToken1Out = (token0Diff * currentPriceBN) >> 192n *
                        (10000n - BigInt(this.config.slippageTolerance.numerator.toString())) /
                        BigInt(this.config.slippageTolerance.denominator.toString());

                    const recipient = await this.signer.getAddress();
                    await this.swapExactInput(
                        pool.currency0 as Token,
                        pool.currency1 as Token,
                        pool.fee,
                        token0Diff,
                        minToken1Out,
                        recipient
                    );
                }
            }

            const adjustedToken0 = await this.getTokenBalance(pool.currency0);
            const adjustedToken1 = await this.getTokenBalance(pool.currency1);

            return { adjustedToken0, adjustedToken1 };
        } catch (error) {
            console.error("调整代币比例时出错:", error);
            throw error;
        }
    }

    private async getTokenBalance(currency: Currency): Promise<bigint> {
        try {
            const address = await this.signer.getAddress();

            if (currency.isNative) {
                return await this.signer.provider?.getBalance(address) || 0n;
            } else {
                const tokenContract = new ethers.Contract(
                    (currency as Token).address,
                    ERC20_ABI,
                    this.signer
                );

                return await tokenContract.balanceOf(address);
            }
        } catch (error) {
            console.error(`获取 ${currency.symbol} 余额时出错:`, error);
            throw error;
        }
    }

    public async rebalance(
        tokenId: number,
        pool: Pool,
        currentPosition: Position,
        recipient: string,
        useNative?: NativeCurrency
    ): Promise<TransactionResponse | null> {
        try {

            await this.recordInitialValue(pool, currentPosition);

            const { tickLower: targetLower, tickUpper: targetUpper } =
                this.calculateOptimalTickRange(pool.tickCurrent, pool.tickSpacing);

            const isSameRange = currentPosition.tickLower === targetLower && currentPosition.tickUpper === targetUpper;
            if (isSameRange) {
                console.log('Position already in target range, no rebalance needed');
                return null;
            }

            if (useNative) {
                const hasNativeCurrency = pool.currency0.isNative || pool.currency1.isNative;
                if (!hasNativeCurrency) {
                    throw new Error(NATIVE_NOT_SET);
                }
            } else {
                const hasNativeCurrency = pool.currency0.isNative || pool.currency1.isNative;
                if (hasNativeCurrency) {
                    throw new Error(NATIVE_NOT_SET);
                }
            }

            const planner1 = new V4Planner();
            const liquidityToRemove = currentPosition.liquidity;
            const { amount0: amount0Min, amount1: amount1Min } =
                currentPosition.burnAmountsWithSlippage(this.config.slippageTolerance);

            planner1.addAction(Actions.DECREASE_LIQUIDITY, [
                tokenId.toString(),
                liquidityToRemove.toString(),
                toHex(amount0Min),
                toHex(amount1Min),
                EMPTY_BYTES
            ]);

            planner1.addAction(Actions.TAKE_PAIR, [
                toAddress(pool.currency0),
                toAddress(pool.currency1),
                recipient
            ]);

            const removeLiquidityCalldata = V4PositionManager.encodeModifyLiquidities(
                planner1.finalize(),
                this.config.deadline
            );

            const tx1 = await this.signer.sendTransaction({
                to: this.config.poolManagerAddress,
                data: removeLiquidityCalldata,
                value: 0n
            });

            await tx1.wait();
            console.log(`已移除流动性: ${tx1.hash}`);

            const token0Balance = await this.getTokenBalance(pool.currency0);
            const token1Balance = await this.getTokenBalance(pool.currency1);

            console.log(`当前余额: ${token0Balance} ${pool.currency0.symbol}, ${token1Balance} ${pool.currency1.symbol}`);

            const optimalRatio = this.calculateOptimalTokenRatio(pool, targetLower, targetUpper);
            console.log(`最佳比例: token0=${optimalRatio.token0Ratio}, token1=${optimalRatio.token1Ratio}`);

            const { adjustedToken0, adjustedToken1 } = await this.adjustTokenRatio(
                pool,
                token0Balance,
                token1Balance,
                optimalRatio
            );

            console.log(`调整后余额: ${adjustedToken0} ${pool.currency0.symbol}, ${adjustedToken1} ${pool.currency1.symbol}`);

            const newPosition = Position.fromAmounts({
                pool,
                tickLower: targetLower,
                tickUpper: targetUpper,
                amount0: adjustedToken0 > this.config.token0Balance ? this.config.token0Balance.toString() : adjustedToken0.toString(),
                amount1: adjustedToken1 > this.config.token1Balance ? this.config.token1Balance.toString() : adjustedToken1.toString(),
                useFullPrecision: true
            })

            const { calldata, value } = V4PositionManager.addCallParameters(
                newPosition,
                {
                    tokenId, slippageTolerance: this.config.slippageTolerance,
                    deadline: this.config.deadline,
                    useNative
                }
            );

            const tx2 = await this.signer.sendTransaction({
                to: this.config.poolManagerAddress,
                data: calldata,
                value: BigInt(value || "0")
            });

            await tx2.wait();
            console.log(`已添加流动性: ${tx2.hash}`);

            await this.updateValueTracking(pool);

            return tx2;
        } catch (error) {
            console.error("Rebalance transaction failed:", error);
            throw error;
        }
    }

    private async recordInitialValue(pool: Pool, position: Position): Promise<void> {
        try {
            const { amount0: token0Amount, amount1: token1Amount } = position.mintAmounts;

            const currentSqrtRatioX96 = BigInt(pool.sqrtRatioX96.toString());
            const currentPriceBN = (currentSqrtRatioX96 * currentSqrtRatioX96) >> 192n;

            const token0Value = (BigInt(token0Amount.toString()) * currentPriceBN) >> 192n;
            const token1Value = BigInt(token1Amount.toString());
            const totalValue = token0Value + token1Value;

            const poolId = `${pool.currency0.symbol}-${pool.currency1.symbol}-${pool.fee}`;

            this.valueTracking.set(poolId, {
                initialToken0Amount: BigInt(token0Amount.toString()),
                initialToken1Amount: BigInt(token1Amount.toString()),
                initialToken0Value: token0Value,
                initialToken1Value: token1Value,
                initialTotalValue: totalValue,
                currentToken0Amount: BigInt(token0Amount.toString()),
                currentToken1Amount: BigInt(token1Amount.toString()),
                currentToken0Value: token0Value,
                currentToken1Value: token1Value,
                currentTotalValue: totalValue,
                valueChangePercent: 0,
                timestamp: Date.now()
            });

            console.log(`记录初始价值: ${poolId}, 总价值=${totalValue}`);
        } catch (error) {
            console.error("记录初始价值时出错:", error);
        }
    }

    private async updateValueTracking(pool: Pool): Promise<void> {
        try {
            const poolId = `${pool.currency0.symbol}-${pool.currency1.symbol}-${pool.fee}`;
            const tracking = this.valueTracking.get(poolId);

            if (!tracking) {
                console.warn(`没有找到池子 ${poolId} 的初始价值记录`);
                return;
            }

            const token0Amount = await this.getTokenBalance(pool.currency0);
            const token1Amount = await this.getTokenBalance(pool.currency1);

            const currentSqrtRatioX96 = BigInt(pool.sqrtRatioX96.toString());
            const currentPriceBN = (currentSqrtRatioX96 * currentSqrtRatioX96) >> 192n;

            const token0Value = (token0Amount * currentPriceBN) >> 192n;
            const token1Value = token1Amount;
            const totalValue = token0Value + token1Value;

            const valueChange = Number(totalValue) - Number(tracking.initialTotalValue);
            const valueChangePercent = (valueChange / Number(tracking.initialTotalValue)) * 100;

            this.valueTracking.set(poolId, {
                ...tracking,
                currentToken0Amount: token0Amount,
                currentToken1Amount: token1Amount,
                currentToken0Value: token0Value,
                currentToken1Value: token1Value,
                currentTotalValue: totalValue,
                valueChangePercent,
                timestamp: Date.now()
            });

            console.log(`更新价值跟踪: ${poolId}, 初始=${tracking.initialTotalValue}, 当前=${totalValue}, 变化=${valueChangePercent.toFixed(2)}%`);
        } catch (error) {
            console.error("更新价值跟踪时出错:", error);
        }
    }

    public getValueTracking(poolId: string): ValueTracking | undefined {
        return this.valueTracking.get(poolId);
    }

    public async startMonitoring(): Promise<void> {
        if (this.monitorTask) {
            console.warn('监控任务已经在运行');
            return;
        }

        console.log(`开始监控，间隔=${this.config.monitorInterval}ms`);

        this.monitorTask = setInterval(async () => {
            try {
                for (const i of pos) {
                    await this.checkAndRebalancePosition(i);
                }
            } catch (error) {
                console.error("监控过程中出错:", error);
            }
        }, this.config.monitorInterval);
    }

    public async getState(poolInfo: posInfos): Promise<Position> {
        try {
            const stateView = await ethers.getContractAt("IStateView", "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2");
            const { sqrtPriceX96, tick } = await stateView.getSlot0(poolInfo.poolId);
            const poolLiquidity = await stateView.getLiquidity(poolInfo.poolId);
            const posLiquidity = await stateView.getPositionLiquidity(poolInfo.poolId, poolInfo.positionId);

            return new Position({
                pool: new Pool(
                    poolInfo.currencyA, // currencyA
                    poolInfo.currencyB, // currencyB
                    poolInfo.fee, // fee
                    poolInfo.tickSpacing, // tickSpacing
                    "", // hooks
                    sqrtPriceX96, // sqrtRatioX96
                    poolLiquidity, // liquidity
                    tick // tickCurrent
                ),
                tickLower: poolInfo.tickLower,
                tickUpper: poolInfo.tickUpper,
                liquidity: posLiquidity,
            })

        } catch (error) {
            console.error("获取池状态时出错:", error);
            throw error;
        }
    }

    private async checkAndRebalancePosition(pos: posInfos): Promise<void> {
        try {
            const position = await this.getState(pos);

            const currentTick = position.pool.tickCurrent;

            const isInRange = currentTick >= position.tickLower && currentTick <= position.tickUpper;

            const centerTick = (position.tickUpper + position.tickLower) / 2;
            const deviation = Math.abs((currentTick - centerTick) / (position.tickUpper - position.tickLower) * 100);

            console.log(`头寸 ${pos.positionId}: 当前tick=${currentTick}, 范围=[${position.tickLower}, ${position.tickUpper}]`);
            console.log(`在范围内? ${isInRange}, 偏离中心=${deviation.toFixed(2)}%`);

            if (!isInRange || deviation > this.config.rebalanceThreshold) {
                console.log(`需要重新平衡头寸 ${pos.positionId}`);

                const recipient = await this.signer.getAddress();
                const useNative = position.pool.currency0.isNative ? position.pool.currency0 :
                    position.pool.currency1.isNative ? position.pool.currency1 : undefined;

                await this.rebalance(pos.tokenId, position.pool, position, recipient, useNative);
                console.log(`头寸 ${pos.positionId} 已重新平衡`);
            } else {
                console.log(`头寸 ${pos.positionId} 不需要重新平衡`);
            }
        } catch (error) {
            console.error(`检查头寸 ${pos.positionId} 时出错:`, error);
        }
    }

    public stopMonitoring(): void {
        if (this.monitorTask) {
            clearInterval(this.monitorTask);
            this.monitorTask = null;
            console.log('已停止监控');
        }
    }
}

async function example() {
    const [deployer] = await ethers.getSigners();

    const config: Partial<RebalancerConfig> = {
        swapRouterAddress: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3", nftPositionManagerAddress: "0x4529a01c7a0410167c5740c487a8de60232617bf", poolManagerAddress: "0x1f98400000000000000000000000000000000004", token0Balance: 10000000000000000000n, token1Balance: 1000000000n, tickRange: 200, rebalanceThreshold: 5, monitorInterval: 300000
    };

    const rebalancer = new UniswapV4Rebalancer(deployer, config);

    await rebalancer.startMonitoring();

    setTimeout(() => {
        rebalancer.stopMonitoring();
    }, 3600000);
}

// This is the Hardhat main function that will be executed when the script is run
async function main() {
    try {
        const provider = new ethers.providers.JsonRpcProvider('https://mainnet.unichain.org');
        const deployer = new ethers.Wallet(process.env.privateKey!, provider);
        console.log("Running with account:", deployer.address);

        // const config: Partial<RebalancerConfig> = {
        //     swapRouterAddress: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3", 
        //     nftPositionManagerAddress: "0x4529a01c7a0410167c5740c487a8de60232617bf", 
        //     poolManagerAddress: "0x1f98400000000000000000000000000000000004", 
        //     token0Balance: 10000000000000000000n, 
        //     token1Balance: 1000000000n, 
        //     tickRange: 200, 
        //     rebalanceThreshold: 5, 
        //     monitorInterval: 300000,
        //     slippageTolerance: new Percent(1, 100)
        // };

        // const rebalancer = new UniswapV4Rebalancer(deployer, config);
        // console.log("UniswapV4Rebalancer initialized successfully");

        // // Start monitoring
        // await rebalancer.startMonitoring();
        // console.log("Monitoring started. Press Ctrl+C to stop execution.");

        // // Keep the script running
        // await new Promise(resolve => {
        //     // Create a function that will be called when the process is terminated
        //     const handleTermination = () => {
        //         console.log("Stopping monitoring...");
        //         rebalancer.stopMonitoring();
        //         resolve(null);
        //     };

        //     // Register the function to be called on SIGINT (Ctrl+C)
        //     process.on('SIGINT', handleTermination);
        // });
    } catch (error) {
        console.error("Error in main function:", error);
        process.exit(1);
    }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });