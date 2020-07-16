import { REPO, PathType, UnsupportedOsError, UnsupportedPathError, YamlFile } from ".";
import { Constraint, Game, Store, Tag, Os } from "./manifest";
import * as Wikiapi from "wikiapi";
import * as NodeMw from "nodemw";

export type WikiGameCache = {
    [title: string]: {
        pageId: number,
        revId: number | null,
        /** Whether an entry on the page failed because of an unsupported OS. */
        unsupportedOs?: boolean,
        /** Whether an entry on the page failed because of an unsupported Path template argument. */
        unsupportedPath?: boolean,
        /** Whether an entry has a path that is too broad (e.g., the entirety of %WINDIR%). */
        tooBroad?: boolean,
        recentlyChanged?: boolean,
        renamedFrom?: Array<string>,
        irregularPath?: boolean,
    };
};

export class WikiGameCacheFile extends YamlFile<WikiGameCache> {
    path = `${REPO}/data/wiki-game-cache.yaml`;
    defaultData = {};

    async addNewGames(): Promise<void> {
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

    async flagRecentChanges(days: number): Promise<void> {
        const changes = await getRecentChanges(days);
        const client = makeApiClient2();
        for (const [recentName, recentInfo] of Object.entries(changes).sort((x, y) => x[0].localeCompare(y[0]))) {
            if (this.data[recentName] !== undefined) {
                // Existing entry has been edited.
                console.log(`[E  ] ${recentName}`);
                this.data[recentName].recentlyChanged = true;
            } else {
                // Check for a rename.
                let renamed = false;
                for (const [existingName, existingInfo] of Object.entries(this.data)) {
                    if (existingInfo.pageId === recentInfo.pageId) {
                        // We have a confirmed rename.
                        console.log(`[ M ] ${recentName} <<< ${existingName}`);
                        renamed = true;
                        this.data[recentName] = {
                            pageId: recentInfo.pageId,
                            revId: existingInfo.revId,
                            recentlyChanged: true,
                            renamedFrom: [...(existingInfo.renamedFrom ?? []), existingName]
                        };
                        delete this.data[existingName];
                        break;
                    }
                }
                if (!renamed) {
                    // Brand new page.
                    const [data, _] = await callMw<Array<string>>(client, "getArticleCategories", recentName);
                    if (data.includes("Category:Games")) {
                        // It's a game, so add it to the cache.
                        console.log(`[  C] ${recentName}`);
                        this.data[recentName] = { pageId: recentInfo.pageId, revId: 0, recentlyChanged: true };
                    }
                }
            }
        }
    }
}

interface RecentChanges {
    [article: string]: {
        pageId: number;
    };
}

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

function makePathArgRegex(arg: string): RegExp {
    const escaped = `{{P(ath)?|${arg}}}`
        .replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("{", "\\{")
        .replace("}", "\\}");
    return new RegExp(escaped, "gi");
}

interface PathCell {
    [index: number]: string | PathCell;
    type: "comment" | "transclusion" | "page_title" | "plain";
    parameters: { [key: string]: any }; // keys are numbers as strings
    toString(): string;
}

function stringifyTransclusionSegment(segment: PathCell): [string, boolean] {
    const templateName = segment[0][0] as string;
    switch (templateName.toLowerCase()) {
        case "p":
        case "path":
            return [`{{${templateName}|${segment[1]}}}`, true];
        case "code":
        case "file":
            return ["*", false];
        case "localizedpath":
            return [segment[1] as string, false];
        default:
            return ["", false];
    }
}

function getRawPathFromCell(cell: string | PathCell): [string, boolean] {
    let composite = "";
    let regular = true;

    if (typeof cell === "string") {
        composite += cell;
    } else if (cell.type === "transclusion") {
        const [stringified, segmentRegular] = stringifyTransclusionSegment(cell);
        if (!segmentRegular) {
            regular = false;
        }
        composite += stringified;
    } else if (cell.type === "plain") {
        for (let i = 0; i < 50; i++) {
            const segment = cell[i];
            if (segment === undefined) {
                break;
            }
            if (typeof segment === "string") {
                composite += segment;
            } else if (segment.type === "transclusion") {
                const [stringified, segmentRegular] = stringifyTransclusionSegment(segment);
                if (!segmentRegular) {
                    regular = false;
                }
                composite += stringified;
            }
        }
    }

    return [composite.replace(/<ref>.*?<\ref>/, "").trim(), regular];
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

export function pathIsTooBroad(path: string): boolean {
    if (Object.values(PATH_ARGS).map(x => x.mapped).includes(path)) {
        return true;
    }

    // TODO: These paths are present whether or not the game is installed.
    // If possible, they should be narrowed down on the wiki.
    if ([
        "<home>/Documents",
        "<home>/Saved Games",
        "<root>/config",
        "<winDir>/win.ini",
    ].includes(path)) {
        return true;
    }

    return false;
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
    } else if (system.match(/epic games/i)) {
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

// Used for most functionality, but it seems like a less active project
// and it's hard to figure out what functionality is available,
// so we'll probably migrate to nodemw.
function makeApiClient() {
    return new Wikiapi("https://www.pcgamingwiki.com/w");
}

// Used for the Recent Changes page and getting a single page's categories.
// Will probably also migrate to this in general.
function makeApiClient2(): any {
    return new NodeMw({
        protocol: "https",
        server: "www.pcgamingwiki.com",
        path: "/w",
        debug: false,
        userAgent: "ludusavi-manifest-importer/0.0.0",
        concurrency: 1,
    });
}

// Promise wrapper for nodemw.
function callMw<T = any>(client, method: string, ...args: Array<any>): Promise<[T, any]> {
    return new Promise((resolve, reject) => {
        client[method](...args, (err: any, data: T, next: any) => {
            if (err) {
                reject(err);
            } else {
                resolve([data, next]);
            }
        });
    });
}

export async function getRecentChanges(days: number): Promise<RecentChanges> {
    const changes: RecentChanges = {};
    const client = makeApiClient2();
    const startTimestamp = new Date().toISOString();
    const endTimestamp = new Date(new Date().setDate(new Date().getDate() - days)).toISOString();
    let rccontinue: string | undefined = undefined;

    while (true) {
        const params = {
            action: "query",
            list: "recentchanges",
            rcprop: "title|ids",
            rcstart: startTimestamp,
            rcend: endTimestamp,
            rclimit: 500,
            rcnamespace: 0,
            rctype: "edit|new",
            rccontinue,
        };
        if (params.rccontinue === undefined) {
            delete params.rccontinue;
        }
        const [data, next] = await callMw<{ recentchanges: Array<{ title: string; pageid: number }> }>(
            client.api, "call", params
        );

        for (const article of data.recentchanges) {
            changes[article.title] = {
                pageId: article.pageid,
            };
        }

        if (next) {
            rccontinue = next.rccontinue;
        } else {
            break;
        }
    }

    return changes;
}

/**
 * https://www.pcgamingwiki.com/wiki/Template:Game_data
 */
export async function getGame(pageTitle: string, cache: WikiGameCache): Promise<Game> {
    console.log(pageTitle);
    const wiki = makeApiClient();
    const page = await wiki.page(pageTitle, { rvprop: "ids|content" });

    const game: Game = {
        files: {},
        registry: {},
    };
    let unsupportedOs = 0;
    let unsupportedPath = 0;
    let tooBroad = 0;
    let irregularPath = 0;
    page.parse().each("template", template => {
        if (template.name === "Infobox game") {
            const steamId = Number(template.parameters["steam appid"]);
            if (!isNaN(steamId) && steamId > 0) {
                game.steam = { id: steamId };
            }
        } else if (template.name === "Game data/saves" || template.name === "Game data/config") {
            for (const cellKey of Object.getOwnPropertyNames(template.parameters)) {
                if (cellKey === "0" || cellKey === "1") {
                    continue;
                }
                const cell = template.parameters[cellKey];
                const [rawPath, regular] = getRawPathFromCell(cell);

                if (!regular) {
                    irregularPath += 1;
                }

                if (rawPath.length === 0) {
                    continue;
                }

                try {
                    const [path, pathType] = parsePath(rawPath);
                    if (pathIsTooBroad(path)) {
                        tooBroad += 1;
                        continue;
                    }
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
                        continue;
                    } else if (e instanceof UnsupportedPathError) {
                        unsupportedPath += 1;
                        continue;
                    } else {
                        continue;
                    }
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

    if (tooBroad > 0) {
        cache[pageTitle].tooBroad = true;
    } else {
        delete cache[pageTitle].tooBroad;
    }

    if (irregularPath > 0) {
        cache[pageTitle].irregularPath = true;
    } else {
        delete cache[pageTitle].irregularPath;
    }

    cache[pageTitle].revId = page.revisions?.[0]?.revid ?? 0;
    return game;
}
