import { REPO, YamlFile } from ".";
import { SteamGameCache, SteamGameCacheFile } from "./steam";
import { WikiGameCache, parseTemplates } from "./wiki";

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
    gog?: {
        id?: number,
    };
    id?: {
        flatpak?: string,
        gogExtra?: Array<number>,
        steamExtra?: Array<number>,
    };
}

type OverriddenGame = Game & { omit?: boolean };

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

function integrateWikiData(game: Game, cache: WikiGameCache[""]): void {
    game.id = {};
    if (cache.steam !== undefined) {
        game.steam = { id: cache.steam };
    }
    if (cache.steamSide !== undefined) {
        game.id.steamExtra = cache.steamSide;
    }
    if (cache.gog !== undefined) {
        game.gog = { id: cache.gog };
    }
    if (cache.gogSide !== undefined) {
        game.id.gogExtra = cache.gogSide;
    }
    const info = parseTemplates(cache.templates ?? []);
    game.files = info.files;
    game.registry = info.registry;

    if (game.id.flatpak === undefined && game.id.gogExtra === undefined && game.id.steamExtra === undefined) {
        delete game.id;
    }
}

function integrateSteamData(game: Game, appInfo: SteamGameCache[""] | undefined): void {
    if (appInfo === undefined) {
        return;
    }

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

function integrateOverriddenData(game: Game, override: OverriddenGame) {
    if (override.steam) {
        game.steam = override.steam;
    }

    if (override.gog) {
        game.gog = override.gog;
    }

    if (override.id) {
        if (game.id === undefined) {
            game.id = {};
        }

        if (override.id.flatpak) {
            game.id.flatpak = override.id.flatpak;
        }
    }
}

function hasAnyData(game: Game): boolean {
    return game.files !== undefined || game.registry !== undefined || game.steam?.id !== undefined || game.gog?.id !== undefined || game.id !== undefined;
}

export class ManifestFile extends YamlFile<Manifest> {
    path = `${REPO}/data/manifest.yaml`;
    defaultData = {};

    async updateGames(
        wikiCache: WikiGameCache,
        games: Array<string>,
        steamCache: SteamGameCacheFile,
        override: ManifestOverrideFile,
    ): Promise<void> {
        this.data = {};

        for (const [title, info] of Object.entries(wikiCache).sort()) {
            const overridden = override.data[title];
            if (overridden?.omit) {
                continue;
            }

            if (games?.length > 0 && !games.includes(title)) {
                continue;
            }

            const game: Game = {};
            integrateWikiData(game, info);
            if (overridden) {
                integrateOverriddenData(game, overridden);
            }

            if (!hasAnyData(game)) {
                continue;
            }
            if (game.steam?.id !== undefined) {
                const appInfo = await steamCache.getAppInfo(game.steam.id);
                integrateSteamData(game, appInfo);
            }
            this.data[title] = game;
        }

        for (const [title, info] of Object.entries(override.data).sort()) {
            if (title in this.data || info.omit) {
                continue;
            }
            delete info.omit;
            this.data[title] = info;
        }
    }
}

export interface ManifestOverride {
    [game: string]: OverriddenGame
}

export class ManifestOverrideFile extends YamlFile<ManifestOverride> {
    path = `${REPO}/data/manifest-override.yaml`;
    defaultData = {};
}
