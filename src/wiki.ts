import { DELAY_BETWEEN_GAMES_MS, REPO, PathType, UnsupportedOsError, UnsupportedPathError, YamlFile } from ".";
import { Constraint, Game, Store, Tag, Os } from "./manifest";
import * as moment from "moment";
import * as NodeMw from "nodemw";
import * as Wikiapi from "wikiapi";
import { parse as parseWiki } from 'wikiparse';

type Template = {
    type: "template",
    name: string,
    parameters: {},
    positionalParameters: Array<Template | string>,
};

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
        templates?: Array<string>,
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
                        this.data[page.title].recentlyChanged = true;
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
                    revId: null,
                };
            }
        };
    }

    async refresh(skipUntil: string | undefined, limit: number): Promise<void> {
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

            // console.log(`Refreshing wiki page ${pageTitle}`);
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

interface PathCell {
    [index: number]: string | PathCell;
    type: "comment" | "transclusion" | "page_title" | "plain" | "tag";
    parameters: { [key: string]: any }; // keys are numbers as strings
    tag?: string, // when type=tag
    toString(): string;
}

function stringifyTransclusionCell(cell: PathCell): [string, boolean] {
    const templateName = cell[0] as string;
    switch (templateName.toLowerCase()) {
        case "p":
        case "path":
            return [`{{${templateName}|${cell[1]}}}`, true];
        case "code":
        case "file":
            return ["*", false];
        case "localizedpath":
            return [cell[1] as string, false];
        default:
            return ["", false];
    }
}

function stringifyTagCell(cell: PathCell): [string, boolean] {
    if (cell.tag === undefined) {
        return ["", false];
    }
    switch (cell.tag.toLowerCase()) {
        case "code":
            return ["*", false];
        default:
            return ["", false];
    }
}

function getRawPathFromCell(cell: string | PathCell): [string, boolean] {
    let composite = "";
    let regular = true;

    if (typeof cell === "string") {
        if (/<br\s*\/?>/.test(cell)) {
            regular = false;
        }
        composite += cell;
    } else if (cell.type === "transclusion") {
        const [stringified, segmentRegular] = stringifyTransclusionCell(cell);
        if (!segmentRegular) {
            regular = false;
        }
        composite += stringified;
    } else if (cell.type === "tag") {
        const [stringified, segmentRegular] = stringifyTagCell(cell);
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
            const [stringified, segmentRegular] = getRawPathFromCell(segment);
            if (!segmentRegular) {
                regular = false;
            }
            composite += stringified;
        }
    } else if (cell.type !== "comment" && cell.type !== "page_title") {
        regular = false;
    }

    return [composite.trim(), regular];
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
        constraint.os = parseOs(system);
    }

    const storeFromPath = getStoreConstraintFromPath(path);
    if (storeFromPath !== undefined) {
        constraint.store = storeFromPath;
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
    return new Wikiapi("https://www.pcgamingwiki.com/w/api.php");
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

export async function getRecentChanges(newest: Date, oldest: Date): Promise<RecentChanges> {
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
export async function getGame(pageTitle: string, cache: WikiGameCache, client: Wikiapi = null): Promise<[string, Game]> {
    console.log(pageTitle);
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

    const game: Game = {
        files: {},
        registry: {},
    };
    let unsupportedOs = 0;
    let unsupportedPath = 0;
    let tooBroad = 0;
    let irregularPath = 0;
    delete cache[pageTitle].templates;
    page.parse().each("template", template => {
        if (template.name === "Infobox game") {
            const steamId = Number(template.parameters["steam appid"]);
            if (!isNaN(steamId) && steamId > 0) {
                game.steam = { id: steamId };
            }
        } else if (template.name === "Game data/saves" || template.name === "Game data/config") {
            const reparsed = parseWiki(template.toString());
            if (reparsed[0].positionalParameters[1]?.length > 0 ?? false) {
                if (cache[pageTitle].templates === undefined) {
                    cache[pageTitle].templates = [];
                }
                cache[pageTitle].templates.push(template.toString());
            }

            // console.log("\n\n\n\n\n\n--------------------------------------------------------------------------")
            // console.log(template);
            for (const cellKey of Object.getOwnPropertyNames(template.parameters)) {
                if (cellKey === "0" || cellKey === "1") {
                    continue;
                }
                const cell = template.parameters[cellKey];
                // console.log("======================================")
                // console.log(cell)
                const [rawPath, regular] = getRawPathFromCell(cell);
                // console.log("-----------------");
                // console.log(`${regular} :  ${rawPath}`);

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
    return [pageTitle, game];
}
