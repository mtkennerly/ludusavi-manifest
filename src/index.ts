import * as pathMod from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";

export const REPO = pathMod.dirname(__dirname);
export const DELAY_BETWEEN_GAMES_MS = 250;

export class UnsupportedError extends Error {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class UnsupportedOsError extends UnsupportedError {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class UnsupportedPathError extends UnsupportedError {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export enum PathType {
    FileSystem,
    Registry,
}

export abstract class YamlFile<T = object> {
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
