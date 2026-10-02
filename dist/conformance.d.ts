import { ImdClient, type Capabilities } from "./client.js";
import { type Hex } from "./crypto/hex.js";
export interface CheckResult {
    name: string;
    ok: boolean;
    error?: string;
}
interface Context {
    client: ImdClient;
    baseUrl: string;
    privateKey: Hex;
    capabilities?: Capabilities;
}
export declare const CHECKS: Array<{
    name: string;
    run(ctx: Context): Promise<void>;
}>;
export declare function runConformance(baseUrl: string, { privateKey, write }?: {
    privateKey?: `0x${string}` | undefined;
    write?: ((line: string) => void) | undefined;
}): Promise<{
    passed: number;
    failed: number;
    results: CheckResult[];
}>;
export {};
