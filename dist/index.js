// Library entry: start the mock in-process, or reuse its client and signing code.
export { createMockServer, startMock, MockState } from "./server.js";
export { ImdClient, signPayment, signAuthorization, checkChallenge } from "./client.js";
export { runConformance, CHECKS } from "./conformance.js";
export { verifyPaidSubmit } from "./verify.js";
export { ACTIONS, REFUSE_MARKER } from "./actions.js";
export * from "./protocol.js";
export * from "./fixtures.js";
export { hashTypedData, hashTypedDataHex, signTypedData, recoverTypedDataAddress } from "./crypto/eip712.js";
export { privateKeyToAddress } from "./crypto/secp256k1.js";
