import { type PaymentChallenge } from "./protocol.js";
export declare const VECTORS_PUBLIC_URL = "http://127.0.0.1:8402";
export declare function buildVectors(): {
    description: string;
    keys: {
        bearerToken: string;
        requesterScopeHash: string;
        payerPrivateKey: `0x${string}`;
        payerAddress: `0x${string}`;
        mockPayTo: `0x${string}`;
    };
    nowMs: number;
    quoteRequest: {
        requestKey: string;
        action: string;
        input: {
            objective: string;
            skill: string;
            outputs: {
                name: string;
                path: string;
                mediaType: string;
            }[];
            minCitations: number;
            github: boolean;
        };
    };
    challenge: PaymentChallenge;
    permit2: {
        encodedType: string;
        typedData: import("./crypto/eip712.js").TypedData;
        digest: `0x${string}`;
        signature: string;
    };
    payment: import("./protocol.js").PaymentPayload;
    paymentCanonicalJson: string;
    paymentSignatureHeader: string;
    quoteApproval: {
        encodedType: string;
        typedData: import("./crypto/eip712.js").TypedData;
        digest: `0x${string}`;
        signature: `0x${string}`;
    };
    submitBody: {
        quoteSignature: `0x${string}`;
    };
};
