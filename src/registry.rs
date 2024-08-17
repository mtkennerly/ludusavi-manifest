use once_cell::sync::Lazy;
use regex::Regex;

pub fn normalize(path: &str) -> String {
    let mut path = path.trim().trim_end_matches(['/', '\\']).replace('\\', "/");

    static CONSECUTIVE_SLASHES: Lazy<Regex> = Lazy::new(|| Regex::new(r"/{2,}").unwrap());
    static UNNECESSARY_DOUBLE_STAR_1: Lazy<Regex> = Lazy::new(|| Regex::new(r"([^/*])\*{2,}").unwrap());
    static UNNECESSARY_DOUBLE_STAR_2: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*{2,}([^/*])").unwrap());
    static ENDING_WILDCARD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(/\*)+$").unwrap());
    static ENDING_DOT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(/\.)$").unwrap());
    static INTERMEDIATE_DOT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(/\./)").unwrap());

    for (pattern, replacement) in [
        (&CONSECUTIVE_SLASHES, "/"),
        (&UNNECESSARY_DOUBLE_STAR_1, "${1}*"),
        (&UNNECESSARY_DOUBLE_STAR_2, "*${1}"),
        (&ENDING_WILDCARD, ""),
        (&ENDING_DOT, ""),
        (&INTERMEDIATE_DOT, "/"),
    ] {
        path = pattern.replace_all(&path, replacement).to_string();
    }

    path
}

fn too_broad(path: &str) -> bool {
    let path = path.to_lowercase();

    let valid = &["hkey_current_user", "hkey_local_machine"];
    if !valid.iter().any(|x| path.starts_with(x)) {
        return true;
    }

    for item in [
        "hkey_current_user",
        "hkey_current_user/software",
        "hkey_current_user/software/wow6432node",
        "hkey_local_machine",
        "hkey_local_machine/software",
        "hkey_local_machine/software/wow6432node",
    ] {
        if path == item {
            return true;
        }
    }

    false
}

pub fn usable(path: &str) -> bool {
    static UNPRINTABLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\p{Cc}|\p{Cf})").unwrap());

    !path.is_empty() && !path.contains("{{") && !too_broad(path) && !UNPRINTABLE.is_match(path)
}
