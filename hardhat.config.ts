import "@nomicfoundation/hardhat-toolbox"
import "dotenv/config"
// import { HardhatUserConfig } from "hardhat/config"
// import "hardhat-abi-exporter"
// import "hardhat-contract-sizer"
// import * as tdly from "@tenderly/hardhat-tenderly"
// tdly.setup({ automaticVerifications: false })

const config = {
  solidity: {
    version: "0.8.24",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: false,
        // runs: 2,
      },
      evmVersion: "cancun",
    },
  },
  abiExporter: {
    path: `./abis`,
    runOnCompile: true,
    clear: true,
    flat: true,
    spacing: 2,
    format: "json",
  },
  contractSizer: {
    runOnCompile: false,
    only: [],
  },
  networks: {
    server: {
      url: "https://rpc.0xdefi.club",
      mining: {
        mempool: {
          order: "fifo",
        },
      },
      chainId: 31338,
    },
    sepolia:{
      chainId: 11155111,
      url: "https://eth-sepolia.g.alchemy.com/v2/Jbkri9q6ihizYHOsCHzelIFlt4kudVz_",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
    },
    blastTest: {
      chainId: 168587773,
      url: "https://sepolia.blast.io",
      gasPrice: "auto",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
    },
    baseTest: {
      chainId: 84532,
      url: "https://base-sepolia.g.alchemy.com/v2/Jbkri9q6ihizYHOsCHzelIFlt4kudVz_",
      gasPrice: "auto",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
    },
    arbiTest: {
      url: "https://arb-sepolia.g.alchemy.com/v2/XRMFFX660kU3ydk6ocj1J3LptLFeX9vw",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 421614,
      gasPrice: "auto",
    },
    blast: {
      url: "https://blast-mainnet.g.alchemy.com/v2/oxnbCaZoaUoAbf0CB693dYjGzst0hBKM",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 81457,
    },
    taiko: {
      url: "https://rpc.ankr.com/taiko",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 167000,
    },
    base: {
      url: "https://base-mainnet.g.alchemy.com/v2/oxnbCaZoaUoAbf0CB693dYjGzst0hBKM",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 8453,
    },
    arbi: {
      url: "https://arb-mainnet.g.alchemy.com/v2/XRMFFX660kU3ydk6ocj1J3LptLFeX9vw",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 42161,
    },
    bera: {
      url: "https://practical-cold-asphalt.bera-mainnet.quiknode.pro/45425d698248bdda43ca70660c5b725ac274a0b6/",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 80094,
    },
    monad: {
      url: "https://tiniest-special-sponge.monad-testnet.quiknode.pro/264621abc78b9a64d2445cd1551be1ab1c17eeac/",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 10143,
    }, 
    uniChain: {
      url: "https://mainnet.unichain.org",
      accounts: process.env.privateKey ? [process.env.privateKey] : [],
      chainId: 130,
    }, 
  },
}

export default config
