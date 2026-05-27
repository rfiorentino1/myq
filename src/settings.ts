/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.ts: Settings and constants for myq.
 *
 * Forked 2026: refresh-token-only auth using iOS client identity. The myQ API
 * gates authorization_code grants behind Firebase App Check (Play Integrity on
 * Android / App Attest on iOS); the refresh-token grant remains open. Users
 * obtain a refresh_token via one-time extraction from the official myQ app and
 * paste it into Homebridge config.
 */

// myQ OAuth client identifier (iOS).
export const MYQ_API_CLIENT_ID = "IOS_CGI_MYQ";

// myQ OAuth client secret (shared across iOS + Android mobile clients).
export const MYQ_API_CLIENT_SECRET = "VUQ0RFhuS3lQV3EyNUJTdw==";

// myQ OAuth redirect URI (iOS).
export const MYQ_API_REDIRECT_URI = "com.myqops://ios";

// myQ OAuth scope.
export const MYQ_API_SCOPE = "MyQ_Residential offline_access";

// myQ application identifier.
export const MYQ_APP_ID = "D9D7B25035D549D8A3EA16A9FFB8C927D4A19B55B8944011B2670A8321BF8312";

// myQ user agent (iOS app).
export const MYQ_APP_USER_AGENT = "myQ/310.0.63387 CFNetwork/3860.600.12 Darwin/25.5.0";

// myQ login user agent (unused in refresh-token-only flow; kept for completeness).
export const MYQ_LOGIN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// myQ application version (iOS).
export const MYQ_APP_VERSION = "5.310.0.63387";
