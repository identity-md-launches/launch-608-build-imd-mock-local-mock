// Minimal secp256k1: public keys, RFC 6979 deterministic signing and public
// key recovery. Plain BigInt arithmetic, not constant time. This is fine for
// a mock that only ever holds published test keys; never use it with a key
// that guards real funds.
import { createHmac } from "node:crypto";
import { bigIntToBytes, bytesToBigInt, bytesToHex, concatBytes, hexToBytes, toChecksumAddress } from "./hex.js";
import { keccak256 } from "./keccak.js";
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
function mod(a, m) {
    const r = a % m;
    return r >= 0n ? r : r + m;
}
function modPow(base, exp, m) {
    let result = 1n;
    base = mod(base, m);
    while (exp > 0n) {
        if (exp & 1n)
            result = (result * base) % m;
        base = (base * base) % m;
        exp >>= 1n;
    }
    return result;
}
function modInv(a, m) {
    // Fermat inversion; both moduli are prime.
    return modPow(a, m - 2n, m);
}
const INFINITY = { x: 0n, y: 1n, z: 0n };
function toJacobian(p) {
    return p === null ? INFINITY : { x: p.x, y: p.y, z: 1n };
}
function fromJacobian(p) {
    if (p.z === 0n)
        return null;
    const zInv = modInv(p.z, P);
    const zInv2 = (zInv * zInv) % P;
    return { x: (p.x * zInv2) % P, y: (p.y * zInv2 * zInv) % P };
}
function double(p) {
    if (p.z === 0n || p.y === 0n)
        return INFINITY;
    const ysq = (p.y * p.y) % P;
    const s = (4n * p.x * ysq) % P;
    const m = (3n * p.x * p.x) % P;
    const x = mod(m * m - 2n * s, P);
    const y = mod(m * (s - x) - 8n * ysq * ysq, P);
    const z = (2n * p.y * p.z) % P;
    return { x, y, z };
}
function add(p, q) {
    if (p.z === 0n)
        return q;
    if (q.z === 0n)
        return p;
    const pz2 = (p.z * p.z) % P;
    const qz2 = (q.z * q.z) % P;
    const u1 = (p.x * qz2) % P;
    const u2 = (q.x * pz2) % P;
    const s1 = (p.y * qz2 * q.z) % P;
    const s2 = (q.y * pz2 * p.z) % P;
    if (u1 === u2)
        return s1 === s2 ? double(p) : INFINITY;
    const h = mod(u2 - u1, P);
    const r = mod(s2 - s1, P);
    const h2 = (h * h) % P;
    const h3 = (h2 * h) % P;
    const u1h2 = (u1 * h2) % P;
    const x = mod(r * r - h3 - 2n * u1h2, P);
    const y = mod(r * (u1h2 - x) - s1 * h3, P);
    const z = (h * p.z * q.z) % P;
    return { x, y, z };
}
function multiply(p, k) {
    let result = INFINITY;
    let addend = toJacobian(p);
    while (k > 0n) {
        if (k & 1n)
            result = add(result, addend);
        addend = double(addend);
        k >>= 1n;
    }
    return result;
}
const G = { x: GX, y: GY };
function parsePrivateKey(privateKey) {
    const d = bytesToBigInt(hexToBytes(privateKey));
    if (d <= 0n || d >= N)
        throw new Error("private key out of range");
    return d;
}
/** Uncompressed public key without the 0x04 prefix, 64 bytes. */
function publicKeyBytes(point) {
    if (point === null)
        throw new Error("point at infinity");
    return concatBytes(bigIntToBytes(point.x), bigIntToBytes(point.y));
}
function addressFromPoint(point) {
    const hash = keccak256(publicKeyBytes(point));
    return toChecksumAddress(bytesToHex(hash.slice(12)));
}
export function privateKeyToAddress(privateKey) {
    return addressFromPoint(fromJacobian(multiply(G, parsePrivateKey(privateKey))));
}
function hmac(key, ...data) {
    const h = createHmac("sha256", key);
    for (const d of data)
        h.update(d);
    return new Uint8Array(h.digest());
}
/** RFC 6979 nonce generation for HMAC-SHA256 and a 32-byte hash. */
function* rfc6979(privateKey, hash) {
    const x = bigIntToBytes(privateKey);
    const h = bigIntToBytes(mod(bytesToBigInt(hash), N));
    let v = new Uint8Array(32).fill(1);
    let k = new Uint8Array(32).fill(0);
    k = hmac(k, v, Uint8Array.of(0), x, h);
    v = hmac(k, v);
    k = hmac(k, v, Uint8Array.of(1), x, h);
    v = hmac(k, v);
    for (;;) {
        v = hmac(k, v);
        const candidate = bytesToBigInt(v);
        if (candidate > 0n && candidate < N)
            yield candidate;
        k = hmac(k, v, Uint8Array.of(0));
        v = hmac(k, v);
    }
}
/**
 * Sign a 32-byte digest. Returns the 65-byte Ethereum signature r || s || v
 * with low s and v in {27, 28}.
 */
export function signHash(hash, privateKey) {
    if (hash.length !== 32)
        throw new Error("hash must be 32 bytes");
    const d = parsePrivateKey(privateKey);
    const e = bytesToBigInt(hash);
    for (const k of rfc6979(d, hash)) {
        const r1 = fromJacobian(multiply(G, k));
        if (r1 === null)
            continue;
        const r = r1.x % N;
        if (r === 0n)
            continue;
        let s = (modInv(k, N) * (e + r * d)) % N;
        if (s === 0n)
            continue;
        let recovery = Number(r1.y & 1n) | (r1.x >= N ? 2 : 0);
        if (s > N / 2n) {
            s = N - s;
            recovery ^= 1;
        }
        if (recovery > 1)
            continue; // not representable as an Ethereum v
        return bytesToHex(concatBytes(bigIntToBytes(r), bigIntToBytes(s), Uint8Array.of(27 + recovery)));
    }
    throw new Error("unreachable");
}
/**
 * Recover the signer address of a 65-byte signature over a 32-byte digest.
 * Accepts v as 0/1 or 27/28. Throws on any malformed or invalid signature.
 */
export function recoverAddress(hash, signature) {
    if (hash.length !== 32)
        throw new Error("hash must be 32 bytes");
    const sig = hexToBytes(signature);
    if (sig.length !== 65)
        throw new Error("signature must be 65 bytes");
    const r = bytesToBigInt(sig.slice(0, 32));
    const s = bytesToBigInt(sig.slice(32, 64));
    let v = sig[64];
    if (v >= 27)
        v -= 27;
    if (v !== 0 && v !== 1)
        throw new Error("invalid signature v");
    if (r <= 0n || r >= N || s <= 0n || s >= N)
        throw new Error("invalid signature r or s");
    const x = r;
    const alpha = mod(x * x * x + 7n, P);
    let y = modPow(alpha, (P + 1n) / 4n, P);
    if ((y * y) % P !== alpha)
        throw new Error("invalid signature: r is not on the curve");
    if (Number(y & 1n) !== v)
        y = P - y;
    const R = { x, y };
    const e = bytesToBigInt(hash);
    const rInv = modInv(r, N);
    const u1 = mod(-e * rInv, N);
    const u2 = (s * rInv) % N;
    const Q = fromJacobian(add(multiply(G, u1), multiply(R, u2)));
    if (Q === null)
        throw new Error("invalid signature: recovered infinity");
    return addressFromPoint(Q);
}
