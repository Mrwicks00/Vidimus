// Deploys a minimal ERC-20 with a public mint() faucet, for the D1 round-trip test only.
// Anyone can mint - this is a throwaway testnet token, never used past D1.
import "dotenv/config";
import solc from "solc";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Deliberately reads env directly (not src/config.ts) - this script's job is to produce
// PAYMENT_TOKEN_ADDRESS, so config.ts's strict requirement on that var doesn't apply yet.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
const rpcUrl = required("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 1952);
const facilitatorPrivateKey = required("FACILITATOR_PRIVATE_KEY") as `0x${string}`;

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestUSDT {
    string public name = "Vidimus Test USDT";
    string public symbol = "vUSDT";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

function compile() {
  const input = {
    language: "Solidity",
    sources: { "TestUSDT.sol": { content: SOURCE } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("solc compile errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const contract = output.contracts["TestUSDT.sol"]["TestUSDT"];
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}`,
  };
}

async function main() {
  const { abi, bytecode } = compile();

  const account = privateKeyToAccount(facilitatorPrivateKey);
  const chain = {
    id: chainId,
    name: `x-layer-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Facilitator ${account.address} balance: ${balance} wei OKB`);
  if (balance === 0n) {
    throw new Error("Facilitator wallet has no OKB - fund it before deploying.");
  }

  console.log("Deploying TestUSDT...");
  const deployTxHash = await walletClient.deployContract({ abi, bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
  console.log(`Deployed at ${receipt.contractAddress} (tx ${deployTxHash})`);

  const testBuyerKey = process.env.TEST_BUYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (testBuyerKey) {
    const buyer = privateKeyToAccount(testBuyerKey);
    const mintAmount = 10_000_000n; // 10 vUSDT at 6 decimals - plenty for repeated 0.01 payments
    console.log(`Minting ${mintAmount} atomic units to test buyer ${buyer.address}...`);
    const mintTx = await walletClient.writeContract({
      address: receipt.contractAddress,
      abi,
      functionName: "mint",
      args: [buyer.address, mintAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    console.log("Mint confirmed.");
  } else {
    console.log("Set TEST_BUYER_PRIVATE_KEY to also mint test tokens to the buyer wallet.");
  }

  console.log(`\nSet PAYMENT_TOKEN_ADDRESS=${receipt.contractAddress} in .env`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
