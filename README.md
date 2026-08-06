# Agentbox CLI

`@agtbox/cli` is the agent-oriented command-line and JavaScript client for encrypted, capability-based Agentbox handoffs. Version `0.1.x` supports Node.js 22 or newer and Bun 1.3 or newer. The package has no install lifecycle scripts.

The package is published at [npmjs.com/package/@agtbox/cli](https://www.npmjs.com/package/@agtbox/cli). Install it inertly with `npm install --ignore-scripts @agtbox/cli` or `bun add --ignore-scripts @agtbox/cli`. Pin an explicit compatible version and review its changelog before replacing the lockfile entry.

## Machine contract

Every command writes exactly one JSON object plus a newline to stdout on success. Operational failures write one JSON error object to stderr and exit `1`; usage failures exit `2`. Recovery events are newline-delimited JSON on stderr. Keep the streams separate.

The executable is `agentbox`. Use `agentbox --version --json` to obtain package identity. Supported commands are:

```text
agentbox identity generate --identity-file PATH
agentbox identity import --identity-file PATH
agentbox encrypt --input PATH_OR_- --recipient-file PATH --output PATH
agentbox decrypt --input PATH_OR_- --sha256 HEX --identity-file PATH --output PATH
agentbox send --endpoint HTTPS_URL --input PATH --recipient-file PATH --payer-key-file PATH --capabilities-file PATH [--idempotency-key VALUE] [--ciphertext-file PATH] [--max-price-atomic VALUE]
agentbox inspect --endpoint HTTPS_URL --box-id VALUE --read-capability-file PATH
agentbox download --endpoint HTTPS_URL --box-id VALUE --read-capability-file PATH --sha256 HEX --output PATH
agentbox receive --endpoint HTTPS_URL --box-id VALUE --read-capability-file PATH --identity-file PATH --output PATH
agentbox delete --endpoint HTTPS_URL --box-id VALUE --delete-capability-file PATH
```

`AGENTBOX_ENDPOINT`, `AGENTBOX_IDEMPOTENCY_KEY`, and `AGENTBOX_MAX_PRICE_ATOMIC` may provide their corresponding non-secret options. Private identities, payer keys, payment authorizations, and capabilities are accepted only through protected regular files and never through command arguments or normal stdout. `encrypt` and `decrypt` accept `-` for stdin. Paid `send` requires a stable file input so an identical retry remains possible.

Output files are create-only, mode `0600`, and never replace existing files or symbolic links. A paid send keeps its ciphertext and a protected adjacent payment-recovery file until the result becomes definitive. Reuse the same endpoint, input, ciphertext, idempotency key, payer, and price ceiling after an ambiguous failure; never create a second authorization for a changed request.

The JavaScript export provides the encryption, commitment, create/upload, inspect, download/verify, delete, and CLI functions. Its HTTP behavior follows the production OpenAPI contract for the same release. A contract-breaking HTTP change requires a CLI major version; additive compatible fields require a minor version, and fixes that preserve the public contract use a patch version. The client rejects non-HTTPS endpoints, cross-origin capability URLs, incompatible payment challenges, oversized responses, and ciphertext integrity mismatches.

## Security

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). Do not paste secret files or payment/capability values into a report.

## Contributing

Open a GitHub Issue for bugs or feature requests. Pull requests are not accepted; this project is maintained by its project team.

## License

Source-available under the [PolyForm Shield License 1.0.0](LICENSE). This is not an OSI-approved open-source license.
