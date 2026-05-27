/* Copyright(C) 2017-2023, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * myq-api.ts: Our modern myQ v6 API implementation.
 */
import { FetchError, Headers, context } from "@adobe/fetch";
import { MYQ_API_CLIENT_ID, MYQ_API_CLIENT_SECRET, MYQ_API_REDIRECT_URI, MYQ_API_SCOPE, MYQ_APP_ID, MYQ_APP_USER_AGENT, MYQ_APP_VERSION, MYQ_LOGIN_USER_AGENT } from "./settings.js";
import http from "node:http";
import { parse } from "node-html-parser";
import util from "node:util";
/*
 * The myQ API is undocumented, non-public, and has been derived largely through reverse engineering the official app, myQ website, and trial and error.
 *
 * This project stands on the shoulders of the other myQ projects out there that have done much of the heavy lifting of decoding the API.
 *
 * Starting with v6 of the myQ API, myQ now uses OAuth 2.0 + PKCE to authenticate users and provide access tokens for future API calls. In order to successfully use the
 * API, we need to first authenticate to the myQ API using OAuth, get the access token, and use that for future API calls.
 *
 * Additionally, as of October 2023, myQ seems to be taking more active steps to block attempts to use the API that are not very closely conforming to the usage and
 * API access pattern of the native myQ app. Among other things, there are now several limits in place to make API access and experimentation more difficult. Failed
 * login attempts when not completely conforming to what the API endpoints are looking for will now trigger an account lockout after three attempts within a 60 minute
 * period. Similarly, a 60 minute lockout will be triggered if you login successfully more than ten times within a 60 minute period. Why? To make it painful.
 *
 * For those familiar with prior versions of the API, v6 does not represent a substantial change outside of the shift in authentication type and slightly different
 * endpoint semantics. The largest non-authentication-related change relate to how commands are sent to the myQ API to execute actions such as opening and closing a
 * garage door, and even those changes are relatively minor.
 *
 * The myQ API is clearly evolving and will continue to do so. So what's good about v6 of the API? A few observations that will be explored with time and lots of
 * experimentation by the community:
 *
 *   - It seems possible to use guest accounts to now authenticate to myQ.
 *   - Cameras seem to be more directly supported.
 *   - Locks seem to be more directly supported.
 *   - myQ uses Firebase for notifications and it should be possible to use it for push notifications rather than polling as we do now. This will require a more
 *     intensive analysis to bring it all together.
 *   - There appears to be a MQTT interface, although how to access it is a bit of a question mark, and it's been quite some time since I've last looked at it.
 *
 * Overall, the workflow to using the myQ API should still feel familiar:
 *
 * 1. Login to the myQ API and acquire an OAuth access token.
 * 2. Enumerate the list of myQ devices, including gateways and openers. myQ devices like garage openers or lights are associated with gateways. While you can have
 *    multiple gateways in a home, a more typical setup would be one gateway per home, and one or more devices associated with that gateway.
 * 3. To check status of myQ devices, we periodically poll to get updates on specific devices.
 *
 * Those are the basics and gets us up and running. There are further API calls that allow us to open and close openers, lights, and other devices, as well as
 * periodically poll for status updates.
 *
 * That last part is key. Since there is no way that we know of to monitor status changes in real time, we have to resort to polling the myQ API regularly to see if
 * something has happened that we're interested in (e.g. a garage door opening or closing). It would be great if a monitor API existed to inform us when changes occur,
 * but alas, it either doesn't exist or hasn't been discovered yet.
 */
const myQRegions = ["", "east", "west"];
export class myQApi {
    devices;
    accessToken;
    refreshTimer;
    refreshToken;
    tokenScope;
    apiReturnStatus;
    email;
    password;
    accounts;
    headers;
    log;
    myqRetrieve;
    region;
    // Initialize this instance with our login information.
    constructor(log) {
        // If we didn't get passed a logging parameter, by default we log to the console.
        log = log ?? {
            /* eslint-disable no-console */
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            debug: (message, ...parameters) => { },
            error: (message, ...parameters) => console.error(util.format(message, ...parameters)),
            info: (message, ...parameters) => console.log(util.format(message, ...parameters)),
            warn: (message, ...parameters) => console.log(util.format(message, ...parameters))
            /* eslint-enable no-console */
        };
        this.accessToken = null;
        this.accounts = [];
        this.apiReturnStatus = 0;
        this.email = null;
        this.headers = new Headers();
        this.password = null;
        this.refreshTimer = null;
        this.refreshToken = "";
        this.region = 0;
        this.tokenScope = "";
        this.log = {
            debug: (message, ...parameters) => log?.debug("myQ API: " + message, ...parameters),
            error: (message, ...parameters) => log?.error("myQ API error: " + message, ...parameters),
            info: (message, ...parameters) => log?.info("myQ API: " + message, ...parameters),
            warn: (message, ...parameters) => log?.warn("myQ API: " + message, ...parameters)
        };
        // The myQ API v6 doesn't seem to require an HTTP user agent to be set - so we don't.
        const { fetch } = context({ alpnProtocols: ["h2" /* ALPNProtocol.ALPN_HTTP2 */], userAgent: "" });
        this.myqRetrieve = fetch;
    }
    // Initialize this instance with the user's refresh token (obtained from the official myQ app).
    //
    // The myQ API gates the authorization_code grant (initial password login) behind Firebase
    // App Check, which requires a real attested device. The refresh-token grant remains open
    // for any client. Users do a one-time extraction of their refresh_token from the official
    // myQ app on their phone and paste it here. The plugin then refreshes indefinitely.
    async login(refreshToken) {
        this.refreshToken = refreshToken;
        this.accessToken = null;
        return this.refreshDevices();
    }
    // Utility to emulate the native myQ app behavior during the login process.
    generateLoginHeaders(headers) {
        return Object.assign({
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": MYQ_LOGIN_USER_AGENT,
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "upgrade-insecure-requests": "1"
        }, headers);
    }
    // Utility to emulate the native myQ app behavior.
    generateApiHeaders(headers) {
        return Object.assign({
            "Accept-Encoding": "gzip",
            "App-Version": MYQ_APP_VERSION,
            "Authorization": this.accessToken,
            "BrandId": "1",
            "MyQApplicationId": MYQ_APP_ID,
            "User-Agent": MYQ_APP_USER_AGENT
        }, headers);
    }
    // Transmit the PKCE challenge and retrieve the myQ OAuth authorization page to prepare to login.
    async oauthGetAuthPage(codeChallenge) {
        const authEndpoint = new URL("https://partner-identity.myq-cloud.com/connect/authorize");
        // Set the authentication context class reference. We need to explicitly URI-encode this before setting the parameter, or the value won't be properly escaped.
        authEndpoint.searchParams.set("acr_values", encodeURIComponent("unified_flow:v1  brand:myq"));
        // Set the client identifier.
        authEndpoint.searchParams.set("client_id", MYQ_API_CLIENT_ID);
        // Set the PKCE code challenge.
        authEndpoint.searchParams.set("code_challenge", codeChallenge);
        // Set the PKCE code challenge method.
        authEndpoint.searchParams.set("code_challenge_method", "S256");
        // Set the prompt.
        authEndpoint.searchParams.set("prompt", "login");
        // Set the locale of the user interface.
        authEndpoint.searchParams.set("ui_locales", "en-US");
        // Set the redirect URI to the myQ app.
        authEndpoint.searchParams.set("redirect_uri", MYQ_API_REDIRECT_URI);
        // Set the response type.
        authEndpoint.searchParams.set("response_type", "code");
        // Set the scope.
        authEndpoint.searchParams.set("scope", MYQ_API_SCOPE);
        // Send the PKCE challenge and let's begin the login process.
        const response = await this.retrieve(authEndpoint.toString(), { headers: this.generateLoginHeaders(), redirect: "manual" });
        if (!response) {
            this.log.debug("Unable to access the OAuth authorization endpoint.");
            return null;
        }
        // If we don't have the full set of cookies we expect, something is wrong.
        if (!response.headers.raw()["set-cookie"] || response.headers.raw()["set-cookie"].length < 3) {
            this.log.error("myQ API login anomaly detected.");
            return null;
        }
        // Create a new URL based on the redirect.
        const redirectUrl = new URL(response.headers.get("location"), response.url);
        // Execute the redirect with the cookies that were provided by the myQ API when accessing the login URL.
        return this.retrieve(redirectUrl.toString(), { headers: this.generateLoginHeaders({ "Cookie": this.generateLoginCookies(response.headers) }) });
    }
    // Login to the myQ API, using the retrieved authorization page.
    async oauthLogin(authPage) {
        // Sanity check.
        if (!this.email || !this.password) {
            return null;
        }
        // Parse the myQ login page and grab what we need.
        const htmlText = await authPage.text();
        const loginPageHtml = parse(htmlText);
        const requestVerificationToken = loginPageHtml.querySelector("input[name=__RequestVerificationToken]")?.getAttribute("value");
        if (!requestVerificationToken) {
            this.log.error("Unable to complete login. The verification token could not be retrieved.");
            return null;
        }
        // Set the login info.
        const loginBody = new URLSearchParams({ "Email": this.email, "Password": this.password, "UnifiedFlowRequested": "True",
            "__RequestVerificationToken": requestVerificationToken, "brand": "myq" });
        // Login and we're done.
        const response = await this.retrieve(authPage.url, {
            body: loginBody.toString(),
            headers: this.generateLoginHeaders({
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": this.generateLoginCookies(authPage.headers),
                "cache-control": "max-age=0",
                "origin": "null",
                "sec-fetch-site": "same-origin",
                "sec-fetch-user": "?1"
            }),
            method: "POST",
            redirect: "manual"
        });
        // An error occurred and we didn't get a good response.
        if (!response || !response.headers) {
            this.log.debug("Unable to complete OAuth login.");
            return null;
        }
        // If we don't have the full set of cookies we expect, the user probably gave bad login information.
        if (!response.headers.raw()["set-cookie"] || response.headers.raw()["set-cookie"].length < 2) {
            this.log.error("Invalid myQ credentials given. Check your login and password.");
            return null;
        }
        return response;
    }
    // Intercept the OAuth login response to adjust cookie headers before sending on it's way.
    async oauthRedirect(loginResponse) {
        // Get the location for the redirect for later use.
        const redirectUrl = new URL(loginResponse.headers.get("location"), loginResponse.url);
        // Execute the redirect with the cleaned up cookies and we're done.
        const response = await this.retrieve(redirectUrl.toString(), {
            headers: this.generateLoginHeaders({
                "Cookie": this.generateLoginCookies(loginResponse.headers),
                "cache-control": "max-age=0",
                "origin": "null",
                "sec-fetch-site": "same-origin",
                "sec-fetch-user": "?1"
            }),
            redirect: "manual"
        });
        if (!response) {
            this.log.debug("Unable to complete the login redirect.");
            return null;
        }
        return response;
    }
    // Get a new OAuth access token and orchestrate the myQ login process.
    async getOAuthToken() {
        // Kill the refresh timer, if there is one.
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        // Refresh-token-only auth: skip the PKCE/login dance entirely. Use the refresh token
        // supplied by the user (extracted one-time from the official myQ app) to mint a fresh
        // access token. The refresh-token grant does not require Firebase App Check.
        const requestBody = new URLSearchParams({
            "client_id": MYQ_API_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": this.refreshToken
        });
        const response = await this.retrieve("https://partner-identity.myq-cloud.com/connect/token", {
            body: requestBody.toString(),
            headers: this.generateApiHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
            method: "POST"
        });
        if (!response) {
            return null;
        }
        // Grab the token JSON. The server rotates the refresh token on every refresh; persist
        // the new one (the caller may want to write it back to the config).
        const token = await response.json();
        this.refreshToken = token.refresh_token;
        this.tokenScope = token.scope ?? this.tokenScope;
        this.setTokenRefreshTimer(token.expires_in);
        // Return the access token in cookie-ready form: "Bearer ...".
        return token.token_type + " " + token.access_token;
    }
    // Refresh our tokens at a regular interval.
    setTokenRefreshTimer(amount) {
        // Kill the refresh timer, if there is one.
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.refreshTimer = setTimeout(() => {
            void this.refreshAccessToken();
        }, (amount - (3 * 60)) * 1000);
    }
    // Refresh our OAuth access token.
    async refreshOAuthToken() {
        // Create the request to refresh tokens.
        const requestBody = new URLSearchParams({
            "client_id": MYQ_API_CLIENT_ID,
            "client_secret": Buffer.from(MYQ_API_CLIENT_SECRET, "base64").toString(),
            "grant_type": "refresh_token",
            "redirect_uri": MYQ_API_REDIRECT_URI,
            "refresh_token": this.refreshToken,
            "scope": this.tokenScope
        });
        // Execute the refresh token request.
        const response = await this.retrieve("https://partner-identity.myq-cloud.com/connect/token", {
            body: requestBody.toString(),
            headers: this.generateApiHeaders({
                "Authorization": "Bearer old-token",
                "Content-Type": "application/x-www-form-urlencoded",
                "isRefresh": "true"
            }),
            method: "POST"
        });
        if (!response) {
            return false;
        }
        // Grab the refresh token JSON.
        const token = await response.json();
        this.accessToken = token.token_type + " " + token.access_token;
        this.refreshToken = token.refresh_token;
        this.tokenScope = token.scope ?? this.tokenScope;
        this.setTokenRefreshTimer(token.expires_in);
        this.log.debug("Successfully refreshed the myQ API access token.");
        // We're done.
        return true;
    }
    // Log us into myQ and get an access token.
    async acquireAccessToken() {
        let firstConnection = true;
        // Clear out tokens from prior connections.
        if (this.accessToken) {
            firstConnection = false;
            this.accessToken = null;
            this.accounts = [];
        }
        // Login to the myQ API and get an OAuth access token for our session.
        const token = await this.getOAuthToken();
        if (!token) {
            return false;
        }
        const regionMsg = this.region ? " using the " + myQRegions[this.region] + " myQ cloud region" : "";
        // On initial plugin startup, let the user know we've successfully connected.
        if (firstConnection) {
            this.log.info("Successfully connected to the myQ API%s.", regionMsg);
        }
        else {
            this.log.debug("Successfully reacquired a myQ API access token%s.", regionMsg);
        }
        this.accessToken = token;
        // Grab our account information for subsequent calls.
        if (!(await this.getAccounts())) {
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        // Success.
        return true;
    }
    // Refresh the myQ access token, if needed.
    async refreshAccessToken() {
        // If we don't have a access token yet, acquire one.
        if (!this.accounts.length || !this.accessToken) {
            return await this.acquireAccessToken();
        }
        // Try refreshing our existing access token before resorting to acquiring a new one.
        if (await this.refreshOAuthToken()) {
            return true;
        }
        this.log.error("Unable to refresh our access token. This error can usually be safely ignored and will be resolved by acquiring a new access token.");
        // Now generate a new access token.
        if (!(await this.acquireAccessToken())) {
            return false;
        }
        return true;
    }
    // Get the list of myQ devices associated with an account.
    async refreshDevices() {
        // Sanity check.
        if (!this.refreshToken) {
            this.log.error("You must login to the myQ API prior to calling this function.");
            return false;
        }
        // Validate and potentially refresh our access token.
        if (!(await this.refreshAccessToken())) {
            return false;
        }
        // Update our account information, to see if we've added or removed access to any other devices.
        if (!(await this.getAccounts())) {
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        const newDeviceList = [];
        // Loop over all the accounts we know about.
        for (const accountId of this.accounts) {
            // Get the list of device information for this account.
            // eslint-disable-next-line no-await-in-loop
            const response = await this.retrieve("https://devices.myq-cloud.com/api/v5.2/Accounts/" + accountId + "/Devices");
            if (!response) {
                this.log.error("Unable to update device status from the myQ API. Acquiring a new access token.");
                this.accessToken = null;
                this.accounts = [];
                return false;
            }
            // Now let's get our account information.
            // eslint-disable-next-line no-await-in-loop
            const data = await response.json();
            this.log.debug(util.inspect(data, { colors: true, depth: 10, sorted: true }));
            newDeviceList.push(...data.items);
        }
        // Notify the user about any new devices that we've discovered.
        if (newDeviceList) {
            for (const newDevice of newDeviceList) {
                // We already know about this device.
                if (this.devices?.some((x) => x.serial_number === newDevice.serial_number)) {
                    continue;
                }
                // We've discovered a new device.
                this.log.info("Discovered device family %s: %s.", newDevice.device_family, this.getDeviceName(newDevice));
            }
        }
        // Notify the user about any devices that have disappeared.
        if (this.devices) {
            for (const existingDevice of this.devices) {
                // This device still is visible.
                if (newDeviceList?.some((x) => x.serial_number === existingDevice.serial_number)) {
                    continue;
                }
                // We've had a device disappear.
                this.log.info("Removed device family %s: %s.", existingDevice.device_family, this.getDeviceName(existingDevice));
            }
        }
        // Save the updated list of devices.
        this.devices = newDeviceList;
        return true;
    }
    // Execute an action on a myQ device.
    async execute(device, command) {
        // Sanity check.
        if (!this.refreshToken) {
            this.log.error("You must login to the myQ API prior to calling this function.");
            return false;
        }
        // Validate and potentially refresh our access token.
        if (!(await this.refreshAccessToken())) {
            return false;
        }
        // Map the myQ device family to the corresponding URL endpoint. We treat garage doors as the default because they can appear as different names in the myQ API.
        const deviceMap = {
            "default": { host: "gdo", path: "door_openers" },
            "garagedoor": { host: "gdo", path: "door_openers" },
            "lamp": { host: "lamp", path: "lamps" }
        };
        // Figure out our endpoints based on the myQ device family.
        const deviceHost = deviceMap[device.device_family] ? deviceMap[device.device_family].host : deviceMap.default.host;
        const devicePath = deviceMap[device.device_family] ? deviceMap[device.device_family].path : deviceMap.default.path;
        // Execute a command on a myQ device.
        const response = await this.retrieve("https://account-devices-" + deviceHost + ".myq-cloud.com/api/v5.2/Accounts/" + device.account_id +
            "/" + devicePath + "/" + device.serial_number + "/" + command, { headers: this.generateApiHeaders(), method: "PUT" });
        // Check for errors.
        if (!response) {
            // If it's a 403 error, the command was likely delivered to an unavailable or offline myQ device.
            if (this.apiReturnStatus === 403) {
                return false;
            }
            this.log.error("Unable to send the command to myQ servers. Acquiring a new access token.");
            this.accessToken = null;
            this.accounts = [];
            return false;
        }
        return true;
    }
    // Get our myQ account information.
    async getAccounts() {
        // Get the account information.
        const response = await this.retrieve("https://accounts.myq-cloud.com/api/v6.0/accounts");
        if (!response) {
            this.log.error("Unable to retrieve account information.");
            return false;
        }
        // Now let's get our account information.
        const data = await response.json();
        this.log.debug(util.inspect(data, { colors: true, depth: 10, sorted: true }));
        // No account information returned.
        if (!data?.accounts) {
            this.log.error("No account information found.");
            return false;
        }
        // Save all the account identifiers we know about for later use.
        this.accounts = data.accounts.map(x => x.id);
        return true;
    }
    // Get the details of a specific device in the myQ device list.
    getDevice(serial) {
        // Login sanity check.
        if (!this.refreshToken) {
            this.log.error("You must login to the myQ API prior to calling this function.");
            return null;
        }
        // If we have no myQ devices or an invalid serial number, we're done.
        if (!this.devices || (serial.length <= 0)) {
            return null;
        }
        // Convert to upper case before searching for it.
        serial = serial.toUpperCase();
        // Iterate through the list and find the device that matches the serial number we seek.
        return this.devices.find(x => x.serial_number?.toUpperCase() === serial) ?? null;
    }
    // Utility to generate a nicely formatted device string.
    getDeviceName(device) {
        // A completely enumerated device will appear as: DeviceName [DeviceBrand] (serial number: Serial, gateway: GatewaySerial).
        let deviceString = device.name;
        // Only grab hardware information for the hardware we know how to decode.
        const hwInfo = device.device_family !== "gateway" ? this.getHwInfo(device.serial_number) : null;
        if (hwInfo) {
            deviceString += " [" + hwInfo.brand + " " + hwInfo.product + "]";
        }
        if (device.serial_number) {
            deviceString += " (serial number: " + device.serial_number;
            if (device.parent_device_id) {
                deviceString += ", gateway: " + device.parent_device_id;
            }
            deviceString += ")";
        }
        return deviceString;
    }
    // Return device manufacturer and model information based on the serial number, if we can.
    getHwInfo(serial) {
        // We only know about gateway devices and not individual openers, so we can only decode those. According to Liftmaster, here's how you decode device types:
        //
        // The myQ serial number for the Wi-Fi GDO, myQ Home Bridge, myQ Smart Garage Hub, myQ Garage (Wi-Fi Hub) and Internet Gateway is 12 characters long. The first two
        // characters, typically "GW", followed by 2 characters that are decoded according to the table below to identify the device type and brand, with the remaining
        // 8 characters representing the serial number.
        const HwInfo = {
            "00": { brand: "Chamberlain", product: "Ethernet Gateway" },
            "01": { brand: "Liftmaster", product: "Ethernet Gateway" },
            "02": { brand: "Craftsman", product: "Ethernet Gateway" },
            "03": { brand: "Chamberlain", product: "WiFi Hub" },
            "04": { brand: "Liftmaster", product: "WiFi Hub" },
            "05": { brand: "Craftsman", product: "WiFi Hub" },
            "08": { brand: "Liftmaster", product: "WiFi GDO DC w/Battery Backup" },
            "09": { brand: "Chamberlain", product: "WiFi GDO DC w/Battery Backup" },
            "0A": { brand: "Chamberlain", product: "WiFi GDO AC" },
            "0B": { brand: "Liftmaster", product: "WiFi GDO AC" },
            "0C": { brand: "Craftsman", product: "WiFi GDO AC" },
            "0D": { brand: "myQ Replacement Logic Board", product: "WiFi GDO AC" },
            "0E": { brand: "Chamberlain", product: "WiFi GDO AC 3/4 HP" },
            "0F": { brand: "Liftmaster", product: "WiFi GDO AC 3/4 HP" },
            "10": { brand: "Craftsman", product: "WiFi GDO AC 3/4 HP" },
            "11": { brand: "myQ Replacement Logic Board", product: "WiFi GDO AC 3/4 HP" },
            "12": { brand: "Chamberlain", product: "WiFi GDO DC 1.25 HP" },
            "13": { brand: "Liftmaster", product: "WiFi GDO DC 1.25 HP" },
            "14": { brand: "Craftsman", product: "WiFi GDO DC 1.25 HP" },
            "15": { brand: "myQ Replacement Logic Board", product: "WiFi GDO DC 1.25 HP" },
            "20": { brand: "Chamberlain", product: "myQ Home Bridge" },
            "21": { brand: "Liftmaster", product: "myQ Home Bridge" },
            "23": { brand: "Chamberlain", product: "Smart Garage Hub" },
            "24": { brand: "Liftmaster", product: "Smart Garage Hub" },
            "27": { brand: "Liftmaster", product: "WiFi Wall Mount Opener" },
            "28": { brand: "Liftmaster Commercial", product: "WiFi Wall Mount Operator" },
            "33": { brand: "Chamberlain", product: "Smart Garage Control" },
            "34": { brand: "Liftmaster", product: "Smart Garage Control" },
            "80": { brand: "Liftmaster EU", product: "Ethernet Gateway" },
            "81": { brand: "Chamberlain EU", product: "Ethernet Gateway" }
        };
        if (serial?.length < 4) {
            return null;
        }
        // Use the third and fourth characters as indices into the hardware matrix. Admittedly, we don't have a way to resolve the first two characters to ensure we are
        // matching against the right category of devices.
        return (HwInfo[serial[2] + serial[3]]) ?? null;
    }
    // Utility function to generate the cookies used in the login process, based on existing cookies provided by the myQ API and additional ones being set.
    generateLoginCookies(headers) {
        // Grab the headers, if they exist.
        let cookies = headers.raw().cookie ?? [];
        let setCookies = headers.raw()["set-cookie"] ?? [];
        // Let's make sure we're operating on arrays.
        if (!Array.isArray(cookies)) {
            cookies = [cookies];
        }
        if (!Array.isArray(setCookies)) {
            setCookies = [setCookies];
        }
        // We need to strip spurious additions to the cookie that gets returned by the myQ API.
        return cookies.concat(setCookies).map(x => x.split(";")[0]).join("; ");
    }
    // Utility to let us streamline error handling and return checking from the myQ API.
    async retrieve(url, options = { headers: this.generateApiHeaders() }, decodeResponse = true, isRetry = 0) {
        // This could be done with regular expressions, but in the interest of easier readability and maintenance, we parse the URL with a URL object.
        const retrieveUrl = new URL(url);
        // Retrieve the first part of the hostname.
        const hostname = retrieveUrl.hostname.split(".");
        // Regular expression to test for whether we already have a region specifier in the hostname.
        const regionRegex = new RegExp("^.*-(" + myQRegions.join("|") + ")$");
        // Add our region-specific context to the hostname, if it's not already there.
        if (!regionRegex.test(hostname[0])) {
            // This is a retry request, meaning something went wrong with the original request. We retry in another region as a resiliency measure.
            if (isRetry) {
                this.region = ++this.region % myQRegions.length;
                this.log.debug("Switching to myQ cloud region: %s.", myQRegions[this.region].length ? myQRegions[this.region] : "auto");
            }
            hostname[0] += this.region ? "-" + myQRegions[this.region] : "";
        }
        retrieveUrl.hostname = hostname.join(".");
        // Catch redirects:
        //
        // 301: Moved permanently.
        // 302: Found.
        // 303: See other.
        // 307: Temporary redirect.
        // 308: Permanent redirect.
        const isRedirect = (code) => [301, 302, 303, 307, 308].includes(code);
        // Catch myQ credential-related issues:
        //
        // 400: Bad request.
        // 401: Unauthorized.
        const isCredentialsIssue = (code) => [400, 401].includes(code);
        // Catch myQ server-side issues:
        //
        // 429: Too many requests.
        // 500: Internal server error.
        // 502: Bad gateway.
        // 503: Service temporarily unavailable.
        // 504: Gateway timeout.
        // 521: Web server down (Cloudflare-specific).
        // 522: Connection timed out (Cloudflare-specific).
        const isServerSideIssue = (code) => [429, 500, 502, 503, 504, 521, 522].includes(code);
        const retry = async (logMessage) => {
            // Retry when we have a connection issue, but no more than once.
            if (isRetry < 3) {
                this.log.debug(logMessage + " Retrying the API call.");
                return this.retrieve(url, options, decodeResponse, ++isRetry);
            }
            this.log.error(logMessage);
            return null;
        };
        let response;
        // Reset our API return status.
        this.apiReturnStatus = 0;
        try {
            response = await this.myqRetrieve(retrieveUrl.toString(), options);
            // Save our return status.
            this.apiReturnStatus = response.status;
            // The caller will sort through responses instead of us, or we've got a successful API call, or we've been redirected.
            if (!decodeResponse || response.ok || isRedirect(response.status)) {
                if (isRetry) {
                    this.log.info("Switched to myQ cloud region: %s.", myQRegions[this.region].length ? myQRegions[this.region] : "auto");
                }
                return response;
            }
            // Invalid login credentials.
            if (isCredentialsIssue(response.status)) {
                return retry("Invalid myQ credentials given: Check your username and password. If they are correct, the myQ API may be experiencing temporary issues.");
            }
            // 403: Command forbidden. In myQ parlance, this usually means the device is unavailable or offline.
            if (response.status === 403) {
                this.log.error("Forbidden API call. This error is typically due to an offline or unavailable myQ device.");
                return null;
            }
            const httpStatusMessage = response.status + (http.STATUS_CODES[response.status] ? " - " + http.STATUS_CODES[response.status] : "");
            // myQ API issues at the server end.
            if (isServerSideIssue(response.status)) {
                return retry("Temporary myQ API server-side issues encountered: " + httpStatusMessage + "." +
                    (response.status === 429 ? " This typically indicates a myQ API lockout for a 60-90 minute period before resuming API connectivity." : ""));
            }
            // Some other unknown error occurred.
            this.log.error("API call returned error: %s.", httpStatusMessage);
            return null;
        }
        catch (error) {
            if (error instanceof FetchError) {
                switch (error.code) {
                    case "ECONNREFUSED":
                    case "ERR_HTTP2_STREAM_CANCEL":
                        return retry("Connection refused.");
                        break;
                    case "ECONNRESET":
                        return retry("Connection has been reset.");
                        break;
                    case "ENOTFOUND":
                        return retry("Hostname or IP address not found.");
                        break;
                    case "ETIMEDOUT":
                        return retry("Connection timed out.");
                        break;
                    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
                        return retry("Unable to verify the myQ TLS security certificate.");
                        break;
                    default:
                        return retry(error.code.toString() + " - " + error.message);
                }
            }
            else {
                return retry("Unknown fetch error: " + error.toString());
            }
            return null;
        }
    }
}
//# sourceMappingURL=myq-api.js.map