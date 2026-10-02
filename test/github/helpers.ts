import { gitFileResponse } from '../git-fixtures';
export const REPOSITORY = 'owner/project';
export const INSTALLATION_TOKEN = 'installation-token';
export const FILE_PATH = 'src/app.ts';
export const FILE_SHA = 'b'.repeat(40);
export const FILE_CONTENT = 'Bonjour 👋\ncafé ☕ — accents : éàü\n';
export type RecordedRequest = {
    url: string;
    init?: RequestInit;
};
export function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}
export function toBase64(value: string): string {
    return btoa(String.fromCodePoint(...new TextEncoder().encode(value)));
}
export function toPkcs8Pem(der: ArrayBuffer): string {
    const base64 = btoa(String.fromCodePoint(...new Uint8Array(der)));
    const lines = base64.match(/.{1,64}/g) ?? [];
    return [
        '-----BEGIN PRIVATE KEY-----',
        ...lines,
        '-----END PRIVATE KEY-----',
    ].join('\n');
}
export async function createPrivateKeyPem(): Promise<string> {
    const keyPair = await crypto.subtle.generateKey({
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
    }, true, ['sign', 'verify']);
    if (!('privateKey' in keyPair)) {
        throw new Error('Paire de clés RSA attendue.');
    }
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    if (!(pkcs8 instanceof ArrayBuffer)) {
        throw new Error('Export PKCS#8 attendu.');
    }
    return toPkcs8Pem(pkcs8);
}
export function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}
export async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    }
    catch (error) {
        return error as Error;
    }
    throw new Error('Rejet attendu.');
}
export function createFetchStub(payload: Record<string, unknown>): {
    fetcher: typeof fetch;
    requests: RecordedRequest[];
} {
    const requests: RecordedRequest[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const url = requestUrl(input);
        requests.push({ url, init });
        if (url.endsWith('/access_tokens')) {
            return jsonResponse({ token: INSTALLATION_TOKEN });
        }
        const file = gitFileResponse(url, payload as Parameters<typeof gitFileResponse>[1]);
        if (file)
            return file;
        return new Response('Not Found', { status: 404 });
    };
    return { fetcher, requests };
}
