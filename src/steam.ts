import { DELAY_BETWEEN_GAMES_MS, REPO, YamlFile } from ".";
import * as SteamUser from "steam-user";

type SteamGameCache = {
    [appId: string]: {
        installDir?: string,
        unknown?: boolean,
        nameLocalized?: Map<string, string>;
        launch?: object;
    };
};

export class SteamGameCacheFile extends YamlFile<SteamGameCache> {
    path = `${REPO}/data/steam-game-cache.yaml`;
    defaultData = {};

    constructor(public steamClient: SteamUser) {
        super();
    }

    async getAppInfo(appId: number, update: boolean = false): Promise<SteamGameCache[""] | undefined> {
        const key = appId.toString();
        if (!update && this.data.hasOwnProperty(key)) {
            return this.data[key];
        }

        const info: SteamProductInfoResponse = await this.steamClient.getProductInfo([appId], []);

        if (info.unknownApps.includes(appId)) {
            this.data[key] = { unknown: true };
            return undefined;
        }

        this.data[key] = {};

        const installDir = info.apps[key].appinfo.config?.installdir;
        if (installDir !== undefined) {
            this.data[key].installDir = installDir;
        }

        const nameLocalized = info.apps[key].appinfo.common?.name_localized;
        if (nameLocalized !== undefined && Object.keys(nameLocalized).length > 0) {
            this.data[key].nameLocalized = nameLocalized;
        }

        const launch = info.apps[key].appinfo.config?.launch;
        if (launch !== undefined) {
            const keys = Object.keys(launch).sort((x, y) => parseInt(x) - parseInt(y));
            this.data[key].launch = keys.map(x => launch[x]);
        }

        return this.data[key];
    }

    async refresh(filter: {skipUntil: string | undefined}, limit: number): Promise<void> {
        let i = 0;
        let foundSkipUntil = false;
        for (const appId of Object.keys(this.data)) {
            if (filter.skipUntil && !foundSkipUntil) {
                if (appId === filter.skipUntil) {
                    foundSkipUntil = true;
                } else {
                    continue;
                }
            }

            console.log(`Refreshing Steam app ${appId}`)
            await this.getAppInfo(parseInt(appId), true);

            i++;
            if (limit > 0 && i >= limit) {
                break;
            }

            // main() will save at the end, but we do a period save as well
            // in case something goes wrong or the script gets cancelled:
            if (i % 250 === 0) {
                this.save();
                console.log(":: saved");
            }

            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_GAMES_MS));
        }
    }
}

interface SteamProductInfoResponse {
    apps: {
        [appId: string]: {
            appinfo: {
                common?: {
                    name_localized?: Map<string, string>,
                },
                config?: {
                    installdir?: string,
                    launch?: object,
                },
            },
        },
    },
    unknownApps: Array<number>,
}

export async function getSteamClient(): Promise<SteamUser> {
    const client = new SteamUser();
    client.logOn();
    await new Promise<void>(resolve => {
        client.on("loggedOn", () => {
            resolve();
        });
    });
    return client;
}
