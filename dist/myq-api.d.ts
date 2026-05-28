import { myQDevice, myQHwInfo } from "./myq-types.js";
import { myQLogging } from "./myq-logging.js";
export declare class myQApi {
    devices: myQDevice[];
    private accessToken;
    private refreshTimer;
    private refreshToken;
    private tokenScope;
    private apiReturnStatus;
    private email;
    private password;
    private accounts;
    private headers;
    private log;
    private myqRetrieve;
    private region;
    constructor(log?: myQLogging);
    login(refreshToken: string): Promise<boolean>;
    /**
     * Public accessor for the raw Bearer JWT — needed by callers that talk to the Tend platform
     * directly (e.g., camera streaming/snapshots), which uses the same access token but a
     * different host than the legacy myQ REST endpoints.
     * Returns the JWT without the "Bearer " prefix, or null if not signed in.
     */
    getRawAccessToken(): string | null;
    /** Account id list (UUIDs). Cameras are scoped per account; callers may need this for Tend. */
    get accountIds(): readonly string[];
    /**
     * The lib rotates refresh_token on every refresh. Callers that need to run their own
     * IDS refresh-token grants (e.g. for Tend platform access) should read the LATEST one
     * from here, not the (rotated-away, now-invalid) one in the homebridge config.
     */
    getCurrentRefreshToken(): string | null;
    private tokenPersistCallback?;
    setTokenPersistCallback(cb: (newRefreshToken: string) => void | Promise<void>): void;
    private firePersistCallback;
    private generateLoginHeaders;
    private generateApiHeaders;
    private oauthGetAuthPage;
    private oauthLogin;
    private oauthRedirect;
    private getOAuthToken;
    private setTokenRefreshTimer;
    private refreshOAuthToken;
    private acquireAccessToken;
    private refreshAccessToken;
    refreshDevices(): Promise<boolean>;
    execute(device: myQDevice, command: string): Promise<boolean>;
    private getAccounts;
    getDevice(serial: string): myQDevice | null;
    getDeviceName(device: myQDevice): string;
    getHwInfo(serial: string): myQHwInfo | null;
    private generateLoginCookies;
    private retrieve;
}
