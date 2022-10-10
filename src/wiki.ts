import { DELAY_BETWEEN_GAMES_MS, REPO, PathType, UnsupportedOsError, UnsupportedPathError, YamlFile } from ".";
import { Constraint, Game, Store, Tag, Os } from "./manifest";
import moment from "moment";
import NodeMw from "nodemw";
import Wikiapi from "wikiapi";
import { parse as parseWiki } from 'wikiparse';

interface Template {
    type: "template",
    name: string,
    parameters: {},
    positionalParameters: Array<Array<WikiNode>>,
};

type WikiNode = string | Template | {
    type: "code" | "pre",
    content: Array<WikiNode>,
    attributes: { [key: string]: string },
} | {
    type: "comment",
    content: Array<WikiNode>,
} | {
    type: "link",
    to: string,
    content: Array<WikiNode>,
} | {
    type: "tag",
    content: Array<WikiNode>,
    attributes: { [key: string]: string },
    name: string,
};

export type WikiGameCache = {
    [title: string]: {
        pageId: number,
        dirty?: boolean,
        renamedFrom?: Array<string>,
        templates?: Array<string>,
        steam?: number,
    };
};

export type WikiMetaCache = {
    lastCheckedRecentChanges: string;
};

export class WikiGameCacheFile extends YamlFile<WikiGameCache> {
    path = `${REPO}/data/wiki-game-cache.yaml`;
    defaultData = {};

    async addNewGames(): Promise<void> {
        const wiki = makeApiClient();
        const pages: Array<{ pageid: number, title: string }> = JSON.parse(JSON.stringify(await wiki.categorymembers("Games")));
        for (const page of pages) {
            if (!this.data.hasOwnProperty(page.title)) {
                let newGame = true;
                for (const [k, v] of Object.entries(this.data)) {
                    if (v.pageId === page.pageid) {
                        newGame = false;
                        this.data[page.title] = v;
                        this.data[page.title].dirty = true;
                        if (!(v.renamedFrom ?? []).includes(k)) {
                            this.data[page.title].renamedFrom = [...(v.renamedFrom ?? []), k];
                        }
                        delete this.data[k];
                        break;
                    }
                }
                if (!newGame) {
                    continue;
                }
                this.data[page.title] = {
                    pageId: page.pageid,
                    dirty: true,
                };
            }
        };
    }

    async refresh(skipUntil: string | undefined, limit: number, all: boolean, games: Array<string>): Promise<void> {
        let i = 0;
        let foundSkipUntil = false;
        const client = makeApiClient();
        for (const pageTitle of Object.keys(this.data).sort()) {
            if (skipUntil && !foundSkipUntil) {
                if (pageTitle === skipUntil) {
                    foundSkipUntil = true;
                } else {
                    continue;
                }
            }
            if (games.length > 0) {
                if (!games.includes(pageTitle)) {
                    continue;
                }
            } else if (!all && !this.data[pageTitle].dirty) {
                continue;
            }

            // console.log(`Refreshing wiki page: ${pageTitle}`);
            await getGame(pageTitle, this.data, client);

            i++;
            if (limit > 0 && i >= limit) {
                break;
            }

            // main() will save at the end, but we do a periodic save as well
            // in case something goes wrong or the script gets cancelled:
            if (i % 250 === 0) {
                this.save();
                console.log("\n:: saved\n");
            }

            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_GAMES_MS));
        }
    }

    async flagRecentChanges(metaCache: WikiMetaCacheFile): Promise<void> {
        const now = moment();
        const changes = await getRecentChanges(now.toDate(), moment(metaCache.data.lastCheckedRecentChanges).subtract(1, "minute").toDate());
        const client = makeApiClient2();

        for (const [recentName, recentInfo] of Object.entries(changes).sort((x, y) => x[0].localeCompare(y[0]))) {
            if (recentInfo.redirect) {
                // This is an entry for the redirect page itself. We can ignore
                // it, and we'll update our data when we get to the entry for
                // the new page name.
                continue;
            } else if (this.data[recentName] !== undefined) {
                // Existing entry has been edited.
                console.log(`[E  ] ${recentName}`);
                this.data[recentName].dirty = true;
            } else {
                // Check for a rename.
                let renamed = false;
                for (const [existingName, existingInfo] of Object.entries(this.data)) {
                    if (existingInfo.pageId === recentInfo.pageId) {
                        // We have a confirmed rename.
                        console.log(`[ M ] ${recentName} <<< ${existingName}`);
                        renamed = true;
                        this.data[recentName] = {
                            ...existingInfo,
                            pageId: recentInfo.pageId,
                            dirty: true,
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
                        this.data[recentName] = { pageId: recentInfo.pageId, dirty: true };
                    }
                }
            }
        }

        metaCache.data.lastCheckedRecentChanges = now.toISOString();
    }
}

export class WikiMetaCacheFile extends YamlFile<WikiMetaCache> {
    path = `${REPO}/data/wiki-meta-cache.yaml`;
    defaultData = {
        lastCheckedRecentChanges: moment().subtract(7, "days").toISOString(),
    };
}

interface RecentChanges {
    [article: string]: {
        pageId: number;
        redirect: boolean;
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
    ubisoftconnect: {
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
        mapped: "WOW6432Node",
        when: { os: "windows" },
        registry: true,
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
    "userprofile\\appdata\\locallow": {
        mapped: "<home>/AppData/LocalLow",
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
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}");
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

    path = path
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/\/(?=$)/g, "")
        .replace(/^~(?=($|\/))/, "<home>")
        .replace(/%userprofile%\/AppData\/Roaming/i, "<winAppData>")
        .replace(/%userprofile%\/AppData\/Local(?!Low)/i, "<winLocalAppData>")
        .replace(/%userprofile%\/Documents/i, "<winDocuments>")
        .replace(/%userprofile%/i, "<home>")
        .replace(/%appdata%/i, "<winAppData>")
        .replace(/%localappdata%/i, "<winLocalAppData>");

    while (path.endsWith("/*")) {
        path = path.slice(0, path.length - 2);
    }

    return [path.trim(), pathType];
}

export function pathIsTooBroad(path: string): boolean {
    if (Object.values(PATH_ARGS).map(x => x.mapped).includes(path)) {
        return true;
    }

    // These paths are present whether or not the game is installed.
    // If possible, they should be narrowed down on the wiki.
    if ([
        "<home>/Documents",
        "<home>/Saved Games",
        "<root>/config",
        "<winDir>/win.ini",
        "<home>/AppData",
        "<home>/AppData/Local",
        "<home>/AppData/Local/Packages",
        "<home>/AppData/LocalLow",
        "<home>/AppData/Roaming",
        "<home>/Documents/My Games",
        "<winDocuments>/My Games",
        "<home>/Library/Application Support",
        "<home>/Library/Preferences",
    ].includes(path)) {
        return true;
    }

    // Drive letters:
    if (path.match(/^[a-zA-Z]:$/)) {
        return true;
    }

    // Root:
    if (path === "/") {
        return true;
    }

    // Relative path wildcard:
    if (path.startsWith("*")) {
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
    } else if (system.match(/origin/i)) {
        constraint.store = "origin";
    } else {
        try {
            constraint.os = parseOs(system);
        } catch { }
    }

    const storeFromPath = getStoreConstraintFromPath(path);
    if (storeFromPath !== undefined) {
        constraint.store = storeFromPath;
    }

    return constraint;
}

function getTagFromTemplate(template: string): Tag | undefined {
    switch (template.toLowerCase()) {
        case "game data/saves":
            return "save";
        case "game data/config":
            return "config";
        default:
            return undefined;
    }
}

function parseOs(os: string): Os {
    // Others seen: "Mac OS", "PC booter", "Amazon Games", "Ubisoft Connect"
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
    return new Wikiapi("https://www.pcgamingwiki.com/w/api.php");
}

// Used for the Recent Changes page and getting a single page's categories.
// Will probably also migrate to this in general.
function makeApiClient2(): any {
    return new NodeMw({
        protocol: "https",
        server: "www.pcgamingwiki.com",
        path: "/w/api.php",
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

export async function getRecentChanges(newest: Date, oldest: Date): Promise<RecentChanges> {
    console.log(`Getting recent changes from ${oldest.toISOString()} to ${newest.toISOString()}`);
    const changes: RecentChanges = {};
    const client = makeApiClient2();
    const startTimestamp = newest.toISOString();
    const endTimestamp = oldest.toISOString();
    let rccontinue: string | undefined = undefined;

    while (true) {
        const params = {
            action: "query",
            list: "recentchanges",
            rcprop: "title|ids|redirect",
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
        const [data, next] = await callMw<{ recentchanges: Array<{ title: string; pageid: number, redirect?: string }> }>(
            client.api, "call", params
        );

        for (const article of data.recentchanges) {
            changes[article.title] = {
                pageId: article.pageid,
                redirect: article.redirect !== undefined,
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
export async function getGame(pageTitle: string, cache: WikiGameCache, client: Wikiapi = null): Promise<string> {
    console.log(`Wiki: ${pageTitle}`);
    const wiki = client === null ? makeApiClient() : client;
    let page = await wiki.page(pageTitle, { rvprop: "ids|content" });
    if (page.missing !== undefined) {
        // Couldn't find it by name, so try again by ID.
        // This can happen for pages moved without leaving a redirect.
        // (If they have a redirect, then the recent changes code takes care of it.)
        const pageId = cache[pageTitle].pageId;
        const client = makeApiClient2();
        const params = {
            action: "query",
            pageids: [pageId],
        };
        try {
            const [data, _] = await callMw<{ pages: { [id: string]: { title: string } } }>(
                client.api, "call", params
            );
            const newTitle = data.pages[pageId.toString()].title;
            if (newTitle === undefined) {
                // This happened once intermittently; the cause is unclear.
                throw new Error("Unable to retrieve page by ID");
            }
            console.log(`:: getGame: page ${pageId} called '${pageTitle}' renamed to '${newTitle}'`);
            cache[newTitle] = cache[pageTitle];
            delete cache[pageTitle];
            if (cache[newTitle].renamedFrom === undefined) {
                cache[newTitle].renamedFrom = [pageTitle];
            } else {
                cache[newTitle].renamedFrom.push(pageTitle);
            }
            page = await wiki.page(newTitle, { rvprop: "ids|content" });
            pageTitle = newTitle;
        } catch {
            console.log(`:: page ${pageId} called '${pageTitle}' no longer exists`);
        }
    }

    delete cache[pageTitle].templates;
    page.parse().each("template", template => {
        const templateName = template.name.toLowerCase();
        if (templateName === "infobox game") {
            const steamId = Number(template.parameters["steam appid"]);
            if (!isNaN(steamId) && steamId > 0) {
                cache[pageTitle].steam = steamId;
            }
        } else if (templateName === "game data/saves" || templateName === "game data/config") {
            const reparsed = parseWiki(template.toString());
            if (reparsed[0].positionalParameters[1]?.length > 0 ?? false) {
                if (cache[pageTitle].templates === undefined) {
                    cache[pageTitle].templates = [];
                }
                cache[pageTitle].templates.push(template.toString());
            }
        }
    });

    delete cache[pageTitle].dirty;
    return pageTitle;
}

function flattenParameter(nodes: Array<WikiNode>): [string, boolean] {
    let composite = "";
    let regular = true;

    for (const node of nodes) {
        if (typeof node === "string") {
            composite += node;
        } else switch (node.type) {
            case "code":
            case "pre":
                composite += "*";
                break;
            case "template":
                switch (node.name.toLowerCase()) {
                    case "p":
                    case "path":
                        const [flatP, regularP] = flattenParameter(node.positionalParameters[0]);
                        if (!regularP) {
                            regular = false;
                        }
                        composite += `{{${node.name}|${flatP}}}`;
                        break;
                    case "code":
                    case "file":
                        composite += "*";
                        break;
                    case "localizedpath":
                        const [flatC, regularC] = flattenParameter(node.positionalParameters[0]);
                        if (!regularC) {
                            regular = false;
                        }
                        composite += flatC;
                        break;
                    default:
                        break;
                }
                break;
            case "comment":
                break;
            case "tag":
                const [flatT, regularT] = flattenParameter(node.content);
                if (!regularT) {
                    regular = false;
                }
                if (flatT.includes("/") || flatT.includes("\\")) {
                    // This is probably an unclosed tag with more path content after it,
                    // like `.../<game.version>/...`.
                    composite += `*/${flatT}`;
                } else if (flatT.length > 0) {
                    // This is probably a closed tag, like `.../<sup>user ID</sup>/...`.
                    composite += "*";
                }
                break;
            default:
                regular = false;
                break;
        }
    }

    return [composite.trim(), regular];
}

export function parseTemplates(templates: Array<string>): Pick<Game, "files" | "registry"> {
    const game: Pick<Game, "files" | "registry"> = { files: {}, registry: {} };

    for (const template of templates.flatMap(parseWiki) as Array<Template>) {
        if (template.type !== "template") {
            console.log(`WARNING: unknown template type '${template.type}' from: '${JSON.stringify(template)}'`);
            continue;
        }
        if (template.positionalParameters.length < 2) {
            continue;
        }

        const [system, _] = flattenParameter(template.positionalParameters[0]);

        for (const [rawPath, regular] of template.positionalParameters.slice(1).map(flattenParameter)) {
            if (rawPath.length === 0 || !regular) {
                // console.log(`IRREGULAR: ${rawPath}`);
                continue;
            }

            const [path, pathType] = parsePath(rawPath);
            if (pathIsTooBroad(path)) {
                continue;
            }

            if (pathType === PathType.FileSystem) {
                const constraint = getConstraintFromSystem(system, rawPath);

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
        }
    }

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

    return game;
}
