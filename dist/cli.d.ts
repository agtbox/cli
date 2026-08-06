export declare class CliError extends Error {
    readonly code: string;
    readonly exitCode: number;
    constructor(code: string, message: string, exitCode?: number);
}
export declare function shouldDiscardPaymentRecovery(error: unknown): boolean;
export declare function assertCiphertextSize(ciphertext: Uint8Array): void;
export declare function main(args: string[]): Promise<unknown>;
export declare function run(args: string[]): Promise<number>;
