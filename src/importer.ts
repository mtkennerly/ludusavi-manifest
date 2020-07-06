import * as Wikiapi from "wikiapi";
import * as fs from "fs";
import * as pathMod from "path";
import * as minimist from "minimist";
import * as yaml from "js-yaml";
import * as SteamUser from "steam-user";

const REPO = pathMod.dirname(__dirname);
const DELAY_BETWEEN_GAMES_MS = 250;

interface Cli {
    cache?: boolean,
    manifest?: boolean,
    all?: boolean,
    existing?: boolean,
    missing?: boolean,
    unchecked?: boolean,
    unsupportedOs?: boolean,
    unsupportedPath?: boolean,
    game?: string,
    limit?: number,
}

class UnsupportedError extends Error {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

class UnsupportedOsError extends UnsupportedError {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

class UnsupportedPathError extends UnsupportedError {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

enum PathType {
    FileSystem,
    Registry,
}

type Os = "dos" | "linux" | "mac" | "windows";

type Store = "epic" | "gog" | "microsoft" | "steam" | "uplay";

type Tag = "config" | "save";

type GamePages = Array<{ pageid: number, title: string }>;

type WikiGameCache = {
    [title: string]: {
        pageId: number,
        revId: number | null,
        /** Whether an entry on the page failed because of an unsupported OS. */
        unsupportedOs?: boolean,
        /** Whether an entry on the page failed because of an unsupported Path template argument. */
        unsupportedPath?: boolean,
    };
};

type SteamGameCache = {
    [appId: string]: {
        installDir?: string,
        unknown?: boolean,
    };
};

// This defines how {{P|game}} and such are converted.
const PATH_ARGS: { [arg: string]: { mapped: string, when?: Constraint, registry?: boolean, ignored?: boolean } } = {
    game: {
        mapped: "<base>",
    },
    uid: {
        mapped: "<storeUserId>",
    },
    steam: {
        mapped: "<root>",
        when: {
            store: "steam",
        },
    },
    uplay: {
        mapped: "<root>",
        when: {
            store: "uplay"
        },
    },
    hkcu: {
        mapped: "HKEY_CURRENT_USER",
        when: { os: "windows" },
        registry: true,
    },
    hklm: {
        mapped: "HKEY_LOCAL_MACHINE",
        when: { os: "windows" },
        registry: true,
    },
    wow64: {
        mapped: "<regWow64>",
        when: { os: "windows" },
        registry: true,
        ignored: true,
    },
    username: {
        mapped: "<osUserName>",
        when: { os: "windows" },
    },
    userprofile: {
        mapped: "<home>",
        when: { os: "windows" },
    },
    "userprofile\\documents": {
        mapped: "<winDocuments>",
        when: { os: "windows" },
    },
    appdata: {
        mapped: "<winAppData>",
        when: { os: "windows" },
    },
    localappdata: {
        mapped: "<winLocalAppData>",
        when: { os: "windows" },
    },
    public: {
        mapped: "<winPublic>",
        when: { os: "windows" },
    },
    allusersprofile: {
        mapped: "<winProgramData>",
        when: { os: "windows" },
    },
    programdata: {
        mapped: "<winProgramData>",
        when: { os: "windows" },
    },
    windir: {
        mapped: "<winDir>",
        when: { os: "windows" },
    },
    syswow64: {
        mapped: "<winDir>/SysWOW64",
        when: { os: "windows" },
    },
    osxhome: {
        mapped: "<home>",
        when: { os: "mac" },
    },
    linuxhome: {
        mapped: "<home>",
        when: { os: "linux" },
    },
    xdgdatahome: {
        mapped: "<xdgData>",
        when: { os: "linux" },
    },
    xdgconfighome: {
        mapped: "<xdgConfig>",
        when: { os: "linux" },
    },
}

interface Manifest {
    [game: string]: Game;
}

interface Game {
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

interface Constraint {
    os?: Os;
    store?: Store;
}

function makePathArgRegex(arg: string): RegExp {
    const escaped = `{{P|${arg}}}`
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("{", "\\{")
        .replace("}", "\\}");
    return new RegExp(escaped, "gi");
}

/**
 * https://www.pcgamingwiki.com/wiki/Template:Path
 */
function parsePath(path: string): [string, PathType] {
    const pathType = getPathType(path);

    for (const [arg, info] of Object.entries(PATH_ARGS)) {
        if (pathContainsArg(path, arg) && info.ignored) {
            throw new UnsupportedPathError(`Unsupported path argument: ${arg}`);
        }

        let limit = 100;
        let i = 0;
        while (pathContainsArg(path, arg)) {
            path = path.replace(makePathArgRegex(arg), info.mapped);
            i++;
            if (i >= limit) {
                throw new UnsupportedPathError(`Unable to resolve path arguments in: ${path}`);
            }
        }
    }

    return [
        path
            .replace(/\\/g, "/")
            .replace(/\/(?=$)/g, "")
            .replace(/^~(?=($|\/))/, "<home>"),
        pathType,
    ];
}

function pathContainsArg(path: string, arg: string): boolean {
    return path.match(makePathArgRegex(arg)) !== null;
}

function getPathType(path: string): PathType {
    for (const [arg, info] of Object.entries(PATH_ARGS)) {
        if (info.registry && path.match(makePathArgRegex(arg)) !== null) {
            return PathType.Registry;
        }
    }
    return PathType.FileSystem;
}

function getOsConstraintFromPath(path: string): Os | undefined {
    for (const [arg, info] of Object.entries(PATH_ARGS)) {
        if (pathContainsArg(path, arg) && info?.when?.os) {
            return info?.when?.os;
        }
    }
}

function getStoreConstraintFromPath(path: string): Store | undefined {
    for (const [arg, info] of Object.entries(PATH_ARGS)) {
        if (pathContainsArg(path, arg) && info?.when?.store) {
            return info?.when?.store;
        }
    }
}

function getConstraintFromSystem(system: string, path: string): Constraint {
    const constraint: Constraint = {};

    if (system.match(/steam/i)) {
        constraint.store = "steam";
    } else if (system.match(/microsoft store/i)) {
        constraint.os = "windows";
        constraint.store = "microsoft";
    } else if (system.match(/gog\.com/i)) {
        constraint.store = "gog";
    } else if (system.match(/epic games store/i)) {
        constraint.store = "epic";
    } else if (system.match(/uplay/i)) {
        constraint.store = "uplay";
    } else {
        constraint.os = parseOs(system);
        constraint.store = getStoreConstraintFromPath(path);
    }

    return constraint;
}

function getTagFromTemplate(template: string): Tag | undefined {
    switch (template) {
        case "Game data/saves":
            return "save";
        case "Game data/config":
            return "config";
        default:
            return undefined;
    }
}

function parseOs(os: string): Os {
    switch (os) {
        case "Windows":
            return "windows";
        case "OS X":
            return "mac";
        case "Linux":
            return "linux";
        case "DOS":
            return "dos";
        default:
            throw new UnsupportedOsError(`Unsupported OS: ${os}`);
    }
}

function makeApiClient() {
    return new Wikiapi("https://www.pcgamingwiki.com/w");
}

function saveMissingGames(cache: WikiGameCache, manifest: Manifest): void {
    fs.writeFileSync(
        `${REPO}/data/missing.md`,
        Object.entries(cache)
            .sort((x, y) => x[0].localeCompare(y[0]))
            .filter(([k, _]) => (manifest[k]?.files ?? []).length === 0 && (manifest[k]?.registry ?? []).length === 0)
            .map(([k, v]) => `* [${k}](https://www.pcgamingwiki.com/wiki/?curid=${v.pageId})`)
            .join("\n") + "\n",
    );
}

abstract class YamlFile<T = object> {
    data: T;
    abstract path: string;
    abstract defaultData: T;

    load(): void {
        if (fs.existsSync(this.path)) {
            this.data = yaml.safeLoad(fs.readFileSync(this.path, "utf8"));
        } else {
            this.data = this.defaultData;
        }
    }

    save(): void {
        fs.writeFileSync(
            this.path,
            yaml.safeDump(
                this.data,
                {
                    sortKeys: true,
                    indent: 2,
                    skipInvalid: true,
                    lineWidth: 120,
                }
            )
        );
    }
}

class WikiGameCacheFile extends YamlFile<WikiGameCache> {
    path = `${REPO}/data/wiki-game-cache.yaml`;
    defaultData = {};

    async addNewGames(manifest: Manifest): Promise<void> {
        const wiki = makeApiClient();
        const pages: Array<{ pageid: number, title: string }> = JSON.parse(JSON.stringify(await wiki.categorymembers("Games")));
        for (const page of pages) {
            if (!this.data.hasOwnProperty(page.title)) {
                this.data[page.title] = {
                    pageId: page.pageid,
                    revId: null,
                };
            }
        };
    }
}

class SteamGameCacheFile extends YamlFile<SteamGameCache> {
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

class ManifestFile extends YamlFile<Manifest> {
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
            game: string | undefined,
        },
        limit: number,
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
            if (filter.game === title) {
                check = true;
            }
            if (!check) {
                continue;
            }

            i++;
            if (i > limit) {
                break;
            }

            const game = await getGame(title, wikiCache);
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

/**
 * https://www.pcgamingwiki.com/wiki/Template:Game_data
 */
async function getGame(pageTitle: string, cache: WikiGameCache): Promise<Game> {
    console.log(pageTitle);
    const wiki = makeApiClient();
    const page = await wiki.page(pageTitle, { rvprop: "ids|content" });

    const game: Game = {
        files: {},
        registry: {},
    };
    let unsupportedOs = 0;
    let unsupportedPath = 0;
    page.parse().each("template", template => {
        if (template.name === "Infobox game") {
            const steamId = Number(template.parameters["steam appid"]);
            if (!isNaN(steamId) && steamId > 0) {
                game.steam = { id: steamId };
            }
        } else if (template.name === "Game data/saves" || template.name === "Game data/config") {
            const rawPath = typeof template.parameters[2] === "string" ? template.parameters[2] : template.parameters[2]?.toString();
            if (rawPath === undefined || rawPath.length === 0) {
                return;
            }
            try {
                const [path, pathType] = parsePath(rawPath);
                if (pathType === PathType.FileSystem) {
                    const constraint = getConstraintFromSystem(template.parameters[1], rawPath);

                    if (!game.files.hasOwnProperty(path)) {
                        game.files[path] = {
                            when: [],
                            tags: [],
                        };
                    }

                    if (!game.files[path].when.some(x => x.os === constraint.os && x.store === constraint.store)) {
                        if (constraint.os !== undefined && constraint.store !== undefined) {
                            game.files[path].when.push(constraint);
                        } else if (constraint.os !== undefined) {
                            game.files[path].when.push({ os: constraint.os });
                        } else if (constraint.store !== undefined) {
                            game.files[path].when.push({ store: constraint.store });
                        }
                    }

                    const tag = getTagFromTemplate(template.name);
                    if (tag !== undefined && !game.files[path].tags.includes(tag)) {
                        game.files[path].tags.push(tag);
                    }
                } else if (pathType === PathType.Registry) {
                    if (!game.registry.hasOwnProperty(path)) {
                        game.registry[path] = {
                            when: [],
                            tags: [],
                        };
                    }

                    const store = getStoreConstraintFromPath(rawPath);
                    if (store !== undefined && !game.registry[path].when.some(x => x.store === store)) {
                        game.registry[path].when.push({ store });
                    }

                    const tag = getTagFromTemplate(template.name);
                    if (tag !== undefined && !game.registry[path].tags.includes(tag)) {
                        game.registry[path].tags.push(tag);
                    }
                }
            } catch (e) {
                console.log(`  ${template.toString()}`);
                console.log(`    ${e}`);

                if (e instanceof UnsupportedOsError) {
                    unsupportedOs += 1;
                    return;
                } else if (e instanceof UnsupportedPathError) {
                    unsupportedPath += 1;
                    return;
                } else {
                    return;
                }
            }
        }
    });

    if (Object.keys(game.files).length === 0) {
        delete game.files;
    } else {
        for (const path of Object.keys(game.files)) {
            if (game.files[path].when.length === 0) {
                delete game.files[path].when;
            }
            if (game.files[path].tags.length === 0) {
                delete game.files[path].tags;
            }
        }
    }

    if (Object.keys(game.registry).length === 0) {
        delete game.registry;
    } else {
        for (const path of Object.keys(game.registry)) {
            if (game.registry[path].when.length === 0) {
                delete game.registry[path].when;
            }
            if (game.registry[path].tags.length === 0) {
                delete game.registry[path].tags;
            }
        }
    }

    if (unsupportedOs > 0) {
        cache[pageTitle].unsupportedOs = true;
    } else {
        delete cache[pageTitle].unsupportedOs;
    }

    if (unsupportedPath > 0) {
        cache[pageTitle].unsupportedPath = true;
    } else {
        delete cache[pageTitle].unsupportedPath;
    }

    cache[pageTitle].revId = page.revisions?.[0]?.revid ?? 0;
    return game;
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

async function getSteamClient(): Promise<SteamUser> {
    const client = new SteamUser();
    client.logOn();
    await new Promise(resolve => {
        client.on("loggedOn", () => {
            resolve();
        });
    });
    return client;
}

async function main() {
    const args = minimist<Cli>(process.argv.slice(2));

    const wikiCache = new WikiGameCacheFile();
    wikiCache.load();
    const steamCache = new SteamGameCacheFile(await getSteamClient());
    steamCache.load();
    const manifest = new ManifestFile();
    manifest.load();

    try {
        if (args.cache) {
            await wikiCache.addNewGames(manifest.data);
        }

        if (args.manifest) {
            await manifest.updateGames(
                wikiCache.data,
                {
                    all: args.all ?? false,
                    existing: args.existing ?? false,
                    missing: args.missing ?? false,
                    unchecked: args.unchecked ?? false,
                    unsupportedOs: args.unsupportedOs ?? false,
                    unsupportedPath: args.unsupportedPath ?? false,
                    game: args.game,
                },
                args.limit ?? 25,
                steamCache,
            );
        }

        wikiCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        process.exit(0);
    } catch (e) {
        wikiCache.save();
        steamCache.save();
        manifest.save();
        saveMissingGames(wikiCache.data, manifest.data);
        steamCache.steamClient.logOff();
        throw e;
    }
}

main();
