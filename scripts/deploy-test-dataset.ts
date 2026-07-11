// Deploys a fresh throwaway ERC-721 (same shape as deploy-test-nft.ts) and mints N tokens to
// build a real dataset for the D5/M3.B `data.sample_verify` live proof - a CSV of mint records
// where most rows are genuine and a couple are planted with a wrong claimed owner (a fabricated
// dataset entry), to prove adversarial sampling can catch it. Never used past this session's
// live proof.
import "dotenv/config";
import { writeFileSync } from "node:fs";
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
const rowCount = Number(process.argv[3] ?? 15);
const outPath = process.argv[4] ?? "/tmp/claude-1000/-home-user-Desktop-myDesktop-Vidimus/eb61aacc-9a22-4a0a-9413-97801a7d65a3/scratchpad/dataset.csv";
if (!recipient) {
  console.error("Usage: tsx scripts/deploy-test-dataset.ts <recipient-address> [rowCount] [outCsvPath]");
  process.exit(1);
}

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MintBatchFixture {
    string public name = "Vidimus Data Fixture";
    string public symbol = "VDF";
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
    sources: { "MintBatchFixture.sol": { content: SOURCE } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error("solc compile errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const contract = output.contracts["MintBatchFixture.sol"]["MintBatchFixture"];
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}` };
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
  if (balance === 0n) throw new Error("Facilitator wallet has no OKB - fund it before deploying.");

  console.log("Deploying MintBatchFixture...");
  const deployTxHash = await walletClient.deployContract({ abi, bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
  console.log(`Deployed at ${receipt.contractAddress} (tx ${deployTxHash})`);

  // Plant a couple of fabricated rows (real tx, WRONG claimed owner) - simulates a seller
  // padding a dataset with fake ground-truth to see if unpredictable sampling catches it.
  const plantedBadIndices = new Set([3, 9]);
  const fakeOwner = "0x000000000000000000000000000000000000dead";

  const rows: { tokenId: number; owner: string; mintTx: string }[] = [];
  for (let tokenId = 1; tokenId <= rowCount; tokenId++) {
    console.log(`Minting tokenId ${tokenId}...`);
    const mintTx = await walletClient.writeContract({
      address: receipt.contractAddress,
      abi,
      functionName: "mint",
      args: [recipient, BigInt(tokenId)],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });
    const claimedOwner = plantedBadIndices.has(tokenId - 1) ? fakeOwner : recipient;
    rows.push({ tokenId, owner: claimedOwner, mintTx });
  }

  const csv = ["tokenId,owner,mintTx", ...rows.map((r) => `${r.tokenId},${r.owner},${r.mintTx}`)].join("\n") + "\n";
  writeFileSync(outPath, csv, "utf8");

  console.log(`\nContract: ${receipt.contractAddress}`);
  console.log(`Rows: ${rows.length}, planted-wrong-owner tokenIds: ${[...plantedBadIndices].map((i) => i + 1).join(", ")}`);
  console.log(`Dataset written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
