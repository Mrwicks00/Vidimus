import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function makeWallet(label: string) {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`\n${label}`);
  console.log(`  address:     ${account.address}`);
  console.log(`  private key: ${privateKey}`);
}

console.log("Generating a facilitator wallet (settlement key - pays gas, submits Permit2");
console.log("transfers) and a separate test-buyer wallet (simulates the paying agent).");
console.log("Fund the FACILITATOR address with testnet OKB before continuing D1.");

makeWallet("Facilitator");
makeWallet("Test buyer");

console.log("\nCopy the facilitator private key into .env as FACILITATOR_PRIVATE_KEY,");
console.log("and its address into PAY_TO_ADDRESS. Keep the test-buyer key for scripts/test-buyer.ts");
console.log("(pass it via TEST_BUYER_PRIVATE_KEY env var when running that script - do not commit it).");
