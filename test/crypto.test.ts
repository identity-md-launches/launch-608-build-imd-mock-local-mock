// Known-answer tests for the in-house crypto. The EIP-712 case is the "Ether
// Mail" example from the EIP itself; fixtures/vectors.json was cross-checked
// against viem 2.x when it was generated.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hashTypedDataHex, recoverTypedDataAddress, signTypedData, type TypedData } from "../src/crypto/eip712.js";
import { bytesToHex, type Hex } from "../src/crypto/hex.js";
import { keccak256 } from "../src/crypto/keccak.js";
import { privateKeyToAddress, recoverAddress, signHash } from "../src/crypto/secp256k1.js";
import { buildVectors } from "../src/vectors.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

test("keccak256 known answers", () => {
  assert.equal(bytesToHex(keccak256(new Uint8Array())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(bytesToHex(keccak256(utf8("abc"))), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // Lengths around the 136-byte rate boundary.
  for (const n of [135, 136, 137]) assert.equal(keccak256(new Uint8Array(n)).length, 32);
});

test("private key 1 maps to the well-known address", () => {
  assert.equal(privateKeyToAddress(`0x${"0".repeat(63)}1`), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
});

test("signHash is deterministic, low-s, and recovers to the signer", () => {
  const key: Hex = bytesToHex(keccak256(utf8("some key")));
  const hash = keccak256(utf8("some message"));
  const sig = signHash(hash, key);
  assert.equal(sig, signHash(hash, key));
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  assert.ok(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n);
  assert.equal(recoverAddress(hash, sig), privateKeyToAddress(key));
});

const MAIL: TypedData = {
  domain: { name: "Ether Mail", version: "1", chainId: 1, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
  types: {
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

test("EIP-712 Ether Mail example from the spec", () => {
  assert.equal(hashTypedDataHex(MAIL), "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
  const cowKey = bytesToHex(keccak256(utf8("cow")));
  const sig = signTypedData(MAIL, cowKey);
  assert.equal(
    sig,
    "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c",
  );
  assert.equal(recoverTypedDataAddress(MAIL, sig), "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826");
});

test("fixtures/vectors.json is what the code produces", () => {
  const committed = JSON.parse(readFileSync(new URL("../../fixtures/vectors.json", import.meta.url), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(buildVectors())), committed);
});

test("vector signatures recover to the test payer", () => {
  const v = buildVectors();
  assert.equal(recoverTypedDataAddress(v.permit2.typedData, v.permit2.signature), v.keys.payerAddress);
  assert.equal(recoverTypedDataAddress(v.quoteApproval.typedData, v.quoteApproval.signature), v.keys.payerAddress);
  assert.equal(
    v.permit2.encodedType,
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)",
  );
});
