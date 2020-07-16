import { DELAY_BETWEEN_GAMES_MS, REPO, YamlFile } from ".";
import { SteamGameCacheFile } from "./steam";
import { WikiGameCache, getGame, pathIsTooBroad } from "./wiki";

export type Os = "dos" | "linux" | "mac" | "windows";

export type Store = "epic" | "gog" | "microsoft" | "steam" | "uplay";

export type Tag = "config" | "save";

export interface Manifest {
    [game: string]: Game;
}

export interface Game {
    files?: {
        [path: string]: {
            when?: Array<Constraint>,
            tags?: Array<Tag>,
        }
    };
    installDir?: {
        [name: string]: {}
    };
    registry?: {
        [path: string]: {
            when?: Array<Omit<Constraint, "os">>,
            tags?: Array<Tag>,
        }
    };
    steam?: {
        id?: number
    };
}

export interface Constraint {
    os?: Os;
    store?: Store;
}

export class ManifestFile extends YamlFile<Manifest> {
    path = `${REPO}/data/manifest.yaml`;
    defaultData = {};

    async updateGames(
        wikiCache: WikiGameCache,
        filter: {
            all: boolean,
            existing: boolean,
            missing: boolean,
            unchecked: boolean,
            unsupportedOs: boolean,
            unsupportedPath: boolean,
            irregularPath: boolean,
            tooBroad: boolean,
            tooBroadUntagged: boolean,
            game: string | undefined,
            recent: number | undefined,
        },
        limit: number | undefined,
        steamCache: SteamGameCacheFile,
    ): Promise<void> {
        let i = 0;
        for (const [title, info] of Object.entries(wikiCache)) {
            let check = false;
            if (filter.all) {
                check = true;
            }
            if (filter.existing && this.data.hasOwnProperty(title)) {
                check = true;
            }
            if (filter.missing && !this.data.hasOwnProperty(title)) {
                check = true;
            }
            if (filter.unchecked && wikiCache[title].revId === null) {
                check = true;
            }
            if (filter.unsupportedOs && info.unsupportedOs) {
                check = true;
            }
            if (filter.unsupportedPath && info.unsupportedPath) {
                check = true;
            }
            if (filter.irregularPath && (wikiCache[title].irregularPath || Object.keys(this.data[title]?.files ?? []).some(x => x.includes("{{") || x.includes("</") || x.includes("<br>") || x.includes("<br/>")))) {
                check = true;
            }
            if (filter.game === title) {
                check = true;
            }
            if (filter.tooBroad && info.tooBroad) {
                check = true;
            }
            if (filter.tooBroadUntagged && Object.keys(this.data[title]?.files ?? []).some(x => pathIsTooBroad(x))) {
                check = true;
            }
            if (filter.recent && wikiCache[title].recentlyChanged) {
                check = true;
            }
            if (!check) {
                continue;
            }

            i++;
            if (limit > 0 && i > limit) {
                break;
            }

            if (info.renamedFrom) {
                for (const oldName of info.renamedFrom) {
                    delete this.data[oldName];
                }
            }

            const game = await getGame(title, wikiCache);
            delete wikiCache[title].recentlyChanged;
            if (game.files === undefined && game.registry === undefined && game.steam?.id === undefined) {
                delete this.data[title];
                continue;
            }
            if (game.steam?.id !== undefined) {
                const installDir = await steamCache.getAppInstallDir(game.steam.id);
                if (installDir !== undefined) {
                    if (game.installDir === undefined) {
                        game.installDir = {}
                    }
                    game.installDir[installDir] = {}
                }
            }
            this.data[title] = game;

            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_GAMES_MS));
        }
    }
}
