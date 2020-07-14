import { REPO, YamlFile } from ".";
import * as SteamUser from "steam-user";

type SteamGameCache = {
    [appId: string]: {
        installDir?: string,
        unknown?: boolean,
    };
};

export class SteamGameCacheFile extends YamlFile<SteamGameCache> {
    path = `${REPO}/data/steam-game-cache.yaml`;
    defaultData = {};

    constructor(public steamClient: SteamUser) {
        super();
    }

    async getAppInstallDir(appId: number): Promise<string | undefined> {
        const key = appId.toString();
        if (this.data.hasOwnProperty(key)) {
            return this.data[key].installDir;
        } else {
            const info: SteamProductInfoResponse = await this.steamClient.getProductInfo([appId], []);

            if (info.unknownApps.includes(appId)) {
                this.data[key] = { unknown: true };
                return undefined;
            }

            const installDir = info.apps[key].appinfo.config?.installdir;
            if (installDir !== undefined) {
                this.data[key] = { installDir };
            } else {
                this.data[key] = {};
            }
            return installDir;
        }
    }
}

interface SteamProductInfoResponse {
    apps: {
        [appId: string]: {
            appinfo: {
                config?: {
                    installdir?: string
                }
            }
        }
    },
    unknownApps: Array<number>,
}

export async function getSteamClient(): Promise<SteamUser> {
    const client = new SteamUser();
    client.logOn();
    await new Promise(resolve => {
        client.on("loggedOn", () => {
            resolve();
        });
    });
    return client;
}
