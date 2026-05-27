# @hjdhjd/myq — refresh-token-only fork

Fork of [hjdhjd/myq](https://github.com/hjdhjd/myq) (a modern myQ v6 API library for Liftmaster / Chamberlain devices) adapted for the **post-AppCheck era**.

## Why this fork exists

In late 2023 Chamberlain wrapped the `authorization_code` grant on `partner-identity.myq-cloud.com` behind **Firebase App Check** (Play Integrity on Android, App Attest on iOS). The original email-and-password login flow used by hjdhjd's library — and by every other community library — broke at that point. The library's author retired the project shortly after.

The `refresh_token` grant on the same endpoint remained open. This fork:

- Switches the OAuth client identity to **`IOS_CGI_MYQ`** (Chamberlain's iOS app's confidential client).
- Replaces `login(email, password)` with `login(refreshToken)`.
- Skips the PKCE / browser-form / authorization_code dance entirely. Every call to `/connect/token` is a refresh-grant request, which Chamberlain does **not** AppCheck-gate.

The result: once a user has a valid refresh_token from a real attested device (their phone), this library can refresh it indefinitely from any server. Tokens are rotated by the server on every refresh; the library persists the new one for the caller.

## What still needs to come from a real device

**One time, per residential myQ account.** The first refresh_token has to be minted by the official myQ app on real Apple- or Google-attested hardware. After that, this library does not need a phone ever again.

How to extract a refresh_token from your own myQ account is out of scope for this README. See [`homebridge-myq`](https://github.com/rfiorentino1/homebridge-myq) for the consumer-facing plugin; future versions of the plugin will embed the capture flow directly so users don't have to do it manually.

## API

```ts
import { myQApi } from "@hjdhjd/myq";

const api = new myQApi(/* optional logger */);
await api.login("YOUR_REFRESH_TOKEN_HEX");
await api.refreshDevices();
console.log(api.devices);

// Open the first garage door
await api.execute(api.devices[0], "open");
```

Same public surface as the upstream library, minus the no-longer-functional email/password fields. See [upstream docs](https://github.com/hjdhjd/myq) for `getDevice`, `getDeviceName`, `getHwInfo`, `execute`, etc. — those are unchanged.

## Install

```bash
npm install github:rfiorentino1/myq
```

Pre-built `dist/` is committed to the repo so installs do not require TypeScript compilation on the target machine.

## Credit

All of the v6 API decoding, device-type fingerprinting, MQTT support, and overall architecture is hjdhjd's work — see the original [hjdhjd/myq](https://github.com/hjdhjd/myq) repository. This fork is a minimal surgical patch on top, made necessary by Chamberlain's post-2023 hostility to third-party clients.

## License

ISC, per upstream.
