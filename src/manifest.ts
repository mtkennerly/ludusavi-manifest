import { DELAY_BETWEEN_GAMES_MS, REPO, YamlFile } from ".";
import { SteamGameCache, SteamGameCacheFile } from "./steam";
import { WikiGameCache, getGame, pathIsTooBroad } from "./wiki";

export type Os = "dos" | "linux" | "mac" | "windows";

export type Bit = 32 | 64;

export type Store = "epic" | "gog" | "microsoft" | "steam" | "uplay" | "origin";

export type Tag = "config" | "save";

export interface Manifest {
    [game: string]: Game;
}

export interface Game {
    files?: {
        [path: string]: {
            when?: Array<Omit<Constraint, "bit">>,
            tags?: Array<Tag>,
        }
    };
    installDir?: {
        [name: string]: {}
    };
    launch?: {
        [path: string]: Array<{
            arguments?: string;
            workingDir?: string;
            when?: Array<Constraint>,
        }>
    },
    registry?: {
        [path: string]: {
            when?: Array<Omit<Constraint, "bit" | "os">>,
            tags?: Array<Tag>,
        }
    };
    steam?: {
        id?: number
    };
}

export interface Constraint {
    os?: Os;
    bit?: Bit;
    store?: Store;
}

function normalizeLaunchPath(raw: string): string | undefined {
    if (raw.includes("://")) {
        return raw;
    }
    const standardized = raw
        .replace(/\\/g, "/")
        .replace(/\/\//g, "/")
        .replace(/\/(?=$)/g, "")
        .replace(/^.\//, "")
        .replace(/^\/+/, "")
        .trim();
    if (standardized.length === 0 || standardized === ".") {
        return undefined;
    }
    return `<base>/${standardized}`;
}

function doLaunchPathsMatch(fromSteam: string | undefined, fromManifest: string | undefined): boolean {
    if (fromSteam === undefined) {
        return fromManifest === undefined;
    } else {
        return normalizeLaunchPath(fromSteam) === fromManifest;
    }
}

function integrateSteamData(game: Game, appInfo: SteamGameCache[""]) {
    if (appInfo.installDir !== undefined) {
        game.installDir = { [appInfo.installDir]: {} };
    }
    if (appInfo.launch !== undefined) {
        delete game.launch;
        for (const incoming of appInfo.launch) {
            if (
                incoming.executable === undefined ||
                incoming.executable.includes("://") ||
                ![undefined, "default", "none"].includes(incoming.type) ||
                incoming.config?.betakey !== undefined ||
                incoming.config?.ownsdlc !== undefined
            ) {
                continue;
            }

            const os: Os | undefined = {
                "windows": "windows",
                "macos": "mac",
                "macosx": "mac",
                "linux": "linux",
            }[incoming.config?.oslist] as Os;
            const bit: Bit | undefined = {
                "32": 32,
                "64": 64,
            }[incoming.config?.osarch] as Bit;
            const when: Constraint = { os, bit, store: "steam" };
            if (when.os === undefined) {
                delete when.os;
            }
            if (when.bit === undefined) {
                delete when.bit;
            }

            let foundExisting = false;
            for (const [existingExecutable, existingOptions] of Object.entries(game.launch ?? {})) {
                for (const existing of existingOptions) {
                    if (
                        incoming.arguments === existing.arguments &&
                        doLaunchPathsMatch(incoming.executable, existingExecutable) &&
                        doLaunchPathsMatch(incoming.workingdir, existing.workingDir)
                    ) {
                        foundExisting = true;
                        if (existing.when === undefined) {
                            existing.when = [];
                        }
                        if (existing.when.every(x => x.os !== os && x.bit !== bit && x.store !== "steam")) {
                            existing.when.push(when);
                        }
                        if (existing.when.length === 0) {
                            delete existing.when;
                        }
                    }
                }
            }
            if (!foundExisting) {
                const key = normalizeLaunchPath(incoming.executable);
                if (key === undefined) {
                    continue;
                }

                const candidate: Game["launch"][""][0] = { when: [when] };
                if (incoming.arguments !== undefined) {
                    candidate.arguments = incoming.arguments;
                }
                if (incoming.workingdir !== undefined) {
                    const workingDir = normalizeLaunchPath(incoming.workingdir);
                    if (workingDir !== undefined) {
                        candidate.workingDir = workingDir;
                    }
                }

                if (game.launch === undefined) {
                    game.launch = {};
                }
                if (game.launch[key] === undefined) {
                    game.launch[key] = [];
                }
                game.launch[key].push(candidate);
            }
        }
    }
}

function isPathRegular(path: string): boolean {
    const irregular = ["{{", "</", "/>", "<br>", "//"];
    return !irregular.some(x => path.includes(x))
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
            irregularPathUntagged: boolean,
            tooBroad: boolean,
            tooBroadUntagged: boolean,
            pathContains: string | undefined,
            skipUntil: string | undefined,
            games: Array<string> | undefined,
            recent: boolean | undefined,
        },
        limit: number | undefined,
        steamCache: SteamGameCacheFile,
        local: boolean,
    ): Promise<void> {
        let i = 0;
        let foundSkipUntil = false;
        for (const [title, info] of Object.entries(wikiCache)) {
            if (filter.skipUntil && !foundSkipUntil) {
                if (title === filter.skipUntil) {
                    foundSkipUntil = true;
                } else {
                    continue;
                }
            }

            let check = false;
            if (filter.pathContains && Object.keys(this.data[title]?.files ?? {}).some(x => x.includes(filter.pathContains))) {
                check = true;
            }
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
            if (filter.irregularPath && wikiCache[title].irregularPath) {
                check = true;
            }
            if (
                filter.irregularPathUntagged &&
                !wikiCache[title].irregularPath &&
                (
                    Object.keys(this.data[title]?.files ?? []).some(x => !isPathRegular(x)) ||
                    Object.keys(this.data[title]?.registry ?? []).some(x => !isPathRegular(x))
                )
            ) {
                check = true;
            }
            if (filter.games && filter.games.includes(title)) {
                check = true;
            }
            if (filter.tooBroad && info.tooBroad) {
                check = true;
            }
            if (filter.tooBroadUntagged && !info.tooBroad && Object.keys(this.data[title]?.files ?? []).some(x => pathIsTooBroad(x))) {
                check = true;
            }
            if (filter.recent && wikiCache[title].recentlyChanged) {
                check = true;
            }
            if (!check) {
                continue;
            }

            if (info.renamedFrom) {
                for (const oldName of info.renamedFrom) {
                    delete this.data[oldName];
                }
            }

            let verifiedTitle: string;
            let game: Game;
            if (local) {
                [verifiedTitle, game] = [title, this.data[title] ?? {}];
            } else {
                [verifiedTitle, game] = await getGame(title, wikiCache);
            }

            delete wikiCache[verifiedTitle].recentlyChanged;

            if (verifiedTitle !== title) {
                delete this.data[title];
            }

            if (game.files === undefined && game.registry === undefined && game.steam?.id === undefined) {
                delete this.data[verifiedTitle];
                continue;
            }
            if (game.steam?.id !== undefined) {
                const appInfo = await steamCache.getAppInfo(game.steam.id);
                integrateSteamData(game, appInfo);
            }
            this.data[verifiedTitle] = game;

            if (!local) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_GAMES_MS));
            }

            i++;
            if (limit > 0 && i > limit) {
                break;
            }
        }
    }
}
