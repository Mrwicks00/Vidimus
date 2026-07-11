// Deploys a minimal ERC-721 and mints tokenId 1 to a recipient, for the D3 onchain-verifier
// live proof only. Anyone can mint - this is a throwaway testnet NFT, never used past D3.
import "dotenv/config";
import solc from "solc";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
const rpcUrl = required("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 1952);
const facilitatorPrivateKey = required("FACILITATOR_PRIVATE_KEY") as `0x${string}`;

const recipient = process.argv[2];
if (!recipient) {
  console.error("Usage: tsx scripts/deploy-test-nft.ts <recipient-address>");
  process.exit(1);
}

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SunsetRiders {
    string public name = "Sunset Riders";
    string public symbol = "SNRD";
    mapping(uint256 => address) public ownerOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == address(0), "already minted");
        ownerOf[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }
}
`;

function compile() {
  const input = {
    language: "Solidity",
    sources: { "SunsetRiders.sol": { content: SOURCE } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("solc compile errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const contract = output.contracts["SunsetRiders.sol"]["SunsetRiders"];
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

  console.log("Deploying SunsetRiders (ERC-721-shaped, mint-only)...");
  const deployTxHash = await walletClient.deployContract({ abi, bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
  console.log(`Deployed at ${receipt.contractAddress} (tx ${deployTxHash})`);

  console.log(`Minting tokenId 1 to ${recipient}...`);
  const mintTx = await walletClient.writeContract({
    address: receipt.contractAddress,
    abi,
    functionName: "mint",
    args: [recipient, 1n],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });

  console.log(`\nContract:  ${receipt.contractAddress}`);
  console.log(`Mint tx:   ${mintTx}`);
  console.log(`TokenId:   1`);
  console.log(`Owner:     ${recipient}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
