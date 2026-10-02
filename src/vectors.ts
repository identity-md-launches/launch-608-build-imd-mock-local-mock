// Deterministic test vectors: one complete paid submit, computed with the
// fixed clock, keys and nonce from fixtures.ts. Committed as
// fixtures/vectors.json so clients in any language can compare their
// typed-data hashes, paymentHash and signatures byte for byte.

import { encodeType, hashTypedDataHex } from "./crypto/eip712.js";
import { signPayment } from "./client.js";
import {
  FIXED_NONCE,
  FIXED_NOW_MS,
  FIXED_REQUEST_KEY,
  MOCK_PAY_TO,
  TEST_BEARER_TOKEN,
  TEST_PAYER_ADDRESS,
  TEST_PAYER_KEY,
} from "./fixtures.js";
import {
  PERMIT2_TYPES,
  QUOTE_APPROVAL_TYPES,
  canonicalJson,
  permit2TypedData,
  quoteApprovalTypedData,
  sha256Hex,
  type PaymentChallenge,
} from "./protocol.js";
import { MockState } from "./server.js";

export const VECTORS_PUBLIC_URL = "http://127.0.0.1:8402";

export function buildVectors() {
  const state = new MockState({ now: () => FIXED_NOW_MS, publicUrl: VECTORS_PUBLIC_URL });
  const scope = sha256Hex(TEST_BEARER_TOKEN);
  const input = { message: "hello imd-mock" };
  const { order } = state.quote(scope, { requestKey: FIXED_REQUEST_KEY, action: "echo", input }, VECTORS_PUBLIC_URL);
  const challenge = state.submit(scope, order.id, undefined, undefined).body as PaymentChallenge;
  const signed = signPayment(challenge, TEST_PAYER_KEY, { nonce: FIXED_NONCE });

  return {
    description:
      "One complete paid submit against imd-mock with a fixed clock. Every key here is public test data. Regenerate with `node dist/cli.js vectors`.",
    keys: {
      bearerToken: TEST_BEARER_TOKEN,
      requesterScopeHash: scope,
      payerPrivateKey: TEST_PAYER_KEY,
      payerAddress: TEST_PAYER_ADDRESS,
      mockPayTo: MOCK_PAY_TO,
    },
    nowMs: FIXED_NOW_MS,
    quoteRequest: { requestKey: FIXED_REQUEST_KEY, action: "echo", input },
    challenge,
    permit2: {
      encodedType: encodeType("PermitWitnessTransferFrom", PERMIT2_TYPES),
      typedData: permit2TypedData(signed.payment.payload.permit2Authorization),
      digest: hashTypedDataHex(permit2TypedData(signed.payment.payload.permit2Authorization)),
      signature: signed.payment.payload.signature,
    },
    payment: signed.payment,
    paymentCanonicalJson: canonicalJson(signed.payment),
    paymentSignatureHeader: signed.paymentHeader,
    quoteApproval: {
      encodedType: encodeType("QuoteApproval", QUOTE_APPROVAL_TYPES),
      typedData: quoteApprovalTypedData(signed.approval),
      digest: hashTypedDataHex(quoteApprovalTypedData(signed.approval)),
      signature: signed.quoteSignature,
    },
    submitBody: { quoteSignature: signed.quoteSignature },
  };
}
