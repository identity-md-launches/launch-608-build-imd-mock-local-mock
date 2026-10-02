// Library entry: start the mock in-process, or reuse its client and signing code.
export { createMockServer, startMock, MockState, HttpError, type MockOptions } from "./server.js";
export {
  ImdClient,
  signPayment,
  signAuthorization,
  signQuoteApproval,
  checkChallenge,
  type Capabilities,
  type ActionCapability,
  type SignedPayment,
} from "./client.js";
export { runConformance, CHECKS } from "./conformance.js";
export { verifyPaidSubmit, type VerifyResult } from "./verify.js";
export { ACTIONS, ACTION_NAMES, REFUSE_MARKER, STALE_MARKER, type ActionSpec } from "./actions.js";
export * from "./protocol.js";
export * from "./fixtures.js";
export { hashTypedData, hashTypedDataHex, signTypedData, recoverTypedDataAddress, type TypedData } from "./crypto/eip712.js";
export { privateKeyToAddress } from "./crypto/secp256k1.js";
